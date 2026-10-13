import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';

test('F2 staging source projection is SELECT-only and not directly readable by runtime', async () => {
  const connectionString = process.env.DATABASE_ADMIN_URL;
  assert.ok(connectionString, 'DATABASE_ADMIN_URL required for isolated PG18 check');
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const allowed = await client.query<{
      app_view_select: boolean;
      app_view_insert: boolean;
      app_source_select: boolean;
      worker_view_select: boolean;
    }>(`SELECT
      has_table_privilege('radar_app_runtime',
        'taxonomy_f2_segment_suggestions_readonly','SELECT') AS app_view_select,
      has_table_privilege('radar_app_runtime',
        'taxonomy_f2_segment_suggestions_readonly','INSERT') AS app_view_insert,
      has_table_privilege('radar_app_runtime',
        'taxonomy_f2_import_segment_rows','SELECT') AS app_source_select,
      has_table_privilege('radar_worker_runtime',
        'taxonomy_f2_segment_suggestions_readonly','SELECT') AS worker_view_select`);
    assert.deepEqual(allowed.rows[0], {
      app_view_select: true, app_view_insert: false,
      app_source_select: false, worker_view_select: false,
    });

    await client.query('BEGIN READ ONLY');
    try {
      await client.query('SET LOCAL ROLE radar_app_runtime');
      const projection = await client.query('SELECT cnae_code, atuacao, suggested_products, suggested_ncms, source_sha256, source_batch_id FROM taxonomy_f2_segment_suggestions_readonly');
      assert.equal(projection.rowCount, 0, 'no staging writes are permitted in this test');
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
    await pool.end();
  }
});
