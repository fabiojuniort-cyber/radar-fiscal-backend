import type {
  Pool,
  PoolClient,
} from 'pg';

import {
  canonicalJson,
  sha256Hex,
} from '../baseline/baseline.canonical-json.js';
import {
  evaluateTaxonomyCriteria,
  parseTaxonomyMonitoringCriteria,
  type TaxonomyMonitoringCriteria,
} from './taxonomy-criteria.js';

export const TAXONOMY_MATCH_ENGINE_VERSION =
  'taxonomy-match-v1';

export type TaxonomyMatchDisposition =
  | 'MATCHED_CREATED'
  | 'MATCHED_EXISTING'
  | 'NO_MATCH'
  | 'SKIPPED_PROFILE_INACTIVE'
  | 'SKIPPED_NO_TAXONOMY_CRITERIA'
  | 'SKIPPED_PUBLICATION_OUT_OF_SCOPE'
  | 'NO_PUBLISHED_RELEASE';

export interface TaxonomyMatchResult {
  disposition:
    TaxonomyMatchDisposition;
  taxonomyReleaseId?: string;
  taxonomyReleaseVersion?: string;
  companyPublicationId?: string;
  publicationMatchId?: string;
  matchedCriteriaCodes: string[];
  matchedAssertionCodes: string[];
  classificationRunIds: string[];
}

interface ReleaseConceptRow {
  release_concept_id: string;
  code: string;
}

interface NarrowerEdgeRow {
  child_id: string;
  parent_id: string;
}

function buildAcceptedCodes(
  criteria: TaxonomyMonitoringCriteria,
  concepts: readonly ReleaseConceptRow[],
  edges: readonly NarrowerEdgeRow[],
): Map<string, ReadonlySet<string>> {
  const byCode = new Map(
    concepts.map((row) => [
      row.code,
      row.release_concept_id,
    ]),
  );
  const codeById = new Map(
    concepts.map((row) => [
      row.release_concept_id,
      row.code,
    ]),
  );
  const children = new Map<
    string,
    string[]
  >();

  for (const edge of edges) {
    const bucket =
      children.get(edge.parent_id) ??
      [];
    bucket.push(edge.child_id);
    children.set(
      edge.parent_id,
      bucket,
    );
  }

  const criteriaCodes = [
    ...new Set([
      ...criteria.anyOf,
      ...criteria.allOf,
      ...criteria.noneOf,
    ]),
  ];

  const result =
    new Map<
      string,
      ReadonlySet<string>
    >();

  for (const code of criteriaCodes) {
    const root = byCode.get(code);

    if (!root) {
      throw new Error(
        'TAXONOMY_CRITERIA_CODE_NOT_IN_CURRENT_RELEASE:' +
          code,
      );
    }

    const accepted =
      new Set<string>([code]);

    if (criteria.includeDescendants) {
      const queue = [root];
      const visited =
        new Set<string>();

      while (queue.length > 0) {
        const current =
          queue.shift();

        if (
          !current ||
          visited.has(current)
        ) {
          continue;
        }

        visited.add(current);

        for (
          const child of
          children.get(current) ?? []
        ) {
          const childCode =
            codeById.get(child);

          if (childCode) {
            accepted.add(childCode);
          }

          queue.push(child);
        }
      }
    }

    result.set(code, accepted);
  }

  return result;
}

async function setTenantContext(
  client: PoolClient,
  tenantId: string,
): Promise<void> {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true)",
    [tenantId],
  );
}

export async function matchPublicationByTaxonomy(
  pool: Pool,
  input: {
    tenantId: string;
    monitoringProfileId: string;
    publicationVersionId: string;
  },
): Promise<TaxonomyMatchResult> {
  const client =
    await pool.connect();

  try {
    await client.query('BEGIN');
    await setTenantContext(
      client,
      input.tenantId,
    );

    const profile =
      await client.query<{
        company_id: string;
        profile_version: number;
        criteria_schema_version: number;
        criteria: unknown;
        is_active: boolean;
      }>(
        [
          'SELECT company_id, profile_version,',
          'criteria_schema_version, criteria, is_active',
          'FROM monitoring_profiles',
          'WHERE id = $1',
        ].join(' '),
        [input.monitoringProfileId],
      );

    const profileRow =
      profile.rows[0];

    if (!profileRow) {
      throw new Error(
        'MONITORING_PROFILE_NOT_FOUND_IN_TENANT',
      );
    }

    if (!profileRow.is_active) {
      await client.query('ROLLBACK');
      return {
        disposition:
          'SKIPPED_PROFILE_INACTIVE',
        matchedCriteriaCodes: [],
        matchedAssertionCodes: [],
        classificationRunIds: [],
      };
    }

    const criteria =
      parseTaxonomyMonitoringCriteria(
        profileRow.criteria,
        profileRow.criteria_schema_version,
      );

    if (!criteria) {
      await client.query('ROLLBACK');
      return {
        disposition:
          'SKIPPED_NO_TAXONOMY_CRITERIA',
        matchedCriteriaCodes: [],
        matchedAssertionCodes: [],
        classificationRunIds: [],
      };
    }

    // Concurrency boundary with SUPPRESS/RESTORE. Use two statements so the
    // scope check receives a fresh READ COMMITTED snapshot after waiting for
    // a competing publication row lock.
    const publication =
      await client.query<{
        publication_id: string;
      }>(
        [
          'SELECT p.id AS publication_id',
          'FROM publication_versions pv',
          'JOIN publications p ON p.id = pv.publication_id',
          'WHERE pv.id = $1',
          'FOR SHARE OF p',
        ].join(' '),
        [input.publicationVersionId],
      );

    const publicationId =
      publication.rows[0]
        ?.publication_id;

    if (!publicationId) {
      throw new Error(
        'PUBLICATION_VERSION_NOT_FOUND',
      );
    }

    const scope = await client.query<{
      in_scope: boolean;
    }>(
      'SELECT public.publication_scope_is_in_scope($1::uuid) AS in_scope',
      [publicationId],
    );

    if (scope.rows[0]?.in_scope !== true) {
      await client.query('ROLLBACK');
      return {
        disposition:
          'SKIPPED_PUBLICATION_OUT_OF_SCOPE',
        matchedCriteriaCodes: [],
        matchedAssertionCodes: [],
        classificationRunIds: [],
      };
    }

    const release =
      await client.query<{
        id: string;
        version: string;
      }>(
        [
          'SELECT id, version',
          'FROM taxonomy_releases',
          "WHERE status = 'PUBLISHED'",
          'ORDER BY version_major DESC, version_minor DESC, version_patch DESC',
          'LIMIT 1',
        ].join(' '),
      );

    const releaseRow =
      release.rows[0];

    if (!releaseRow) {
      await client.query('ROLLBACK');
      return {
        disposition:
          'NO_PUBLISHED_RELEASE',
        matchedCriteriaCodes: [],
        matchedAssertionCodes: [],
        classificationRunIds: [],
      };
    }

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [
        [
          'taxonomy-match-v1',
          input.tenantId,
          input.monitoringProfileId,
          input.publicationVersionId,
          releaseRow.id,
        ].join(':'),
      ],
    );

    const concepts =
      await client.query<ReleaseConceptRow>(
        [
          'SELECT rc.id AS release_concept_id, c.code',
          'FROM taxonomy_release_concepts rc',
          'JOIN taxonomy_concepts c ON c.id = rc.concept_id',
          'WHERE rc.release_id = $1',
          "AND rc.membership_status = 'INCLUDED'",
        ].join(' '),
        [releaseRow.id],
      );

    const edges =
      criteria.includeDescendants
        ? await client.query<NarrowerEdgeRow>(
            [
              'SELECT rel.source_release_concept_id AS child_id,',
              'rel.target_release_concept_id AS parent_id',
              'FROM taxonomy_concept_relations rel',
              'JOIN taxonomy_relation_types rt ON rt.id = rel.relation_type_id',
              'WHERE rel.release_id = $1',
              "AND rel.status = 'APPROVED'",
              "AND rt.code = 'narrower_than'",
            ].join(' '),
            [releaseRow.id],
          )
        : { rows: [] };

    const acceptedCodes =
      buildAcceptedCodes(
        criteria,
        concepts.rows,
        edges.rows,
      );

    const assertions =
      await client.query<{
        code: string;
        run_id: string;
      }>(
        [
          'SELECT DISTINCT c.code, e.run_id',
          'FROM v_publication_taxonomy_effective_assertions e',
          'JOIN taxonomy_release_concepts rc',
          'ON rc.id = e.release_concept_id',
          'AND rc.release_id = e.taxonomy_release_id',
          'JOIN taxonomy_concepts c ON c.id = rc.concept_id',
          'WHERE e.publication_version_id = $1',
          'AND e.taxonomy_release_id = $2',
        ].join(' '),
        [
          input.publicationVersionId,
          releaseRow.id,
        ],
      );

    const assertedCodes =
      new Set(
        assertions.rows.map(
          (row) => row.code,
        ),
      );

    const evaluation =
      evaluateTaxonomyCriteria(
        criteria,
        assertedCodes,
        acceptedCodes,
      );

    const classificationRunIds = [
      ...new Set(
        assertions.rows
          .filter((row) =>
            evaluation
              .matchedAssertionCodes
              .includes(row.code),
          )
          .map((row) => row.run_id),
      ),
    ].sort();

    if (!evaluation.matched) {
      await client.query('ROLLBACK');
      return {
        disposition: 'NO_MATCH',
        taxonomyReleaseId:
          releaseRow.id,
        taxonomyReleaseVersion:
          releaseRow.version,
        matchedCriteriaCodes:
          evaluation
            .matchedCriteriaCodes,
        matchedAssertionCodes:
          evaluation
            .matchedAssertionCodes,
        classificationRunIds,
      };
    }

    const companyPublication =
      await client.query<{
        id: string;
      }>(
        [
          'INSERT INTO company_publications (',
          'company_id, publication_id',
          ') VALUES ($1,$2)',
          'ON CONFLICT (company_id, publication_id)',
          'DO UPDATE SET',
          'last_matched_at = now(),',
          'updated_at = now()',
          'RETURNING id',
        ].join(' '),
        [
          profileRow.company_id,
          publicationId,
        ],
      );

    const companyPublicationId =
      companyPublication.rows[0]?.id;

    if (!companyPublicationId) {
      throw new Error(
        'COMPANY_PUBLICATION_UPSERT_FAILED',
      );
    }

    const evidence = {
      publicationVersionId:
        input.publicationVersionId,
      taxonomyReleaseId:
        releaseRow.id,
      taxonomyReleaseVersion:
        releaseRow.version,
      classificationRunId:
        classificationRunIds[0] ??
        null,
      classificationRunIds,
      matchedCriteriaCodes:
        evaluation
          .matchedCriteriaCodes,
      matchedAssertionCodes:
        evaluation
          .matchedAssertionCodes,
      includeDescendants:
        criteria.includeDescendants,
      releasePolicy:
        criteria.releasePolicy,
      ruleEngineVersion:
        TAXONOMY_MATCH_ENGINE_VERSION,
    };

    const materialHash =
      sha256Hex(
        canonicalJson(evidence),
      );

    const matchedFields = {
      ...evidence,
      materialHash,
    };

    const existing =
      await client.query<{
        id: string;
      }>(
        [
          'SELECT id',
          'FROM publication_matches',
          'WHERE company_publication_id = $1',
          'AND monitoring_profile_id = $2',
          'AND profile_version = $3',
          'AND rule_engine_version = $4',
          "AND matched_fields->>'materialHash' = $5",
          'ORDER BY created_at DESC',
          'LIMIT 1',
        ].join(' '),
        [
          companyPublicationId,
          input.monitoringProfileId,
          profileRow.profile_version,
          TAXONOMY_MATCH_ENGINE_VERSION,
          materialHash,
        ],
      );

    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        disposition:
          'MATCHED_EXISTING',
        taxonomyReleaseId:
          releaseRow.id,
        taxonomyReleaseVersion:
          releaseRow.version,
        companyPublicationId,
        publicationMatchId:
          existing.rows[0].id,
        matchedCriteriaCodes:
          evaluation
            .matchedCriteriaCodes,
        matchedAssertionCodes:
          evaluation
            .matchedAssertionCodes,
        classificationRunIds,
      };
    }

    const inserted =
      await client.query<{
        id: string;
      }>(
        [
          'INSERT INTO publication_matches (',
          'company_publication_id, monitoring_profile_id, profile_version,',
          'rule_engine_version, matched_fields',
          ') VALUES ($1,$2,$3,$4,$5::jsonb)',
          'RETURNING id',
        ].join(' '),
        [
          companyPublicationId,
          input.monitoringProfileId,
          profileRow.profile_version,
          TAXONOMY_MATCH_ENGINE_VERSION,
          JSON.stringify(
            matchedFields,
          ),
        ],
      );

    const publicationMatchId =
      inserted.rows[0]?.id;

    if (!publicationMatchId) {
      throw new Error(
        'PUBLICATION_MATCH_INSERT_FAILED',
      );
    }

    await client.query('COMMIT');

    return {
      disposition:
        'MATCHED_CREATED',
      taxonomyReleaseId:
        releaseRow.id,
      taxonomyReleaseVersion:
        releaseRow.version,
      companyPublicationId,
      publicationMatchId,
      matchedCriteriaCodes:
        evaluation.matchedCriteriaCodes,
      matchedAssertionCodes:
        evaluation.matchedAssertionCodes,
      classificationRunIds,
    };
  } catch (error) {
    await client
      .query('ROLLBACK')
      .catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
