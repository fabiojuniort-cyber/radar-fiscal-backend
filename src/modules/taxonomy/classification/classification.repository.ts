import type { Pool, PoolClient } from 'pg';

import { sha256Hex } from '../baseline/baseline.canonical-json.js';

import {
  planLexicalClassification,
  type LexicalClassificationPlan,
} from './classification.engine.js';
import type {
  ClassificationAlias,
  LexicalConceptInput,
} from './classification.lexical.js';

interface PublicationInputRow {
  publication_version_id: string;
  title: string;
  content_text: string | null;
}

interface ConceptRow {
  release_concept_id: string;
  code: string;
  label: string;
  alias_text: string | null;
  alias_type: ClassificationAlias['aliasType'] | null;
}

export interface PersistedClassificationResult {
  runId: string;
  disposition: 'CREATED' | 'EXISTING';
  status: string;
  assertionCount: number;
  runFingerprint: string;
}

async function loadPublication(
  client: PoolClient,
  publicationVersionId: string,
): Promise<PublicationInputRow> {
  const result = await client.query<PublicationInputRow>(
    `
      SELECT
        pv.id AS publication_version_id,
        p.title,
        pv.content_text
      FROM publication_versions pv
      JOIN publications p ON p.id = pv.publication_id
      WHERE pv.id = $1
    `,
    [publicationVersionId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('publication version not found');
  }
  return row;
}

async function loadConcepts(
  client: PoolClient,
  taxonomyReleaseId: string,
): Promise<LexicalConceptInput[]> {
  const result = await client.query<ConceptRow>(
    `
      SELECT
        rc.id AS release_concept_id,
        c.code,
        cr.label,
        a.text AS alias_text,
        b.alias_type
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c
        ON c.id = rc.concept_id
      JOIN taxonomy_concept_revisions cr
        ON cr.id = rc.concept_revision_id
      LEFT JOIN taxonomy_release_alias_bindings b
        ON b.release_concept_id = rc.id
       AND b.release_id = rc.release_id
       AND b.decision_status = 'APPROVED'
      LEFT JOIN taxonomy_aliases a
        ON a.id = b.alias_id
      WHERE rc.release_id = $1
        AND rc.membership_status = 'INCLUDED'
      ORDER BY c.code, a.normalized_text NULLS LAST
    `,
    [taxonomyReleaseId],
  );

  const concepts = new Map<string, LexicalConceptInput>();
  for (const row of result.rows) {
    let concept = concepts.get(row.release_concept_id);
    if (!concept) {
      concept = {
        releaseConceptId: row.release_concept_id,
        code: row.code,
        label: row.label,
        aliases: [],
      };
      concepts.set(row.release_concept_id, concept);
    }

    if (row.alias_text && row.alias_type) {
      concept.aliases.push({
        text: row.alias_text,
        aliasType: row.alias_type,
      });
    }
  }

  return [...concepts.values()];
}

async function insertOrReadRun(
  client: PoolClient,
  plan: LexicalClassificationPlan,
): Promise<{
  id: string;
  status: string;
  disposition: 'CREATED' | 'EXISTING';
}> {
  const inserted = await client.query<{ id: string; status: string }>(
    `
      INSERT INTO publication_taxonomy_runs (
        publication_version_id,
        taxonomy_release_id,
        method_type,
        engine_key,
        engine_version,
        code_git_sha,
        config_snapshot,
        config_sha256,
        input_sha256,
        run_fingerprint,
        status,
        started_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8, $9, $10,
        'RUNNING', now()
      )
      ON CONFLICT (run_fingerprint) DO NOTHING
      RETURNING id, status
    `,
    [
      plan.publicationVersionId,
      plan.taxonomyReleaseId,
      plan.methodType,
      plan.engineKey,
      plan.engineVersion,
      plan.codeGitSha,
      JSON.stringify(plan.configSnapshot),
      plan.fingerprint.configSha256,
      plan.inputSha256,
      plan.fingerprint.runFingerprint,
    ],
  );

  const created = inserted.rows[0];
  if (created) {
    return {
      ...created,
      disposition: 'CREATED',
    };
  }

  const existing = await client.query<{ id: string; status: string }>(
    `
      SELECT id, status
      FROM publication_taxonomy_runs
      WHERE run_fingerprint = $1
    `,
    [plan.fingerprint.runFingerprint],
  );

  const row = existing.rows[0];
  if (!row) {
    throw new Error('classification run conflict could not be read back');
  }

  return {
    ...row,
    disposition: 'EXISTING',
  };
}

async function persistAssertions(
  client: PoolClient,
  runId: string,
  plan: LexicalClassificationPlan,
): Promise<void> {
  for (const assertion of plan.assertions) {
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO publication_taxonomy_assertions (
          run_id,
          taxonomy_release_id,
          release_concept_id,
          assertion_status,
          confidence,
          decision_origin,
          reason_code
        )
        VALUES ($1, $2, $3, 'CONFIRMED', $4, 'RULE_ENGINE', $5)
        RETURNING id
      `,
      [
        runId,
        plan.taxonomyReleaseId,
        assertion.releaseConceptId,
        assertion.confidence,
        assertion.reasonCode,
      ],
    );

    const assertionId = inserted.rows[0]?.id;
    if (!assertionId) {
      throw new Error(
        'classification assertion insert did not return id',
      );
    }

    await client.query(
      `
        INSERT INTO publication_taxonomy_spans (
          assertion_id,
          excerpt,
          selector,
          source_fragment_hash
        )
        VALUES ($1, $2, $3::jsonb, $4)
      `,
      [
        assertionId,
        assertion.matchedTerm,
        JSON.stringify({
          strategy: 'NFD_LOWER_ALNUM_TOKENS',
          term: assertion.matchedTerm,
          reasonCode: assertion.reasonCode,
        }),
        sha256Hex(assertion.matchedTerm),
      ],
    );
  }
}

export async function classifyPublicationVersionLexically(
  pool: Pool,
  input: {
    publicationVersionId: string;
    taxonomyReleaseId: string;
    codeGitSha?: string | null;
  },
): Promise<PersistedClassificationResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const publication = await loadPublication(
      client,
      input.publicationVersionId,
    );
    const concepts = await loadConcepts(
      client,
      input.taxonomyReleaseId,
    );

    const plan = planLexicalClassification({
      publicationVersionId: publication.publication_version_id,
      taxonomyReleaseId: input.taxonomyReleaseId,
      title: publication.title,
      contentText: publication.content_text,
      concepts,
      codeGitSha: input.codeGitSha ?? null,
    });

    const run = await insertOrReadRun(client, plan);

    if (run.disposition === 'EXISTING') {
      const count = await client.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM publication_taxonomy_assertions
          WHERE run_id = $1
        `,
        [run.id],
      );
      await client.query('COMMIT');
      return {
        runId: run.id,
        disposition: 'EXISTING',
        status: run.status,
        assertionCount: Number(count.rows[0]?.count ?? 0),
        runFingerprint: plan.fingerprint.runFingerprint,
      };
    }

    await persistAssertions(client, run.id, plan);

    await client.query(
      `
        UPDATE publication_taxonomy_runs
        SET status = 'SUCCESS',
            finished_at = now()
        WHERE id = $1
      `,
      [run.id],
    );

    await client.query('COMMIT');

    return {
      runId: run.id,
      disposition: 'CREATED',
      status: 'SUCCESS',
      assertionCount: plan.assertions.length,
      runFingerprint: plan.fingerprint.runFingerprint,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
