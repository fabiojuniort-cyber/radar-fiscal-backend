/** Read back every cell to prove the staging import did not truncate data. */
export async function verifyF2StageReadback(client, batchId, payload) {
  const a = await client.query(
    'SELECT * FROM taxonomy_f2_import_segment_rows WHERE batch_id=$1::uuid ORDER BY source_line',
    [batchId],
  );
  const b = await client.query(
    'SELECT * FROM taxonomy_f2_import_product_rows WHERE batch_id=$1::uuid ORDER BY source_line',
    [batchId],
  );
  if (a.rows.length !== 1332 || b.rows.length !== 3793)
    throw new Error('F2_STAGE_READBACK_COUNT_MISMATCH');
  for (let i = 0; i < a.rows.length; i++) {
    const got = a.rows[i], expected = payload.segments[i];
    if (got.source_line !== expected.source_line ||
        got.cnae_code !== expected.cnae_code ||
        got.atuacao !== expected.atuacao ||
        got.row_sha256 !== expected.row_sha256 ||
        JSON.stringify(got.raw_cells) !== JSON.stringify(expected.raw_cells)) {
      throw new Error('F2_STAGE_SEGMENTO_READBACK_MISMATCH_' + expected.source_line);
    }
  }
  for (let i = 0; i < b.rows.length; i++) {
    const got = b.rows[i], expected = payload.products[i];
    if (got.source_line !== expected.source_line ||
        got.product_code !== expected.product_code ||
        got.segmento !== expected.segmento ||
        got.grupo !== expected.grupo ||
        got.item !== expected.item ||
        got.row_sha256 !== expected.row_sha256 ||
        JSON.stringify(got.ncm_normalized) !== JSON.stringify(expected.ncm_normalized) ||
        JSON.stringify(got.raw_cells) !== JSON.stringify(expected.raw_cells)) {
      throw new Error('F2_STAGE_PRODUCT_READBACK_MISMATCH_' + expected.source_line);
    }
  }
}
