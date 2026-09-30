import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool } from 'pg';

import {
  importBaseline,
} from '../src/modules/taxonomy/baseline/baseline.importer.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';

const TABLES = [
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

async function reset(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE ' +
      TABLES.map((name) => '"' + name + '"').join(', ') +
      ' CASCADE',
  );
  await pool.query(
    "DELETE FROM audit_log WHERE entity_type = 'taxonomy_baseline'",
  );
}

test('concurrent baseline imports have one lock winner', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required');

  const pool = new Pool({
    connectionString: adminUrl,
    max: 6,
  });

  try {
    await reset(pool);
    const loaded = await loadBaseline();

    const first = importBaseline(
      pool,
      loaded,
      {
        expectedManifestSha256:
          loaded.manifestSha256,
        holdAfterLockMs: 500,
      },
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 75),
    );

    const second = importBaseline(
      pool,
      loaded,
      {
        expectedManifestSha256:
          loaded.manifestSha256,
      },
    );

    const results = await Promise.allSettled([
      first,
      second,
    ]);

    const fulfilled = results.filter(
      (result) => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result) => result.status === 'rejected',
    );

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const winner = fulfilled[0];
    assert.equal(winner?.status, 'fulfilled');

    if (winner?.status === 'fulfilled') {
      assert.equal(winner.value.status, 'SUCCESS');
    }

    const loser = rejected[0];
    assert.equal(loser?.status, 'rejected');

    if (loser?.status === 'rejected') {
      assert.match(
        String(loser.reason),
        /BASELINE_IMPORT_IN_PROGRESS/,
      );
    }

    const releases = await pool.query<{
      count: string;
    }>(
      [
        'SELECT count(*)::text AS count',
        'FROM taxonomy_releases',
        'WHERE version_major = 1',
        '  AND version_minor = 0',
        '  AND version_patch = 0',
      ].join('\n'),
    );

    assert.equal(
      Number(releases.rows[0]?.count ?? 0),
      1,
    );
  } finally {
    await pool.end();
  }
});
