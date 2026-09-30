import {
  createHash,
  randomUUID,
} from 'node:crypto';
import pg from 'pg';

import {
  evaluateTaxonomyCriteria,
  parseTaxonomyMonitoringCriteria,
} from '../../dist/modules/taxonomy/matching/taxonomy-criteria.js';

const RELEASE_ID = '6e6ad5ff-fa6d-45dc-a3ea-ae4c5e4c2f3b';
const EXPECTED_MANIFEST =
  'cdbad652dbafddef45193be9f5092ab17cb5097523085135e1f3b2ce00eb85ee';
const EXPECTED_DERIVATION =
  'ac315c0ad591836c8c98c03b04769aa8442ebec5409fd1fc5961dffc04a2414b';
const EXPECTED_CODE_SHA =
  '25c2c42ed43d001dcfa1eb0edc9ce4fa35fffbe7';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail('TAX_ACT_VERIFY_FAILED: ' + label, { actual, expected });
  }
}

const connectionString =
  process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  fail('DATABASE_ADMIN_URL or DATABASE_URL is required.');
}

const pool = new pg.Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
});

const client = await pool.connect();

async function activityCounts() {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM publication_taxonomy_runs) AS runs,
      (SELECT count(*)::int FROM publication_taxonomy_assertions) AS assertions,
      (SELECT count(*)::int FROM publication_taxonomy_spans) AS spans,
      (SELECT count(*)::int FROM publication_taxonomy_reviews) AS reviews,
      (SELECT count(*)::int FROM taxonomy_unmapped_occurrences) AS unmapped,
      (SELECT count(*)::int FROM taxonomy_candidates) AS candidates,
      (SELECT count(*)::int FROM taxonomy_candidate_occurrence_links) AS candidate_links
  `);
  return result.rows[0];
}

try {
  const releaseResult = await client.query(
    `
      SELECT
        id,
        status,
        approved_at,
        published_at,
        artifact_git_sha,
        artifact_sha256,
        manifest->>'manifestSha256' AS manifest_sha256,
        manifest->>'derivationFingerprint' AS derivation_fingerprint
      FROM taxonomy_releases
      WHERE id = $1
    `,
    [RELEASE_ID],
  );

  const release = releaseResult.rows[0];

  if (!release) {
    fail('TAX_ACT_RELEASE_NOT_FOUND');
  }

  assertEqual(release.status, 'PUBLISHED', 'release status');
  assertEqual(release.manifest_sha256, EXPECTED_MANIFEST, 'manifest hash');
  assertEqual(
    release.derivation_fingerprint,
    EXPECTED_DERIVATION,
    'derivation fingerprint',
  );

  if (!release.approved_at || !release.published_at) {
    fail('TAX_ACT_PUBLISHED_TIMESTAMPS_MISSING');
  }

  const migrationResult = await client.query(`
    SELECT filename
    FROM schema_migrations
    WHERE filename IN (
      '020_taxonomy_classification.sql',
      '021_taxonomy_candidates.sql'
    )
    ORDER BY filename
  `);

  assertEqual(
    migrationResult.rows.map((row) => row.filename).join(','),
    '020_taxonomy_classification.sql,021_taxonomy_candidates.sql',
    'activation migrations',
  );

  const auditResult = await client.query(
    `
      SELECT
        count(*)::int AS n,
        min(occurred_at) AS first_at,
        max(occurred_at) AS last_at
      FROM audit_log
      WHERE tenant_id IS NULL
        AND actor_type = 'ADMIN'
        AND actor_id = 'TAX-ACT#46'
        AND action = 'TAXONOMY_RELEASE_PUBLISHED'
        AND entity_type = 'taxonomy_release'
        AND entity_id = $1
    `,
    [RELEASE_ID],
  );

  assertEqual(auditResult.rows[0]?.n ?? -1, 1, 'publication audit event count');

  const publishedResult = await client.query(`
    SELECT id
    FROM taxonomy_releases
    WHERE status = 'PUBLISHED'
    ORDER BY version_major DESC, version_minor DESC, version_patch DESC
    LIMIT 1
  `);

  assertEqual(
    publishedResult.rows[0]?.id,
    RELEASE_ID,
    'CURRENT_PUBLISHED resolution',
  );

  const before = await activityCounts();

  assertEqual(before.runs, 0, 'pre-smoke runs');
  assertEqual(before.assertions, 0, 'pre-smoke assertions');
  assertEqual(before.spans, 0, 'pre-smoke spans');
  assertEqual(before.reviews, 0, 'pre-smoke reviews');
  assertEqual(before.unmapped, 0, 'pre-smoke unmapped');
  assertEqual(before.candidates, 0, 'pre-smoke candidates');
  assertEqual(before.candidate_links, 0, 'pre-smoke candidate links');

  const publicationVersion = await client.query(
    'SELECT id FROM publication_versions LIMIT 1',
  );

  const publicationVersionId = publicationVersion.rows[0]?.id;

  if (!publicationVersionId) {
    fail('TAX_ACT_SMOKE_NEEDS_PUBLICATION_VERSION');
  }

  const releaseConcept = await client.query(
    `
      SELECT
        rc.id,
        c.code
      FROM taxonomy_release_concepts rc
      JOIN taxonomy_concepts c
        ON c.id = rc.concept_id
      WHERE rc.release_id = $1
        AND rc.membership_status = 'INCLUDED'
      ORDER BY c.code
      LIMIT 1
    `,
    [RELEASE_ID],
  );

  const releaseConceptId = releaseConcept.rows[0]?.id;
  const conceptCode = releaseConcept.rows[0]?.code;

  if (!releaseConceptId || !conceptCode) {
    fail('TAX_ACT_SMOKE_NEEDS_RELEASE_CONCEPT');
  }

  const criteria = parseTaxonomyMonitoringCriteria(
    {
      taxonomy: {
        releasePolicy: 'CURRENT_PUBLISHED',
        anyOf: [conceptCode],
        allOf: [],
        noneOf: [],
        includeDescendants: false,
      },
    },
    2,
  );

  if (!criteria) {
    fail('TAX_ACT_SMOKE_CRITERIA_PARSE_FAILED');
  }

  const criteriaEvaluation = evaluateTaxonomyCriteria(
    criteria,
    new Set([conceptCode]),
    new Map([[conceptCode, new Set([conceptCode])]]),
  );

  assertEqual(criteriaEvaluation.matched, true, 'TAX-09 criteria evaluation');

  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('tribusca_taxonomy_activation_smoke_v1'))",
  );
  await client.query('SET LOCAL ROLE radar_worker_runtime');

  const workerIdentity = await client.query('SELECT current_user');
  assertEqual(
    workerIdentity.rows[0]?.current_user,
    'radar_worker_runtime',
    'worker role',
  );

  const smokeSeed = randomUUID();
  const runFingerprint = sha256('tax-act-run:' + smokeSeed);

  const runResult = await client.query(
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
        run_fingerprint
      )
      VALUES (
        $1,
        $2,
        'RULE',
        'tax-act-smoke',
        '1.0.0',
        $3,
        '{"smoke":true}'::jsonb,
        $4,
        $5,
        $6
      )
      RETURNING id
    `,
    [
      publicationVersionId,
      RELEASE_ID,
      EXPECTED_CODE_SHA,
      sha256('{"smoke":true}'),
      sha256('tax-act-smoke-input'),
      runFingerprint,
    ],
  );

  const runId = runResult.rows[0]?.id;

  if (!runId) {
    fail('TAX_ACT_SMOKE_RUN_INSERT_FAILED');
  }

  await client.query(
    `
      UPDATE publication_taxonomy_runs
      SET
        status = 'RUNNING',
        started_at = now()
      WHERE id = $1
    `,
    [runId],
  );

  const assertionResult = await client.query(
    `
      INSERT INTO publication_taxonomy_assertions (
        run_id,
        taxonomy_release_id,
        release_concept_id,
        confidence,
        decision_origin,
        reason_code
      )
      VALUES (
        $1,
        $2,
        $3,
        1,
        'RULE',
        'TAX_ACT_SMOKE'
      )
      RETURNING id
    `,
    [runId, RELEASE_ID, releaseConceptId],
  );

  const assertionId = assertionResult.rows[0]?.id;

  if (!assertionId) {
    fail('TAX_ACT_SMOKE_ASSERTION_INSERT_FAILED');
  }

  await client.query(
    `
      INSERT INTO publication_taxonomy_spans (
        assertion_id,
        excerpt,
        selector,
        source_fragment_hash
      )
      VALUES (
        $1,
        'tax-act-smoke',
        '{"field":"smoke"}'::jsonb,
        $2
      )
    `,
    [assertionId, sha256('tax-act-smoke')],
  );

  await client.query(
    `
      UPDATE publication_taxonomy_runs
      SET
        status = 'SUCCESS',
        finished_at = now()
      WHERE id = $1
    `,
    [runId],
  );

  const effective = await client.query(
    `
      SELECT count(*)::int AS n
      FROM v_publication_taxonomy_effective_assertions
      WHERE assertion_id = $1
    `,
    [assertionId],
  );

  assertEqual(effective.rows[0]?.n ?? -1, 1, 'TAX-07 effective assertion');

  const occurrenceResult = await client.query(
    `
      INSERT INTO taxonomy_unmapped_occurrences (
        run_id,
        raw_term,
        normalized_term,
        context_excerpt,
        extractor_key,
        extractor_version,
        confidence,
        occurrence_fingerprint,
        metadata
      )
      VALUES (
        $1,
        'TAX ACT smoke unmapped',
        'tax act smoke unmapped',
        'rollback-only production activation smoke',
        'tax-act-smoke',
        '1.0.0',
        1,
        $2,
        '{"smoke":true}'::jsonb
      )
      RETURNING id
    `,
    [runId, sha256('tax-act-occurrence:' + smokeSeed)],
  );

  const occurrenceId = occurrenceResult.rows[0]?.id;

  const candidateResult = await client.query(
    `
      INSERT INTO taxonomy_candidates (
        preferred_term,
        normalized_key,
        context_signature,
        jurisdiction_scope,
        candidate_fingerprint
      )
      VALUES (
        'TAX ACT smoke candidate',
        'tax act smoke candidate',
        $1,
        '{"scope":"smoke"}'::jsonb,
        $2
      )
      RETURNING id
    `,
    [
      sha256('tax-act-context:' + smokeSeed),
      sha256('tax-act-candidate:' + smokeSeed),
    ],
  );

  const candidateId = candidateResult.rows[0]?.id;

  if (!occurrenceId || !candidateId) {
    fail('TAX_ACT_SMOKE_CANDIDATE_INSERT_FAILED');
  }

  await client.query(
    `
      INSERT INTO taxonomy_candidate_occurrence_links (
        candidate_id,
        occurrence_id
      )
      VALUES ($1, $2)
    `,
    [candidateId, occurrenceId],
  );

  const candidateSmoke = await client.query(
    `
      SELECT
        c.status,
        count(l.id)::int AS active_links
      FROM taxonomy_candidates c
      JOIN taxonomy_candidate_occurrence_links l
        ON l.candidate_id = c.id
      WHERE c.id = $1
        AND l.link_status = 'ACTIVE'
      GROUP BY c.status
    `,
    [candidateId],
  );

  assertEqual(candidateSmoke.rows[0]?.status, 'NEW', 'TAX-08 candidate status');
  assertEqual(
    candidateSmoke.rows[0]?.active_links ?? -1,
    1,
    'TAX-08 active candidate link',
  );

  const nonexistentTenant =
    '00000000-0000-0000-0000-000000000000';

  await client.query(
    "SELECT set_config('app.tenant_id', $1, true)",
    [nonexistentTenant],
  );

  const privateVisibility = await client.query(
    'SELECT count(*)::int AS n FROM monitoring_profiles',
  );

  assertEqual(
    privateVisibility.rows[0]?.n ?? -1,
    0,
    'TAX-09 RLS nonexistent tenant visibility',
  );

  await client.query('ROLLBACK');

  const after = await activityCounts();

  assertEqual(after.runs, before.runs, 'post-smoke runs rollback');
  assertEqual(after.assertions, before.assertions, 'post-smoke assertions rollback');
  assertEqual(after.spans, before.spans, 'post-smoke spans rollback');
  assertEqual(after.unmapped, before.unmapped, 'post-smoke unmapped rollback');
  assertEqual(after.candidates, before.candidates, 'post-smoke candidates rollback');
  assertEqual(
    after.candidate_links,
    before.candidate_links,
    'post-smoke candidate links rollback',
  );

  let immutabilityBlocked = false;

  await client.query('BEGIN');

  try {
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    await client.query(
      `
        UPDATE taxonomy_releases
        SET change_notes = change_notes
        WHERE id = $1
      `,
      [RELEASE_ID],
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    immutabilityBlocked =
      message.includes('published taxonomy release only allows') ||
      message.includes('published taxonomy release semantic snapshot is immutable');
  } finally {
    await client.query('ROLLBACK');
  }

  assertEqual(
    immutabilityBlocked,
    true,
    'published release immutability trigger',
  );

  console.log(
    'TAX_ACT_VERIFY_RESULT=' +
      JSON.stringify({
        status: 'PASS',
        release: {
          id: release.id,
          status: release.status,
          approvedAt: release.approved_at,
          publishedAt: release.published_at,
          manifestSha256: release.manifest_sha256,
          derivationFingerprint: release.derivation_fingerprint,
        },
        migrations: migrationResult.rows.map((row) => row.filename),
        audit: auditResult.rows[0],
        currentPublished: publishedResult.rows[0]?.id,
        tax07: {
          effectiveAssertion: true,
          rollbackOnly: true,
        },
        tax08: {
          candidateStatus: 'NEW',
          activeLink: true,
          rollbackOnly: true,
        },
        tax09: {
          criteriaMatched: criteriaEvaluation.matched,
          conceptCode,
          nonexistentTenantVisibleProfiles: 0,
        },
        immutabilityBlocked,
        activityBefore: before,
        activityAfter: after,
      }),
  );
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {}

  console.error(
    'TAX_ACT_VERIFY_FAILED',
    error instanceof Error
      ? { message: error.message, details: error.details ?? null }
      : error,
  );

  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
