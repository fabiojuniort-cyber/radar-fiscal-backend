import {
  assertBaselineSemanticReadback,
  readBaselineState,
} from '../../modules/taxonomy/baseline/baseline.readback.js';
import {
  loadBaseline,
} from '../../modules/taxonomy/baseline/baseline.source-reader.js';
import {
  createBaselinePool,
} from './taxonomy-baseline-cli-common.js';

const EXPECTED_RELEASE_ID =
  '6e6ad5ff-fa6d-45dc-a3ea-ae4c5e4c2f3b';
const EXPECTED_VERSION = 'v1.0.0';
const EXPECTED_ARTIFACT_REPOSITORY =
  'fabiojuniort-cyber/radar-fiscal-backend';
const EXPECTED_ARTIFACT_PATH =
  'docs/taxonomy/baseline/TAXONOMY_BASELINE_V1_MANIFEST.json';
const EXPECTED_ARTIFACT_GIT_SHA =
  '25c2c42ed43d001dcfa1eb0edc9ce4fa35fffbe7';

function assertExpectedState(
  state: Awaited<ReturnType<typeof readBaselineState>>,
  loaded: Awaited<ReturnType<typeof loadBaseline>>,
  allowedStatuses: readonly string[],
): void {
  const expected = loaded.manifest.expected;

  const checks: Array<[string, unknown, unknown]> = [
    ['dimensions', state.dimensions, expected.dimensions],
    ['concepts', state.concepts, expected.concepts],
    ['needsEvidence', state.needsEvidence, expected.needsEvidence],
    ['lexicalAliases', state.lexicalAliases, expected.lexicalAliasCount],
    ['aliasBindings', state.aliasBindings, expected.aliasBindingCount],
    ['relationTypes', state.relationTypes, loaded.manifest.relationTypes.length],
    ['relationRules', state.relationRules, loaded.manifest.relationRules.length],
    ['relations', state.relations, loaded.manifest.relations.length],
    ['creditAliasIdentities', state.creditAliasIdentities, 1],
    ['creditAmbiguousBindings', state.creditAmbiguousBindings, 3],
    ['forbiddenMit', state.forbiddenMit, 0],
    ['releaseVersion', state.releaseVersion, EXPECTED_VERSION],
    ['manifestSha256', state.manifestSha256, loaded.manifestSha256],
    [
      'derivationFingerprint',
      state.derivationFingerprint,
      loaded.manifest.derivation.fingerprint,
    ],
  ];

  for (const [label, actual, wanted] of checks) {
    if (actual !== wanted) {
      throw new Error(
        'TAX_ACT_RELEASE_GUARD_MISMATCH: ' +
          label +
          ' actual=' +
          String(actual) +
          ' expected=' +
          String(wanted),
      );
    }
  }

  if (
    state.releaseStatus === null ||
    !allowedStatuses.includes(state.releaseStatus)
  ) {
    throw new Error(
      'TAX_ACT_RELEASE_STATUS_MISMATCH: actual=' +
        String(state.releaseStatus) +
        ' allowed=' +
        allowedStatuses.join(','),
    );
  }
}

const loaded = await loadBaseline();

if (
  loaded.manifestSha256 !==
  'cdbad652dbafddef45193be9f5092ab17cb5097523085135e1f3b2ce00eb85ee'
) {
  throw new Error('TAX_ACT_MANIFEST_HASH_MISMATCH');
}

if (
  loaded.manifest.derivation.fingerprint !==
  'ac315c0ad591836c8c98c03b04769aa8442ebec5409fd1fc5961dffc04a2414b'
) {
  throw new Error('TAX_ACT_DERIVATION_MISMATCH');
}

const pool = createBaselinePool({
  requireAdmin: true,
});

try {
  const client = await pool.connect();

  try {
    await client.query(
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('tribusca-taxonomy-release-v1.0.0', 0))",
    );
    await client.query(
      'SET LOCAL ROLE radar_taxonomy_curator',
    );

    const release = await client.query<{
      id: string;
      version: string;
      status: string;
      artifact_repository: string | null;
      artifact_path: string | null;
      artifact_git_sha: string | null;
      artifact_sha256: string | null;
    }>(
      [
        'SELECT',
        '  id, version, status, artifact_repository,',
        '  artifact_path, artifact_git_sha, artifact_sha256',
        'FROM taxonomy_releases',
        'WHERE version_major = 1',
        '  AND version_minor = 0',
        '  AND version_patch = 0',
        'FOR UPDATE',
      ].join('\n'),
    );

    const row = release.rows[0];

    if (!row) {
      throw new Error(
        'TAX_ACT_RELEASE_NOT_FOUND',
      );
    }

    if (
      row.id !== EXPECTED_RELEASE_ID ||
      row.version !== EXPECTED_VERSION
    ) {
      throw new Error(
        'TAX_ACT_RELEASE_IDENTITY_MISMATCH',
      );
    }

    const before = await readBaselineState(client);
    assertExpectedState(
      before,
      loaded,
      ['DRAFT', 'PUBLISHED'],
    );
    await assertBaselineSemanticReadback(
      client,
      loaded.manifest,
      row.id,
    );

    if (row.status === 'PUBLISHED') {
      if (
        row.artifact_repository !==
          EXPECTED_ARTIFACT_REPOSITORY ||
        row.artifact_path !==
          EXPECTED_ARTIFACT_PATH ||
        row.artifact_git_sha !==
          EXPECTED_ARTIFACT_GIT_SHA ||
        row.artifact_sha256 !==
          loaded.manifestSha256
      ) {
        throw new Error(
          'TAX_ACT_PUBLISHED_ARTIFACT_MISMATCH',
        );
      }

      await client.query('ROLLBACK');

      console.log(
        'TAX_ACT_RELEASE_PUBLISH=' +
          JSON.stringify({
            disposition: 'ALREADY_PUBLISHED',
            releaseId: row.id,
            version: row.version,
            status: row.status,
            manifestSha256:
              loaded.manifestSha256,
            derivationFingerprint:
              loaded.manifest.derivation.fingerprint,
          }),
      );
    } else {
      if (row.status !== 'DRAFT') {
        throw new Error(
          'TAX_ACT_RELEASE_NOT_DRAFT',
        );
      }

      const updated = await client.query<{
        id: string;
        version: string;
        status: string;
      }>(
        [
          'UPDATE taxonomy_releases',
          "SET status = 'PUBLISHED',",
          '    approved_at = now(),',
          '    published_at = now(),',
          '    artifact_repository = $2,',
          '    artifact_path = $3,',
          '    artifact_git_sha = $4,',
          '    artifact_sha256 = $5',
          'WHERE id = $1',
          "  AND status = 'DRAFT'",
          'RETURNING id, version, status',
        ].join('\n'),
        [
          row.id,
          EXPECTED_ARTIFACT_REPOSITORY,
          EXPECTED_ARTIFACT_PATH,
          EXPECTED_ARTIFACT_GIT_SHA,
          loaded.manifestSha256,
        ],
      );

      if (
        updated.rows.length !== 1 ||
        updated.rows[0]?.status !== 'PUBLISHED'
      ) {
        throw new Error(
          'TAX_ACT_RELEASE_PUBLISH_UPDATE_FAILED',
        );
      }

      const after = await readBaselineState(client);
      assertExpectedState(
        after,
        loaded,
        ['PUBLISHED'],
      );
      await assertBaselineSemanticReadback(
        client,
        loaded.manifest,
        row.id,
      );

      await client.query('COMMIT');

      console.log(
        'TAX_ACT_RELEASE_PUBLISH=' +
          JSON.stringify({
            disposition: 'PUBLISHED',
            releaseId: row.id,
            version: row.version,
            status: 'PUBLISHED',
            manifestSha256:
              loaded.manifestSha256,
            derivationFingerprint:
              loaded.manifest.derivation.fingerprint,
            artifactRepository:
              EXPECTED_ARTIFACT_REPOSITORY,
            artifactPath:
              EXPECTED_ARTIFACT_PATH,
            artifactGitSha:
              EXPECTED_ARTIFACT_GIT_SHA,
          }),
      );
    }
  } catch (error) {
    await client
      .query('ROLLBACK')
      .catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
