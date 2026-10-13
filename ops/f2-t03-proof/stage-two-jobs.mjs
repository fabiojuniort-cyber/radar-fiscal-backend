// Isolated PostgreSQL 18 proof only. Never execute against production.
// The writer independently enforces NODE_ENV, F2_IMPORT_SCOPE and database name.
import assert from 'node:assert/strict';
import pg from 'pg';
import { parseApprovedWorkbook } from '../taxonomy/f2-xlsx-dry-run.mjs';
import { makeF2StagingPayload } from '../taxonomy/f2-stage-payload.mjs';
import { stageF2Payload } from '../taxonomy/f2-stage-persist.mjs';
import { verifyF2StageReadback } from '../taxonomy/f2-stage-readback.mjs';

const [segmentoPath, produtoPath] = process.argv.slice(2);
assert.ok(segmentoPath && produtoPath, 'APPROVED_XLSX_PATHS_REQUIRED');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.F2_IMPORT_SCOPE, 'ISOLATED_POSTGRES18_ONLY');

const [segmento, produto] = await Promise.all([
  parseApprovedWorkbook(segmentoPath, 'segmento'),
  parseApprovedWorkbook(produtoPath, 'produto'),
]);
const payload = makeF2StagingPayload(segmento.rows, produto.rows);
assert.equal(payload.summary.errors, 0);
assert.equal(payload.summary.warnings, 448);
assert.equal(payload.summary.segmentRows, 1332);
assert.equal(payload.summary.productRows, 4225);

const split = x => String(x ?? '').split(';').map(s => s.trim()).filter(Boolean);
const stats = { productEntries: 0, productCnaes: 0, ncmEntries: 0, ncmCnaes: 0 };
for (const row of payload.segments) {
  const products = split(row.raw_cells[6]);
  const ncms = split(row.raw_cells[7]);
  if (products.length) { stats.productCnaes++; stats.productEntries += products.length; }
  if (ncms.length) { stats.ncmCnaes++; stats.ncmEntries += ncms.length; }
}
assert.deepEqual(stats, {
  productEntries: 4545, productCnaes: 738, ncmEntries: 5198, ncmCnaes: 645,
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
try {
  const before = await pool.query(
    "SELECT current_database() AS name,current_setting('server_version_num')::integer AS version",
  );
  assert.equal(before.rows[0]?.name, 'radar_fiscal_test');
  assert.ok(before.rows[0]?.version >= 180000, 'TEMP_POSTGRES18_REQUIRED');
  const first = await stageF2Payload(pool, payload);
  assert.equal(first.firstRun, true, 'ISOLATED_DB_ALREADY_HAS_APPROVED_BATCH');
  assert.equal(first.insertedBatches, 1);
  assert.equal(first.insertedSegments, 1332);
  assert.equal(first.insertedProducts, 4225);
  assert.equal(first.liveTaxonomyChanges, 0);
  console.log('F2_T03_JOB1=' + JSON.stringify({ ...first, suggestions: stats }));

  const second = await stageF2Payload(pool, payload);
  assert.equal(second.batchId, first.batchId);
  assert.equal(second.firstRun, false);
  assert.equal(second.insertedBatches, 0);
  assert.equal(second.insertedSegments, 0);
  assert.equal(second.insertedProducts, 0);
  assert.equal(second.liveTaxonomyChanges, 0);
  console.log('F2_T03_JOB2=' + JSON.stringify(second));

  const client = await pool.connect();
  try {
    await verifyF2StageReadback(client, first.batchId, payload);
    const originals = new Map(payload.segments.map(s => [s.cnae_code, s]));
    const result = await client.query(
      "SELECT cnae_code,raw_cells,row_sha256 FROM taxonomy_f2_import_segment_rows WHERE batch_id=$1::uuid",
      [first.batchId],
    );
    let divergences = 0;
    for (const row of result.rows) {
      const source = originals.get(row.cnae_code);
      if (!source || row.raw_cells[6] !== source.raw_cells[6] ||
          row.raw_cells[7] !== source.raw_cells[7] ||
          row.row_sha256 !== source.row_sha256) divergences++;
    }
    assert.equal(result.rowCount, 1332);
    assert.equal(divergences, 0);
    console.log('F2_T03_READBACK=' + JSON.stringify({
      segments: result.rowCount, products: payload.products.length,
      suggestions: stats, ghDivergences: divergences,
      fullCellsVerified: true, secondJobInsertions: 0, secondJobChanges: 0,
    }));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
