import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { canonicalJson } from '../baseline/baseline.canonical-json.js';
import {
  REQUIRED_PRESERVED_DIMENSION_CODES,
  RETIRED_DIMENSION_CODES,
  TAXONOMY_V1_1_VERSION,
  planTaxonomyV11FromCanonicalV1,
  planTaxonomyV11Successor,
  type TaxonomyV11Plan,
} from './taxonomy-successor-v1-1.js';

export const TAXONOMY_V1_SOURCE_VERSION = 'v1.0.0' as const;
export const TAXONOMY_V1_1_POLICY_VERSION =
  'taxonomy-v1.1-retire-dimensions/v1' as const;

const RETIRED_CODES = [...RETIRED_DIMENSION_CODES];
const PRESERVED_CODES = [...REQUIRED_PRESERVED_DIMENSION_CODES];

interface ReleaseRow {
  id: string;
  version: string;
  status: string;
  previous_release_id: string | null;
  manifest: Record<string, unknown>;
}

export interface TaxonomyV11CopyCounts {
  aliasBindings: number;
  relationRules: number;
  relations: number;
  officialMappings: number;
  aliasEvidence: number;
  relationEvidence: number;
  mappingEvidence: number;
}

export interface TaxonomyV11TargetSnapshot {
  releaseId: string;
  status: string;
  previousReleaseId: string | null;
  dimensions: number;
  concepts: number;
  aliasBindings: number;
  relationRules: number;
  relations: number;
  officialMappings: number;
  aliasEvidence: number;
  relationEvidence: number;
  mappingEvidence: number;
  retiredDimensionsPresent: number;
  retiredConceptsPresent: number;
  preservedDimensionCodes: string[];
  manifest: Record<string, unknown>;
}

export type TaxonomyV11DryRunAction =
  | 'CREATE_DRAFT'
  | 'VALIDATE_EXISTING_DRAFT'
  | 'ALREADY_PUBLISHED'
  | 'BLOCKED';

export interface TaxonomyV11DryRunReport {
  sourceReleaseId: string | null;
  sourceStatus: string | null;
  latestPublishedVersion: string | null;
  targetReleaseId: string | null;
  targetStatus: string | null;
  action: TaxonomyV11DryRunAction;
  plan: TaxonomyV11Plan | null;
  expectedCanonicalPlan: TaxonomyV11Plan;
  copyable: TaxonomyV11CopyCounts | null;
  targetSnapshot: TaxonomyV11TargetSnapshot | null;
  blockers: string[];
  warnings: string[];
}

export interface CreateTaxonomyV11Result {
  disposition:
    | 'CREATED_DRAFT'
    | 'IDEMPOTENT_DRAFT'
    | 'ALREADY_PUBLISHED';
  releaseId: string;
  snapshot: TaxonomyV11TargetSnapshot;
}

export interface PublishTaxonomyV11Options {
  artifactRepository: string;
  artifactPath: string;
  artifactGitSha: string;
  artifactSha256: string;
  actor?: string;
}

export interface PublishTaxonomyV11Result {
  disposition: 'PUBLISHED' | 'ALREADY_PUBLISHED';
  releaseId: string;
  snapshot: TaxonomyV11TargetSnapshot;
}

function successorLockKey(): string {
  const digest = createHash('sha256')
    .update(`tribusca:taxonomy-successor:${TAXONOMY_V1_1_VERSION}`, 'utf8')
    .digest();

  return digest.readBigInt64BE(0).toString();
}

async function acquireSuccessorLock(client: PoolClient): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired',
    [successorLockKey()],
  );

  if (!result.rows[0]?.acquired) {
    throw new Error('TAXONOMY_V1_1_OPERATION_IN_PROGRESS');
  }
}

async function findRelease(
  client: PoolClient,
  version: string,
): Promise<ReleaseRow | null> {
  const result = await client.query<ReleaseRow>(
    `
      SELECT id, version, status, previous_release_id, manifest
      FROM taxonomy_releases
      WHERE version = $1
      LIMIT 1
    `,
    [version],
  );

  return result.rows[0] ?? null;
}

async function latestPublishedVersion(
  client: PoolClient,
): Promise<string | null> {
  const result = await client.query<{ version: string }>(`
    SELECT version
    FROM taxonomy_releases
    WHERE status = 'PUBLISHED'
    ORDER BY version_major DESC, version_minor DESC, version_patch DESC
    LIMIT 1
  `);

  return result.rows[0]?.version ?? null;
}

async function loadSourceDimensionInputs(
  client: PoolClient,
  releaseId: string,
): Promise<Array<{ code: string; conceptCount: number }>> {
  const result = await client.query<{
    code: string;
    concept_count: number;
  }>(
    `
      SELECT
        d.code,
        count(rc.id)::int AS concept_count
      FROM taxonomy_release_dimensions rd
      JOIN taxonomy_dimensions d
        ON d.id = rd.dimension_id
      LEFT JOIN taxonomy_concepts c
        ON c.dimension_id = d.id
      LEFT JOIN taxonomy_release_concepts rc
        ON rc.release_id = rd.release_id
       AND rc.concept_id = c.id
      WHERE rd.release_id = $1
      GROUP BY d.code
      ORDER BY d.code
    `,
    [releaseId],
  );

  return result.rows.map((row) => ({
    code: row.code,
    conceptCount: row.concept_count,
  }));
}

async function loadCopyableCounts(
  client: PoolClient,
  sourceReleaseId: string,
): Promise<TaxonomyV11CopyCounts> {
  const result = await client.query<{
    alias_bindings: number;
    relation_rules: number;
    relations: number;
    official_mappings: number;
    alias_evidence: number;
    relation_evidence: number;
    mapping_evidence: number;
  }>(
    `
      SELECT
        (
          SELECT count(*)::int
          FROM taxonomy_release_alias_bindings b
          JOIN taxonomy_release_concepts rc
            ON rc.id = b.release_concept_id
           AND rc.release_id = b.release_id
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          JOIN taxonomy_dimensions d ON d.id = c.dimension_id
          WHERE b.release_id = $1
            AND NOT (d.code = ANY($2::text[]))
        ) AS alias_bindings,
        (
          SELECT count(*)::int
          FROM taxonomy_release_relation_rules rr
          JOIN taxonomy_dimensions sd ON sd.id = rr.source_dimension_id
          JOIN taxonomy_dimensions td ON td.id = rr.target_dimension_id
          WHERE rr.release_id = $1
            AND NOT (sd.code = ANY($2::text[]))
            AND NOT (td.code = ANY($2::text[]))
        ) AS relation_rules,
        (
          SELECT count(*)::int
          FROM taxonomy_concept_relations rel
          JOIN taxonomy_release_concepts src_rc
            ON src_rc.id = rel.source_release_concept_id
           AND src_rc.release_id = rel.release_id
          JOIN taxonomy_concepts src_c ON src_c.id = src_rc.concept_id
          JOIN taxonomy_dimensions src_d ON src_d.id = src_c.dimension_id
          JOIN taxonomy_release_concepts dst_rc
            ON dst_rc.id = rel.target_release_concept_id
           AND dst_rc.release_id = rel.release_id
          JOIN taxonomy_concepts dst_c ON dst_c.id = dst_rc.concept_id
          JOIN taxonomy_dimensions dst_d ON dst_d.id = dst_c.dimension_id
          WHERE rel.release_id = $1
            AND NOT (src_d.code = ANY($2::text[]))
            AND NOT (dst_d.code = ANY($2::text[]))
        ) AS relations,
        (
          SELECT count(*)::int
          FROM taxonomy_official_mappings m
          JOIN taxonomy_release_concepts rc
            ON rc.id = m.release_concept_id
           AND rc.release_id = m.release_id
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          JOIN taxonomy_dimensions d ON d.id = c.dimension_id
          WHERE m.release_id = $1
            AND NOT (d.code = ANY($2::text[]))
        ) AS official_mappings,
        (
          SELECT count(*)::int
          FROM taxonomy_alias_binding_evidence e
          JOIN taxonomy_release_alias_bindings b ON b.id = e.alias_binding_id
          JOIN taxonomy_release_concepts rc
            ON rc.id = b.release_concept_id
           AND rc.release_id = b.release_id
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          JOIN taxonomy_dimensions d ON d.id = c.dimension_id
          WHERE b.release_id = $1
            AND NOT (d.code = ANY($2::text[]))
        ) AS alias_evidence,
        (
          SELECT count(*)::int
          FROM taxonomy_relation_evidence e
          JOIN taxonomy_concept_relations rel ON rel.id = e.relation_id
          JOIN taxonomy_release_concepts src_rc
            ON src_rc.id = rel.source_release_concept_id
           AND src_rc.release_id = rel.release_id
          JOIN taxonomy_concepts src_c ON src_c.id = src_rc.concept_id
          JOIN taxonomy_dimensions src_d ON src_d.id = src_c.dimension_id
          JOIN taxonomy_release_concepts dst_rc
            ON dst_rc.id = rel.target_release_concept_id
           AND dst_rc.release_id = rel.release_id
          JOIN taxonomy_concepts dst_c ON dst_c.id = dst_rc.concept_id
          JOIN taxonomy_dimensions dst_d ON dst_d.id = dst_c.dimension_id
          WHERE rel.release_id = $1
            AND NOT (src_d.code = ANY($2::text[]))
            AND NOT (dst_d.code = ANY($2::text[]))
        ) AS relation_evidence,
        (
          SELECT count(*)::int
          FROM taxonomy_official_mapping_evidence e
          JOIN taxonomy_official_mappings m ON m.id = e.official_mapping_id
          JOIN taxonomy_release_concepts rc
            ON rc.id = m.release_concept_id
           AND rc.release_id = m.release_id
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          JOIN taxonomy_dimensions d ON d.id = c.dimension_id
          WHERE m.release_id = $1
            AND NOT (d.code = ANY($2::text[]))
        ) AS mapping_evidence
    `,
    [sourceReleaseId, RETIRED_CODES],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('TAXONOMY_V1_1_COPY_COUNTS_UNAVAILABLE');
  }

  return {
    aliasBindings: row.alias_bindings,
    relationRules: row.relation_rules,
    relations: row.relations,
    officialMappings: row.official_mappings,
    aliasEvidence: row.alias_evidence,
    relationEvidence: row.relation_evidence,
    mappingEvidence: row.mapping_evidence,
  };
}

async function readTargetSnapshot(
  client: PoolClient,
  target: ReleaseRow,
): Promise<TaxonomyV11TargetSnapshot> {
  const counts = await client.query<{
    dimensions: number;
    concepts: number;
    alias_bindings: number;
    relation_rules: number;
    relations: number;
    official_mappings: number;
    alias_evidence: number;
    relation_evidence: number;
    mapping_evidence: number;
    retired_dimensions_present: number;
    retired_concepts_present: number;
  }>(
    `
      SELECT
        (SELECT count(*)::int FROM taxonomy_release_dimensions WHERE release_id = $1) AS dimensions,
        (SELECT count(*)::int FROM taxonomy_release_concepts WHERE release_id = $1) AS concepts,
        (SELECT count(*)::int FROM taxonomy_release_alias_bindings WHERE release_id = $1) AS alias_bindings,
        (SELECT count(*)::int FROM taxonomy_release_relation_rules WHERE release_id = $1) AS relation_rules,
        (SELECT count(*)::int FROM taxonomy_concept_relations WHERE release_id = $1) AS relations,
        (SELECT count(*)::int FROM taxonomy_official_mappings WHERE release_id = $1) AS official_mappings,
        (
          SELECT count(*)::int
          FROM taxonomy_alias_binding_evidence e
          JOIN taxonomy_release_alias_bindings b ON b.id = e.alias_binding_id
          WHERE b.release_id = $1
        ) AS alias_evidence,
        (
          SELECT count(*)::int
          FROM taxonomy_relation_evidence e
          JOIN taxonomy_concept_relations r ON r.id = e.relation_id
          WHERE r.release_id = $1
        ) AS relation_evidence,
        (
          SELECT count(*)::int
          FROM taxonomy_official_mapping_evidence e
          JOIN taxonomy_official_mappings m ON m.id = e.official_mapping_id
          WHERE m.release_id = $1
        ) AS mapping_evidence,
        (
          SELECT count(*)::int
          FROM taxonomy_release_dimensions rd
          JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
          WHERE rd.release_id = $1
            AND d.code = ANY($2::text[])
        ) AS retired_dimensions_present,
        (
          SELECT count(*)::int
          FROM taxonomy_release_concepts rc
          JOIN taxonomy_concepts c ON c.id = rc.concept_id
          JOIN taxonomy_dimensions d ON d.id = c.dimension_id
          WHERE rc.release_id = $1
            AND d.code = ANY($2::text[])
        ) AS retired_concepts_present
    `,
    [target.id, RETIRED_CODES],
  );

  const preserved = await client.query<{ code: string }>(
    `
      SELECT d.code
      FROM taxonomy_release_dimensions rd
      JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
      WHERE rd.release_id = $1
        AND d.code = ANY($2::text[])
      ORDER BY d.code
    `,
    [target.id, PRESERVED_CODES],
  );

  const row = counts.rows[0];
  if (!row) {
    throw new Error('TAXONOMY_V1_1_TARGET_COUNTS_UNAVAILABLE');
  }

  return {
    releaseId: target.id,
    status: target.status,
    previousReleaseId: target.previous_release_id,
    dimensions: row.dimensions,
    concepts: row.concepts,
    aliasBindings: row.alias_bindings,
    relationRules: row.relation_rules,
    relations: row.relations,
    officialMappings: row.official_mappings,
    aliasEvidence: row.alias_evidence,
    relationEvidence: row.relation_evidence,
    mappingEvidence: row.mapping_evidence,
    retiredDimensionsPresent: row.retired_dimensions_present,
    retiredConceptsPresent: row.retired_concepts_present,
    preservedDimensionCodes: preserved.rows.map((item) => item.code),
    manifest: target.manifest,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function targetIntegrityBlockers(
  snapshot: TaxonomyV11TargetSnapshot,
  sourceReleaseId: string,
  plan: TaxonomyV11Plan,
  copyable: TaxonomyV11CopyCounts,
): string[] {
  const blockers: string[] = [];

  if (snapshot.previousReleaseId !== sourceReleaseId) {
    blockers.push('TARGET_PREVIOUS_RELEASE_MISMATCH');
  }
  if (snapshot.dimensions !== plan.retainedDimensions) {
    blockers.push('TARGET_DIMENSION_COUNT_MISMATCH');
  }
  if (snapshot.concepts !== plan.retainedConcepts) {
    blockers.push('TARGET_CONCEPT_COUNT_MISMATCH');
  }
  if (snapshot.retiredDimensionsPresent !== 0) {
    blockers.push('TARGET_CONTAINS_RETIRED_DIMENSIONS');
  }
  if (snapshot.retiredConceptsPresent !== 0) {
    blockers.push('TARGET_CONTAINS_RETIRED_CONCEPTS');
  }
  if (!sameStringSet(snapshot.preservedDimensionCodes, PRESERVED_CODES)) {
    blockers.push('TARGET_MISSING_REQUIRED_PRESERVED_DIMENSION');
  }
  if (snapshot.aliasBindings !== copyable.aliasBindings) {
    blockers.push('TARGET_ALIAS_BINDING_COUNT_MISMATCH');
  }
  if (snapshot.relationRules !== copyable.relationRules) {
    blockers.push('TARGET_RELATION_RULE_COUNT_MISMATCH');
  }
  if (snapshot.relations !== copyable.relations) {
    blockers.push('TARGET_RELATION_COUNT_MISMATCH');
  }
  if (snapshot.officialMappings !== copyable.officialMappings) {
    blockers.push('TARGET_OFFICIAL_MAPPING_COUNT_MISMATCH');
  }
  if (snapshot.aliasEvidence !== copyable.aliasEvidence) {
    blockers.push('TARGET_ALIAS_EVIDENCE_COUNT_MISMATCH');
  }
  if (snapshot.relationEvidence !== copyable.relationEvidence) {
    blockers.push('TARGET_RELATION_EVIDENCE_COUNT_MISMATCH');
  }
  if (snapshot.mappingEvidence !== copyable.mappingEvidence) {
    blockers.push('TARGET_MAPPING_EVIDENCE_COUNT_MISMATCH');
  }

  const manifest = snapshot.manifest;
  if (manifest.policyVersion !== TAXONOMY_V1_1_POLICY_VERSION) {
    blockers.push('TARGET_MANIFEST_POLICY_MISMATCH');
  }
  if (manifest.sourceReleaseId !== sourceReleaseId) {
    blockers.push('TARGET_MANIFEST_SOURCE_MISMATCH');
  }

  return blockers;
}

export async function dryRunTaxonomyV11Successor(
  client: PoolClient,
): Promise<TaxonomyV11DryRunReport> {
  const expectedCanonicalPlan = planTaxonomyV11FromCanonicalV1();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const source = await findRelease(client, TAXONOMY_V1_SOURCE_VERSION);
  const target = await findRelease(client, TAXONOMY_V1_1_VERSION);
  const latestPublished = await latestPublishedVersion(client);

  if (!source) {
    return {
      sourceReleaseId: null,
      sourceStatus: null,
      latestPublishedVersion: latestPublished,
      targetReleaseId: target?.id ?? null,
      targetStatus: target?.status ?? null,
      action: 'BLOCKED',
      plan: null,
      expectedCanonicalPlan,
      copyable: null,
      targetSnapshot: null,
      blockers: ['SOURCE_V1_0_0_NOT_FOUND'],
      warnings,
    };
  }

  if (source.status !== 'PUBLISHED') {
    blockers.push('SOURCE_V1_0_0_NOT_PUBLISHED');
  }

  const dimensionInputs = await loadSourceDimensionInputs(client, source.id);
  let plan: TaxonomyV11Plan | null = null;

  try {
    plan = planTaxonomyV11Successor(dimensionInputs);
  } catch (error) {
    blockers.push(
      error instanceof Error ? error.message : 'SOURCE_PLAN_INVALID',
    );
  }

  if (plan) {
    if (plan.sourceDimensions !== expectedCanonicalPlan.sourceDimensions) {
      blockers.push('SOURCE_DIMENSION_COUNT_MISMATCH');
    }
    if (plan.sourceConcepts !== expectedCanonicalPlan.sourceConcepts) {
      blockers.push('SOURCE_CONCEPT_COUNT_MISMATCH');
    }
    if (plan.retainedDimensions !== expectedCanonicalPlan.retainedDimensions) {
      blockers.push('RETAINED_DIMENSION_COUNT_MISMATCH');
    }
    if (plan.retainedConcepts !== expectedCanonicalPlan.retainedConcepts) {
      blockers.push('RETAINED_CONCEPT_COUNT_MISMATCH');
    }
    if (
      !sameStringSet(
        plan.retainedDimensionCodes,
        expectedCanonicalPlan.retainedDimensionCodes,
      )
    ) {
      blockers.push('RETAINED_DIMENSION_SET_MISMATCH');
    }
  }

  const copyable = plan
    ? await loadCopyableCounts(client, source.id)
    : null;
  let targetSnapshot: TaxonomyV11TargetSnapshot | null = null;

  if (target && plan && copyable) {
    targetSnapshot = await readTargetSnapshot(client, target);
    blockers.push(
      ...targetIntegrityBlockers(
        targetSnapshot,
        source.id,
        plan,
        copyable,
      ),
    );

    if (!['DRAFT', 'PUBLISHED'].includes(target.status)) {
      blockers.push('TARGET_RELEASE_UNSUPPORTED_STATUS:' + target.status);
    }
  }

  if (!target || target.status !== 'PUBLISHED') {
    if (latestPublished !== TAXONOMY_V1_SOURCE_VERSION) {
      blockers.push(
        'LATEST_PUBLISHED_RELEASE_IS_NOT_V1_0_0:' +
          (latestPublished ?? 'NONE'),
      );
    }
  } else if (latestPublished !== TAXONOMY_V1_1_VERSION) {
    warnings.push(
      'TARGET_IS_PUBLISHED_BUT_NOT_LATEST_PUBLISHED:' +
        (latestPublished ?? 'NONE'),
    );
  }

  const uniqueBlockers = [...new Set(blockers)];
  let action: TaxonomyV11DryRunAction;
  if (uniqueBlockers.length > 0) {
    action = 'BLOCKED';
  } else if (!target) {
    action = 'CREATE_DRAFT';
  } else if (target.status === 'PUBLISHED') {
    action = 'ALREADY_PUBLISHED';
  } else {
    action = 'VALIDATE_EXISTING_DRAFT';
  }

  return {
    sourceReleaseId: source.id,
    sourceStatus: source.status,
    latestPublishedVersion: latestPublished,
    targetReleaseId: target?.id ?? null,
    targetStatus: target?.status ?? null,
    action,
    plan,
    expectedCanonicalPlan,
    copyable,
    targetSnapshot,
    blockers: uniqueBlockers,
    warnings,
  };
}

function buildReleaseManifest(
  report: TaxonomyV11DryRunReport,
): Record<string, unknown> {
  if (!report.sourceReleaseId || !report.plan || !report.copyable) {
    throw new Error('TAXONOMY_V1_1_DRY_RUN_INCOMPLETE');
  }

  const semantic = {
    policyVersion: TAXONOMY_V1_1_POLICY_VERSION,
    sourceVersion: TAXONOMY_V1_SOURCE_VERSION,
    sourceReleaseId: report.sourceReleaseId,
    targetVersion: TAXONOMY_V1_1_VERSION,
    retiredDimensionCodes: RETIRED_CODES,
    requiredPreservedDimensionCodes: PRESERVED_CODES,
    counts: {
      sourceDimensions: report.plan.sourceDimensions,
      sourceConcepts: report.plan.sourceConcepts,
      retainedDimensions: report.plan.retainedDimensions,
      retainedConcepts: report.plan.retainedConcepts,
      retiredDimensions: report.plan.retiredDimensions,
      retiredConcepts: report.plan.retiredConcepts,
      ...report.copyable,
    },
  };

  return {
    ...semantic,
    derivationSha256: createHash('sha256')
      .update(canonicalJson(semantic), 'utf8')
      .digest('hex'),
  };
}

async function writeAudit(
  client: PoolClient,
  input: {
    action: string;
    releaseId: string;
    correlationId: string;
    actor: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO audit_log (
        tenant_id, actor_type, actor_id, action,
        entity_type, entity_id, after_data, correlation_id
      ) VALUES (
        NULL, 'SYSTEM', $1, $2,
        'taxonomy_release', $3::uuid, public.audit_project($2,'taxonomy_release',$4::jsonb), $5::uuid
      )
    `,
    [
      input.actor,
      input.action,
      input.releaseId,
      JSON.stringify(input.payload),
      input.correlationId,
    ],
  );
}

async function copyReleaseGraph(
  client: PoolClient,
  sourceReleaseId: string,
  targetReleaseId: string,
): Promise<void> {
  await client.query(
    `
      INSERT INTO taxonomy_release_dimensions (
        release_id, dimension_id, dimension_revision_id, membership_status
      )
      SELECT $2::uuid, rd.dimension_id, rd.dimension_revision_id, rd.membership_status
      FROM taxonomy_release_dimensions rd
      JOIN taxonomy_dimensions d ON d.id = rd.dimension_id
      WHERE rd.release_id = $1::uuid
        AND NOT (d.code = ANY($3::text[]))
      ORDER BY d.code
    `,
    [sourceReleaseId, targetReleaseId, RETIRED_CODES],
  );

  const sourceConcepts = await client.query<{
    source_release_concept_id: string;
    concept_id: string;
    concept_revision_id: string;
    membership_status: string;
    release_notes: string | null;
  }>(
    `
      SELECT
        rc.id AS source_release_concept_id,
        rc.concept_id,
        rc.concept_revision_id,
        rc.membership_status,
        rc.release_notes
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      WHERE rc.release_id = $1::uuid
        AND NOT (d.code = ANY($2::text[]))
      ORDER BY c.code
    `,
    [sourceReleaseId, RETIRED_CODES],
  );

  const conceptMap = new Map<string, string>();
  for (const row of sourceConcepts.rows) {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_release_concepts (
          release_id, concept_id, concept_revision_id,
          membership_status, release_notes
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
        RETURNING id
      `,
      [
        targetReleaseId,
        row.concept_id,
        row.concept_revision_id,
        row.membership_status,
        row.release_notes,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('TAXONOMY_V1_1_CONCEPT_COPY_FAILED');
    conceptMap.set(row.source_release_concept_id, id);
  }

  const aliases = await client.query<{
    id: string;
    alias_id: string;
    release_concept_id: string;
    alias_type: string;
    decision_status: string;
    jurisdiction_level: string | null;
    uf: string | null;
    municipality_ibge_code: string | null;
    context: Record<string, unknown>;
    valid_from: string | null;
    valid_to: string | null;
    temporal_basis: string | null;
    justification: string | null;
    evidence_status: string;
  }>(
    `
      SELECT b.*
      FROM taxonomy_release_alias_bindings b
      JOIN taxonomy_release_concepts rc
        ON rc.id = b.release_concept_id
       AND rc.release_id = b.release_id
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      WHERE b.release_id = $1::uuid
        AND NOT (d.code = ANY($2::text[]))
      ORDER BY b.id
    `,
    [sourceReleaseId, RETIRED_CODES],
  );

  const aliasMap = new Map<string, string>();
  for (const row of aliases.rows) {
    const targetConceptId = conceptMap.get(row.release_concept_id);
    if (!targetConceptId) throw new Error('TAXONOMY_V1_1_ALIAS_CONCEPT_MAP_MISSING');
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_release_alias_bindings (
          release_id, alias_id, release_concept_id,
          alias_type, decision_status, jurisdiction_level,
          uf, municipality_ibge_code, context,
          valid_from, valid_to, temporal_basis,
          justification, evidence_status
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid,
          $4, $5, $6, $7, $8, $9::jsonb,
          $10, $11, $12, $13, $14
        ) RETURNING id
      `,
      [
        targetReleaseId,
        row.alias_id,
        targetConceptId,
        row.alias_type,
        row.decision_status,
        row.jurisdiction_level,
        row.uf,
        row.municipality_ibge_code,
        JSON.stringify(row.context),
        row.valid_from,
        row.valid_to,
        row.temporal_basis,
        row.justification,
        row.evidence_status,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('TAXONOMY_V1_1_ALIAS_COPY_FAILED');
    aliasMap.set(row.id, id);
  }

  await client.query(
    `
      INSERT INTO taxonomy_release_relation_rules (
        release_id, relation_type_id,
        source_dimension_id, target_dimension_id,
        allowed, requires_evidence, acyclic_override, notes
      )
      SELECT
        $2::uuid, rr.relation_type_id,
        rr.source_dimension_id, rr.target_dimension_id,
        rr.allowed, rr.requires_evidence, rr.acyclic_override, rr.notes
      FROM taxonomy_release_relation_rules rr
      JOIN taxonomy_dimensions sd ON sd.id = rr.source_dimension_id
      JOIN taxonomy_dimensions td ON td.id = rr.target_dimension_id
      WHERE rr.release_id = $1::uuid
        AND NOT (sd.code = ANY($3::text[]))
        AND NOT (td.code = ANY($3::text[]))
      ORDER BY rr.id
    `,
    [sourceReleaseId, targetReleaseId, RETIRED_CODES],
  );

  const relations = await client.query<{
    id: string;
    source_release_concept_id: string;
    target_release_concept_id: string;
    relation_type_id: string;
    status: string;
    valid_from: string | null;
    valid_to: string | null;
    qualifiers: Record<string, unknown>;
    justification: string | null;
    evidence_status: string;
  }>(
    `
      SELECT rel.*
      FROM taxonomy_concept_relations rel
      JOIN taxonomy_release_concepts src_rc
        ON src_rc.id = rel.source_release_concept_id
       AND src_rc.release_id = rel.release_id
      JOIN taxonomy_concepts src_c ON src_c.id = src_rc.concept_id
      JOIN taxonomy_dimensions src_d ON src_d.id = src_c.dimension_id
      JOIN taxonomy_release_concepts dst_rc
        ON dst_rc.id = rel.target_release_concept_id
       AND dst_rc.release_id = rel.release_id
      JOIN taxonomy_concepts dst_c ON dst_c.id = dst_rc.concept_id
      JOIN taxonomy_dimensions dst_d ON dst_d.id = dst_c.dimension_id
      WHERE rel.release_id = $1::uuid
        AND NOT (src_d.code = ANY($2::text[]))
        AND NOT (dst_d.code = ANY($2::text[]))
      ORDER BY rel.id
    `,
    [sourceReleaseId, RETIRED_CODES],
  );

  const relationMap = new Map<string, string>();
  for (const row of relations.rows) {
    const sourceId = conceptMap.get(row.source_release_concept_id);
    const targetId = conceptMap.get(row.target_release_concept_id);
    if (!sourceId || !targetId) {
      throw new Error('TAXONOMY_V1_1_RELATION_CONCEPT_MAP_MISSING');
    }
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_concept_relations (
          release_id, source_release_concept_id,
          target_release_concept_id, relation_type_id,
          status, valid_from, valid_to, qualifiers,
          justification, evidence_status
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5, $6, $7, $8::jsonb, $9, $10
        ) RETURNING id
      `,
      [
        targetReleaseId,
        sourceId,
        targetId,
        row.relation_type_id,
        row.status,
        row.valid_from,
        row.valid_to,
        JSON.stringify(row.qualifiers),
        row.justification,
        row.evidence_status,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('TAXONOMY_V1_1_RELATION_COPY_FAILED');
    relationMap.set(row.id, id);
  }

  const mappings = await client.query<{
    id: string;
    release_concept_id: string;
    official_catalog_entry_id: string;
    mapping_type: string;
    valid_from: string | null;
    valid_to: string | null;
    justification: string | null;
    evidence_status: string;
  }>(
    `
      SELECT m.*
      FROM taxonomy_official_mappings m
      JOIN taxonomy_release_concepts rc
        ON rc.id = m.release_concept_id
       AND rc.release_id = m.release_id
      JOIN taxonomy_concepts c ON c.id = rc.concept_id
      JOIN taxonomy_dimensions d ON d.id = c.dimension_id
      WHERE m.release_id = $1::uuid
        AND NOT (d.code = ANY($2::text[]))
      ORDER BY m.id
    `,
    [sourceReleaseId, RETIRED_CODES],
  );

  const mappingMap = new Map<string, string>();
  for (const row of mappings.rows) {
    const targetConceptId = conceptMap.get(row.release_concept_id);
    if (!targetConceptId) throw new Error('TAXONOMY_V1_1_MAPPING_CONCEPT_MAP_MISSING');
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO taxonomy_official_mappings (
          release_id, release_concept_id, official_catalog_entry_id,
          mapping_type, valid_from, valid_to,
          justification, evidence_status
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid,
          $4, $5, $6, $7, $8
        ) RETURNING id
      `,
      [
        targetReleaseId,
        targetConceptId,
        row.official_catalog_entry_id,
        row.mapping_type,
        row.valid_from,
        row.valid_to,
        row.justification,
        row.evidence_status,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('TAXONOMY_V1_1_MAPPING_COPY_FAILED');
    mappingMap.set(row.id, id);
  }

  const aliasEvidence = await client.query<{
    alias_binding_id: string;
    evidence_id: string;
    role: string;
    note: string | null;
  }>(
    `
      SELECT e.alias_binding_id, e.evidence_id, e.role, e.note
      FROM taxonomy_alias_binding_evidence e
      JOIN taxonomy_release_alias_bindings b ON b.id = e.alias_binding_id
      WHERE b.release_id = $1::uuid
      ORDER BY e.id
    `,
    [sourceReleaseId],
  );
  for (const row of aliasEvidence.rows) {
    const targetId = aliasMap.get(row.alias_binding_id);
    if (!targetId) continue;
    await client.query(
      `
        INSERT INTO taxonomy_alias_binding_evidence (
          alias_binding_id, evidence_id, role, note
        ) VALUES ($1::uuid, $2::uuid, $3, $4)
      `,
      [targetId, row.evidence_id, row.role, row.note],
    );
  }

  const relationEvidence = await client.query<{
    relation_id: string;
    evidence_id: string;
    role: string;
    note: string | null;
  }>(
    `
      SELECT e.relation_id, e.evidence_id, e.role, e.note
      FROM taxonomy_relation_evidence e
      JOIN taxonomy_concept_relations r ON r.id = e.relation_id
      WHERE r.release_id = $1::uuid
      ORDER BY e.id
    `,
    [sourceReleaseId],
  );
  for (const row of relationEvidence.rows) {
    const targetId = relationMap.get(row.relation_id);
    if (!targetId) continue;
    await client.query(
      `
        INSERT INTO taxonomy_relation_evidence (
          relation_id, evidence_id, role, note
        ) VALUES ($1::uuid, $2::uuid, $3, $4)
      `,
      [targetId, row.evidence_id, row.role, row.note],
    );
  }

  const mappingEvidence = await client.query<{
    official_mapping_id: string;
    evidence_id: string;
    role: string;
    note: string | null;
  }>(
    `
      SELECT e.official_mapping_id, e.evidence_id, e.role, e.note
      FROM taxonomy_official_mapping_evidence e
      JOIN taxonomy_official_mappings m ON m.id = e.official_mapping_id
      WHERE m.release_id = $1::uuid
      ORDER BY e.id
    `,
    [sourceReleaseId],
  );
  for (const row of mappingEvidence.rows) {
    const targetId = mappingMap.get(row.official_mapping_id);
    if (!targetId) continue;
    await client.query(
      `
        INSERT INTO taxonomy_official_mapping_evidence (
          official_mapping_id, evidence_id, role, note
        ) VALUES ($1::uuid, $2::uuid, $3, $4)
      `,
      [targetId, row.evidence_id, row.role, row.note],
    );
  }
}

function assertDryRunReady(report: TaxonomyV11DryRunReport): void {
  if (report.blockers.length > 0) {
    throw new Error(
      'TAXONOMY_V1_1_DRY_RUN_BLOCKED:' + report.blockers.join(','),
    );
  }
  if (!report.sourceReleaseId || !report.plan || !report.copyable) {
    throw new Error('TAXONOMY_V1_1_DRY_RUN_INCOMPLETE');
  }
}

export async function createTaxonomyV11DraftInTransaction(
  client: PoolClient,
): Promise<CreateTaxonomyV11Result> {
  await acquireSuccessorLock(client);
  const report = await dryRunTaxonomyV11Successor(client);
  assertDryRunReady(report);

  if (report.targetReleaseId && report.targetSnapshot) {
    return {
      disposition:
        report.targetStatus === 'PUBLISHED'
          ? 'ALREADY_PUBLISHED'
          : 'IDEMPOTENT_DRAFT',
      releaseId: report.targetReleaseId,
      snapshot: report.targetSnapshot,
    };
  }

  const manifest = buildReleaseManifest(report);
  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO taxonomy_releases (
        version_major, version_minor, version_patch,
        status, previous_release_id, manifest,
        change_notes, created_by_actor
      ) VALUES (
        1, 1, 0,
        'DRAFT', $1::uuid, $2::jsonb,
        $3, 'taxonomy-v1.1-successor'
      ) RETURNING id
    `,
    [
      report.sourceReleaseId,
      JSON.stringify(manifest),
      'Remove non-canonical company-profile dimensions while preserving legislation taxonomy and v1.0.0 history.',
    ],
  );
  const releaseId = inserted.rows[0]?.id;
  if (!releaseId) throw new Error('TAXONOMY_V1_1_RELEASE_INSERT_FAILED');

  await copyReleaseGraph(client, report.sourceReleaseId!, releaseId);

  const target = await findRelease(client, TAXONOMY_V1_1_VERSION);
  if (!target) throw new Error('TAXONOMY_V1_1_TARGET_DISAPPEARED');
  const snapshot = await readTargetSnapshot(client, target);
  const blockers = targetIntegrityBlockers(
    snapshot,
    report.sourceReleaseId!,
    report.plan!,
    report.copyable!,
  );
  if (blockers.length > 0) {
    throw new Error('TAXONOMY_V1_1_TARGET_INTEGRITY_FAILED:' + blockers.join(','));
  }

  await writeAudit(client, {
    action: 'TAXONOMY_V1_1_DRAFT_CREATED',
    releaseId,
    correlationId: randomUUID(),
    actor: 'taxonomy-v1.1-successor',
    payload: {
      sourceReleaseId: report.sourceReleaseId,
      targetVersion: TAXONOMY_V1_1_VERSION,
      counts: manifest.counts,
    },
  });

  return {
    disposition: 'CREATED_DRAFT',
    releaseId,
    snapshot,
  };
}

export async function createTaxonomyV11Draft(
  pool: Pool,
): Promise<CreateTaxonomyV11Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    const result = await createTaxonomyV11DraftInTransaction(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function validatePublishOptions(options: PublishTaxonomyV11Options): void {
  if (!options.artifactRepository.trim()) {
    throw new Error('TAXONOMY_V1_1_ARTIFACT_REPOSITORY_REQUIRED');
  }
  if (!options.artifactPath.trim()) {
    throw new Error('TAXONOMY_V1_1_ARTIFACT_PATH_REQUIRED');
  }
  if (!/^[a-f0-9]{40}$/.test(options.artifactGitSha)) {
    throw new Error('TAXONOMY_V1_1_INVALID_ARTIFACT_GIT_SHA');
  }
  if (!/^[a-f0-9]{64}$/.test(options.artifactSha256)) {
    throw new Error('TAXONOMY_V1_1_INVALID_ARTIFACT_SHA256');
  }
}

export async function publishTaxonomyV11InTransaction(
  client: PoolClient,
  options: PublishTaxonomyV11Options,
): Promise<PublishTaxonomyV11Result> {
  validatePublishOptions(options);
  await acquireSuccessorLock(client);
  const report = await dryRunTaxonomyV11Successor(client);
  assertDryRunReady(report);

  if (!report.targetReleaseId || !report.targetSnapshot) {
    throw new Error('TAXONOMY_V1_1_DRAFT_NOT_FOUND');
  }
  if (report.targetStatus === 'PUBLISHED') {
    return {
      disposition: 'ALREADY_PUBLISHED',
      releaseId: report.targetReleaseId,
      snapshot: report.targetSnapshot,
    };
  }
  if (report.targetStatus !== 'DRAFT') {
    throw new Error('TAXONOMY_V1_1_TARGET_NOT_DRAFT:' + report.targetStatus);
  }
  if (report.latestPublishedVersion !== TAXONOMY_V1_SOURCE_VERSION) {
    throw new Error(
      'TAXONOMY_V1_1_STALE_PUBLICATION_BASE:' +
        (report.latestPublishedVersion ?? 'NONE'),
    );
  }

  const updated = await client.query<{ id: string }>(
    `
      UPDATE taxonomy_releases
      SET
        status = 'PUBLISHED',
        approved_at = now(),
        published_at = now(),
        artifact_repository = $2,
        artifact_path = $3,
        artifact_git_sha = $4,
        artifact_sha256 = $5
      WHERE id = $1::uuid
        AND status = 'DRAFT'
      RETURNING id
    `,
    [
      report.targetReleaseId,
      options.artifactRepository,
      options.artifactPath,
      options.artifactGitSha,
      options.artifactSha256,
    ],
  );
  if (!updated.rows[0]?.id) {
    throw new Error('TAXONOMY_V1_1_PUBLISH_UPDATE_FAILED');
  }

  await writeAudit(client, {
    action: 'TAXONOMY_V1_1_PUBLISHED',
    releaseId: report.targetReleaseId,
    correlationId: randomUUID(),
    actor: options.actor ?? 'taxonomy-v1.1-publisher',
    payload: {
      sourceVersion: TAXONOMY_V1_SOURCE_VERSION,
      targetVersion: TAXONOMY_V1_1_VERSION,
      artifactRepository: options.artifactRepository,
      artifactPath: options.artifactPath,
      artifactGitSha: options.artifactGitSha,
      artifactSha256: options.artifactSha256,
    },
  });

  const target = await findRelease(client, TAXONOMY_V1_1_VERSION);
  if (!target) throw new Error('TAXONOMY_V1_1_TARGET_DISAPPEARED_AFTER_PUBLISH');
  const snapshot = await readTargetSnapshot(client, target);

  return {
    disposition: 'PUBLISHED',
    releaseId: target.id,
    snapshot,
  };
}

export async function publishTaxonomyV11(
  pool: Pool,
  options: PublishTaxonomyV11Options,
): Promise<PublishTaxonomyV11Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    const result = await publishTaxonomyV11InTransaction(client, options);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
