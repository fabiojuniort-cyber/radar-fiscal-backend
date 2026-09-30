import pg from 'pg';

const RELEASE_ID = '6e6ad5ff-fa6d-45dc-a3ea-ae4c5e4c2f3b';
const EXPECTED = Object.freeze({
  versionMajor: 1,
  versionMinor: 0,
  versionPatch: 0,
  manifestSha256: 'cdbad652dbafddef45193be9f5092ab17cb5097523085135e1f3b2ce00eb85ee',
  derivationFingerprint: 'ac315c0ad591836c8c98c03b04769aa8442ebec5409fd1fc5961dffc04a2414b',
  artifactRepository: 'fabiojuniort-cyber/tribusca-control',
  artifactPath: 'docs/taxonomy/TAX-02_DICIONARIO_FUNCIONAL_TAXONOMIA_TRIBUSCA_V1_R6.md',
  artifactGitSha: 'fee931cb212de808fa3fee1a06c833d746637c8c',
  artifactSha256: '7f68d7be2dfc5486f4fb5c88259de629976b1daa54b62cf9248f4e6efbbadfd2',
  dimensions: 20,
  concepts: 628,
  needsEvidence: 55,
  lexicalAliases: 21,
  aliasBindings: 23,
  relationTypes: 7,
  relationRules: 15,
  relations: 31,
});

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail('TAX_ACT_GUARD_FAILED: ' + label, { actual, expected });
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

try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('tribusca_taxonomy_release_v1_0_0'))",
  );

  const migrationResult = await client.query(
    `
      SELECT filename
      FROM schema_migrations
      WHERE filename IN (
        '020_taxonomy_classification.sql',
        '021_taxonomy_candidates.sql'
      )
      ORDER BY filename
    `,
  );

  assertEqual(
    migrationResult.rows.map((row) => row.filename).join(','),
    '020_taxonomy_classification.sql,021_taxonomy_candidates.sql',
    'migrations 020/021 must be applied before publishing',
  );

  const releaseResult = await client.query(
    `
      SELECT
        id,
        version_major,
        version_minor,
        version_patch,
        status,
        approved_at,
        published_at,
        artifact_repository,
        artifact_path,
        artifact_git_sha,
        artifact_sha256,
        manifest->>'manifestSha256' AS manifest_sha256,
        manifest->>'derivationFingerprint' AS derivation_fingerprint
      FROM taxonomy_releases
      WHERE id = $1
      FOR UPDATE
    `,
    [RELEASE_ID],
  );

  const release = releaseResult.rows[0];

  if (!release) {
    fail('TAX_ACT_RELEASE_NOT_FOUND', { releaseId: RELEASE_ID });
  }

  assertEqual(release.version_major, EXPECTED.versionMajor, 'version_major');
  assertEqual(release.version_minor, EXPECTED.versionMinor, 'version_minor');
  assertEqual(release.version_patch, EXPECTED.versionPatch, 'version_patch');
  assertEqual(release.artifact_repository, EXPECTED.artifactRepository, 'artifact_repository');
  assertEqual(release.artifact_path, EXPECTED.artifactPath, 'artifact_path');
  assertEqual(release.artifact_git_sha, EXPECTED.artifactGitSha, 'artifact_git_sha');
  assertEqual(release.artifact_sha256, EXPECTED.artifactSha256, 'artifact_sha256');
  assertEqual(release.manifest_sha256, EXPECTED.manifestSha256, 'manifestSha256');
  assertEqual(release.derivation_fingerprint, EXPECTED.derivationFingerprint, 'derivationFingerprint');

  const otherPublished = await client.query(
    `
      SELECT count(*)::int AS n
      FROM taxonomy_releases
      WHERE status = 'PUBLISHED'
        AND id <> $1
    `,
    [RELEASE_ID],
  );

  assertEqual(otherPublished.rows[0]?.n ?? -1, 0, 'other published releases');

  const countsResult = await client.query(
    `
      SELECT
        (SELECT count(*)::int FROM taxonomy_release_dimensions WHERE release_id = $1) AS dimensions,
        (SELECT count(*)::int FROM taxonomy_release_concepts WHERE release_id = $1) AS concepts,
        (
          SELECT count(*)::int
          FROM taxonomy_release_concepts rc
          JOIN taxonomy_concept_revisions cr
            ON cr.id = rc.concept_revision_id
          WHERE rc.release_id = $1
            AND cr.evidence_status = 'NEEDS_EVIDENCE'
        ) AS needs_evidence,
        (
          SELECT count(DISTINCT alias_id)::int
          FROM taxonomy_release_alias_bindings
          WHERE release_id = $1
        ) AS lexical_aliases,
        (SELECT count(*)::int FROM taxonomy_release_alias_bindings WHERE release_id = $1) AS alias_bindings,
        (SELECT count(*)::int FROM taxonomy_relation_types) AS relation_types,
        (SELECT count(*)::int FROM taxonomy_release_relation_rules WHERE release_id = $1) AS relation_rules,
        (SELECT count(*)::int FROM taxonomy_concept_relations WHERE release_id = $1) AS relations,
        (SELECT count(*)::int FROM publication_taxonomy_runs) AS classification_runs,
        (SELECT count(*)::int FROM taxonomy_unmapped_occurrences) AS unmapped_occurrences,
        (SELECT count(*)::int FROM taxonomy_candidates) AS candidates
    `,
    [RELEASE_ID],
  );

  const counts = countsResult.rows[0];

  assertEqual(counts.dimensions, EXPECTED.dimensions, 'dimensions');
  assertEqual(counts.concepts, EXPECTED.concepts, 'concepts');
  assertEqual(counts.needs_evidence, EXPECTED.needsEvidence, 'NEEDS_EVIDENCE');
  assertEqual(counts.lexical_aliases, EXPECTED.lexicalAliases, 'lexical aliases');
  assertEqual(counts.alias_bindings, EXPECTED.aliasBindings, 'alias bindings');
  assertEqual(counts.relation_types, EXPECTED.relationTypes, 'relation types');
  assertEqual(counts.relation_rules, EXPECTED.relationRules, 'relation rules');
  assertEqual(counts.relations, EXPECTED.relations, 'relations');
  assertEqual(counts.classification_runs, 0, 'classification runs before publication');
  assertEqual(counts.unmapped_occurrences, 0, 'unmapped occurrences before publication');
  assertEqual(counts.candidates, 0, 'candidates before publication');

  if (release.status === 'PUBLISHED') {
    if (!release.approved_at || !release.published_at) {
      fail('TAX_ACT_ALREADY_PUBLISHED_WITH_INVALID_TIMESTAMPS');
    }

    await client.query('COMMIT');

    console.log(
      'TAX_ACT_PUBLISH_RESULT=' +
        JSON.stringify({
          status: 'IDEMPOTENT_ALREADY_PUBLISHED',
          releaseId: RELEASE_ID,
          releaseStatus: release.status,
          manifestSha256: release.manifest_sha256,
          derivationFingerprint: release.derivation_fingerprint,
          counts,
        }),
    );

    process.exit(0);
  }

  assertEqual(release.status, 'DRAFT', 'release must start in DRAFT');

  await client.query('SET LOCAL ROLE radar_taxonomy_curator');

  const roleResult = await client.query('SELECT current_user');
  assertEqual(
    roleResult.rows[0]?.current_user,
    'radar_taxonomy_curator',
    'curator role',
  );

  const toReview = await client.query(
    `
      UPDATE taxonomy_releases
      SET status = 'IN_REVIEW'
      WHERE id = $1
        AND status = 'DRAFT'
      RETURNING id
    `,
    [RELEASE_ID],
  );
  assertEqual(toReview.rowCount, 1, 'DRAFT -> IN_REVIEW');

  const toApproved = await client.query(
    `
      UPDATE taxonomy_releases
      SET
        status = 'APPROVED',
        approved_at = now()
      WHERE id = $1
        AND status = 'IN_REVIEW'
      RETURNING id, approved_at
    `,
    [RELEASE_ID],
  );
  assertEqual(toApproved.rowCount, 1, 'IN_REVIEW -> APPROVED');

  const toPublished = await client.query(
    `
      UPDATE taxonomy_releases
      SET
        status = 'PUBLISHED',
        published_at = now()
      WHERE id = $1
        AND status = 'APPROVED'
      RETURNING
        id,
        status,
        approved_at,
        published_at,
        manifest->>'manifestSha256' AS manifest_sha256,
        manifest->>'derivationFingerprint' AS derivation_fingerprint
    `,
    [RELEASE_ID],
  );
  assertEqual(toPublished.rowCount, 1, 'APPROVED -> PUBLISHED');

  const published = toPublished.rows[0];

  await client.query(
    `
      INSERT INTO audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        after_data,
        request_id
      )
      VALUES (
        NULL,
        'ADMIN',
        'TAX-ACT#46',
        'TAXONOMY_RELEASE_PUBLISHED',
        'taxonomy_release',
        $1,
        $2::jsonb,
        $3::jsonb,
        'tribusca-control#46'
      )
    `,
    [
      RELEASE_ID,
      JSON.stringify({
        status: 'DRAFT',
        manifestSha256: EXPECTED.manifestSha256,
        derivationFingerprint: EXPECTED.derivationFingerprint,
      }),
      JSON.stringify({
        status: 'PUBLISHED',
        approvedAt: published.approved_at,
        publishedAt: published.published_at,
        manifestSha256: published.manifest_sha256,
        derivationFingerprint: published.derivation_fingerprint,
      }),
    ],
  );

  await client.query('COMMIT');

  const finalResult = await client.query(
    `
      SELECT
        status,
        approved_at,
        published_at,
        manifest->>'manifestSha256' AS manifest_sha256,
        manifest->>'derivationFingerprint' AS derivation_fingerprint
      FROM taxonomy_releases
      WHERE id = $1
    `,
    [RELEASE_ID],
  );

  const finalRelease = finalResult.rows[0];

  assertEqual(finalRelease?.status, 'PUBLISHED', 'final release status');
  assertEqual(finalRelease?.manifest_sha256, EXPECTED.manifestSha256, 'final manifestSha256');
  assertEqual(finalRelease?.derivation_fingerprint, EXPECTED.derivationFingerprint, 'final derivationFingerprint');

  console.log(
    'TAX_ACT_PUBLISH_RESULT=' +
      JSON.stringify({
        status: 'PUBLISHED',
        releaseId: RELEASE_ID,
        releaseStatus: finalRelease.status,
        approvedAt: finalRelease.approved_at,
        publishedAt: finalRelease.published_at,
        manifestSha256: finalRelease.manifest_sha256,
        derivationFingerprint: finalRelease.derivation_fingerprint,
        counts,
      }),
  );
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {}

  console.error(
    'TAX_ACT_PUBLISH_FAILED',
    error instanceof Error
      ? { message: error.message, details: error.details ?? null }
      : error,
  );

  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
