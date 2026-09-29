import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  dryRunBaseline,
} from '../src/modules/taxonomy/baseline/baseline.database-inspector.js';
import {
  importBaseline,
} from '../src/modules/taxonomy/baseline/baseline.importer.js';
import {
  readBaselineState,
} from '../src/modules/taxonomy/baseline/baseline.readback.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';

const TAXONOMY_TABLES = [
  'taxonomy_official_mapping_evidence',
  'taxonomy_official_mappings',
  'official_catalog_entries',
  'official_catalog_editions',
  'official_catalogs',
  'taxonomy_relation_evidence',
  'taxonomy_alias_binding_evidence',
  'taxonomy_concept_revision_evidence',
  'taxonomy_evidence',
  'taxonomy_concept_relations',
  'taxonomy_release_relation_rules',
  'taxonomy_relation_types',
  'taxonomy_release_alias_bindings',
  'taxonomy_aliases',
  'taxonomy_release_concepts',
  'taxonomy_concept_revisions',
  'taxonomy_concepts',
  'taxonomy_release_dimensions',
  'taxonomy_dimension_revisions',
  'taxonomy_dimensions',
  'taxonomy_releases',
] as const;

async function resetBaseline(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE ' +
      TAXONOMY_TABLES.map((name) => '"' + name + '"').join(', ') +
      ' CASCADE',
  );
  await pool.query(
    "DELETE FROM audit_log WHERE entity_type = 'taxonomy_baseline'",
  );
}

async function exactCounts(
  pool: Pool,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  for (const table of TAXONOMY_TABLES) {
    const row = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "' +
        table +
        '"',
    );
    result[table] = Number(row.rows[0]?.count ?? 0);
  }

  const audit = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_log WHERE entity_type = 'taxonomy_baseline'",
  );
  result.audit_log_taxonomy_baseline = Number(
    audit.rows[0]?.count ?? 0,
  );

  return result;
}

test('TAX-06 baseline dry-run/import/idempotency/rollback', async (t) => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({
    connectionString: adminUrl,
    max: 4,
  });

  try {
    const loaded = await loadBaseline();

    await t.test('dry-run performs zero writes and reports READY', async () => {
      await resetBaseline(pool);
      const before = await exactCounts(pool);

      const report = await dryRunBaseline(
        pool,
        loaded,
      );

      const after = await exactCounts(pool);

      assert.equal(report.readiness, 'READY');
      assert.equal(report.sourceIntegrity, 'PASS');
      assert.equal(report.counts.dimensions, 20);
      assert.equal(report.counts.concepts, 628);
      assert.equal(report.counts.needsEvidence, 55);
      assert.equal(report.counts.lexicalAliases, 21);
      assert.equal(report.counts.aliasBindings, 23);
      assert.equal(report.counts.multiBindAliases, 1);
      assert.equal(
        report.plan.releaseAction,
        'CREATE_RELEASE',
      );
      assert.equal(
        report.plan.summary.newIdentities,
        648,
      );
      assert.equal(
        report.plan.summary.newRevisions,
        648,
      );
      assert.deepEqual(after, before);
    });

    await t.test('first import materializes exact DRAFT baseline', async () => {
      await resetBaseline(pool);

      const result = await importBaseline(
        pool,
        loaded,
        {
          expectedManifestSha256:
            loaded.manifestSha256,
        },
      );

      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.readback.dimensions, 20);
      assert.equal(result.readback.concepts, 628);
      assert.equal(result.readback.needsEvidence, 55);
      assert.equal(result.readback.lexicalAliases, 21);
      assert.equal(result.readback.aliasBindings, 23);
      assert.equal(result.readback.relationTypes, 7);
      assert.equal(
        result.readback.relationRules,
        loaded.manifest.relationRules.length,
      );
      assert.equal(
        result.readback.relations,
        loaded.manifest.relations.length,
      );
      assert.equal(
        result.readback.creditAliasIdentities,
        1,
      );
      assert.equal(
        result.readback.creditAmbiguousBindings,
        3,
      );
      assert.equal(result.readback.forbiddenMit, 0);
      assert.equal(
        result.readback.releaseVersion,
        'v1.0.0',
      );
      assert.equal(
        result.readback.releaseStatus,
        'DRAFT',
      );
      assert.equal(
        result.readback.manifestSha256,
        loaded.manifestSha256,
      );

      const audit = await pool.query<{
        action: string;
      }>(
        [
          'SELECT action',
          'FROM audit_log',
          "WHERE entity_type = 'taxonomy_baseline'",
          'ORDER BY occurred_at, action',
        ].join('\n'),
      );

      const actions = new Set(
        audit.rows.map((row) => row.action),
      );
      assert.ok(
        actions.has('BASELINE_IMPORT_STARTED'),
      );
      assert.ok(
        actions.has('BASELINE_IMPORT_VALIDATED'),
      );
      assert.ok(
        actions.has('BASELINE_IMPORT_COMMITTED'),
      );
      assert.ok(
        actions.has('TAXONOMY_RELEASE_CREATED'),
      );
    });

    await t.test('identical rerun is idempotent with zero new canonical rows', async () => {
      const before = await exactCounts(pool);

      const result = await importBaseline(
        pool,
        loaded,
        {
          expectedManifestSha256:
            loaded.manifestSha256,
        },
      );

      const after = await exactCounts(pool);

      assert.equal(
        result.status,
        'IDEMPOTENT_ALREADY_IMPORTED',
      );
      assert.deepEqual(after, before);
    });

    await t.test('idempotent rerun rejects same-count semantic drift', async () => {
      await pool.query(
        [
          'UPDATE taxonomy_concept_relations',
          "SET status = 'APPROVED'",
          'WHERE id = (',
          '  SELECT id',
          '  FROM taxonomy_concept_relations',
          '  ORDER BY id',
          '  LIMIT 1',
          ')',
        ].join('\n'),
      );

      await assert.rejects(
        importBaseline(pool, loaded, {
          expectedManifestSha256:
            loaded.manifestSha256,
        }),
        /BASELINE_SEMANTIC_READBACK_MISMATCH/,
      );
    });

    await t.test('same target with different stored fingerprint is blocked', async () => {
      await pool.query(
        [
          'UPDATE taxonomy_releases',
          "SET manifest = jsonb_set(manifest, '{derivationFingerprint}', to_jsonb('different'::text))",
          'WHERE version_major = 1',
          '  AND version_minor = 0',
          '  AND version_patch = 0',
        ].join('\n'),
      );

      await assert.rejects(
        importBaseline(pool, loaded, {
          expectedManifestSha256:
            loaded.manifestSha256,
        }),
        /TARGET_VERSION_ALREADY_BOUND/,
      );
    });

    await t.test('wrong explicit manifest hash is blocked before transaction', async () => {
      await assert.rejects(
        importBaseline(pool, loaded, {
          expectedManifestSha256: '0'.repeat(64),
        }),
        /MANIFEST_INTEGRITY_FAILURE/,
      );
    });

    await t.test('mid-load failure rolls back all canonical baseline data', async () => {
      await resetBaseline(pool);

      await assert.rejects(
        importBaseline(pool, loaded, {
          expectedManifestSha256:
            loaded.manifestSha256,
          failAfterStep: 'ALIASES',
        }),
        /BASELINE_TEST_FAILURE_INJECTION/,
      );

      const counts = await exactCounts(pool);

      for (const table of TAXONOMY_TABLES) {
        assert.equal(
          counts[table],
          0,
          table,
        );
      }

      assert.equal(
        counts.audit_log_taxonomy_baseline,
        1,
      );

      const failureAudit = await pool.query<{
        action: string;
      }>(
        [
          'SELECT action',
          'FROM audit_log',
          "WHERE entity_type = 'taxonomy_baseline'",
        ].join('\n'),
      );

      assert.deepEqual(
        failureAudit.rows.map((row) => row.action),
        ['BASELINE_IMPORT_FAILED'],
      );

      const retry = await importBaseline(
        pool,
        loaded,
        {
          expectedManifestSha256:
            loaded.manifestSha256,
        },
      );
      assert.equal(retry.status, 'SUCCESS');
    });

    await t.test('read-back helper reproduces imported fingerprint', async () => {
      const client = await pool.connect();

      try {
        const state = await readBaselineState(client);
        assert.equal(state.dimensions, 20);
        assert.equal(state.concepts, 628);
        assert.equal(state.needsEvidence, 55);
        assert.equal(state.lexicalAliases, 21);
        assert.equal(state.aliasBindings, 23);
        assert.equal(
          state.manifestSha256,
          loaded.manifestSha256,
        );
        assert.equal(
          state.derivationFingerprint,
          loaded.manifest.derivation.fingerprint,
        );
      } finally {
        client.release();
      }
    });
  } finally {
    await pool.end();
  }
});
