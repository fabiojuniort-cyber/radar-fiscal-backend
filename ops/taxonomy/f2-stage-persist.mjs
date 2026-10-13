import { verifyF2StageReadback } from './f2-stage-readback.mjs';

/**
 * Fully transactional, lossless stage writer on *isolated* PG18 only.
 * A production authorization path is intentionally absent.
 */
export async function stageF2Payload(pool, payload) {
  if (process.env.F2_IMPORT_SCOPE !== 'ISOLATED_POSTGRES18_ONLY' ||
      process.env.NODE_ENV !== 'test') {
    throw new Error('F2_PRODUCTION_LOAD_FORBIDDEN');
  }
  const client = await pool.connect();
  let begun = false;
  try {
    const version = await client.query(
      "SELECT current_database() AS db,current_setting('server_version_num')::integer AS version",
    );
    if (version.rows[0]?.db !== 'radar_fiscal_test' ||
        version.rows[0]?.version < 180000) throw new Error('F2_PG18_ISOLATION_REQUIRED');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    begun = true;
    await client.query('SELECT pg_advisory_xact_lock(2026, 20303)');
    const existing = await client.query(
      'SELECT id,content_sha256,segmento_rows,produto_rows,expected_warnings ' +
      'FROM taxonomy_f2_import_batches ' +
      'WHERE segmento_sha256=$1 AND produto_sha256=$2 FOR UPDATE',
      [payload.hashes.segmentoSha256, payload.hashes.produtoSha256],
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.content_sha256 !== payload.contentSha256 ||
          row.segmento_rows !== payload.summary.segmentRows ||
          row.produto_rows !== payload.summary.productRows ||
          row.expected_warnings !== payload.summary.warnings) throw new Error('F2_EXISTING_BATCH_CONFLICT');
      await verifyF2StageReadback(client, row.id, payload);
      await client.query('COMMIT');
      begun = false;
      return { batchId: row.id, firstRun: false, insertedBatches: 0,
        insertedSegments: 0, insertedProducts: 0,
        errors: 0, warnings: payload.summary.warnings, liveTaxonomyChanges: 0 };
    }

    const batch = await client.query(
      'INSERT INTO taxonomy_f2_import_batches ' +
      '(segmento_sha256,produto_sha256,content_sha256,segmento_rows,produto_rows,expected_warnings) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [payload.hashes.segmentoSha256,payload.hashes.produtoSha256,payload.contentSha256,
        payload.summary.segmentRows,payload.summary.productRows,payload.summary.warnings],
    );
    const batchId = batch.rows[0].id;
    const eachChunk = (values, size=150) =>
      Array.from({length: Math.ceil(values.length / size)},
        (_,i) => values.slice(i * size, (i + 1) * size));
    let insertedSegments = 0, insertedProducts = 0;

    for (const chunk of eachChunk(payload.segments)) {
      const result = await client.query(
        'INSERT INTO taxonomy_f2_import_segment_rows ' +
        '(batch_id,source_line,cnae_code,atuacao,raw_cells,row_sha256) ' +
        'SELECT $1::uuid,s.source_line,s.cnae_code,s.atuacao,s.raw_cells,s.row_sha256 ' +
        'FROM jsonb_to_recordset($2::jsonb) ' +
        'AS s(source_line integer,cnae_code text,atuacao text,raw_cells jsonb,row_sha256 text)',
        [batchId,JSON.stringify(chunk)],
      );
      insertedSegments += result.rowCount;
    }
    for (const chunk of eachChunk(payload.products)) {
      const result = await client.query(
        'INSERT INTO taxonomy_f2_import_product_rows ' +
        '(batch_id,source_line,product_code,segmento,grupo,item,ncm_normalized,raw_cells,row_sha256) ' +
        'SELECT $1::uuid,s.source_line,s.product_code,s.segmento,s.grupo,s.item,' +
        's.ncm_normalized,s.raw_cells,s.row_sha256 FROM jsonb_to_recordset($2::jsonb) ' +
        'AS s(source_line integer,product_code text,segmento text,grupo text,' +
        'item text,ncm_normalized jsonb,raw_cells jsonb,row_sha256 text)',
        [batchId,JSON.stringify(chunk)],
      );
      insertedProducts += result.rowCount;
    }
    if (insertedSegments !== payload.summary.segmentRows || insertedProducts !== payload.summary.productRows)
      throw new Error('F2_STAGE_INSERT_COUNT_MISMATCH');

    await verifyF2StageReadback(client, batchId, payload);
    await client.query('COMMIT');
    begun = false;
    return { batchId, firstRun: true, insertedBatches: 1,
      insertedSegments, insertedProducts,
      errors: 0, warnings: payload.summary.warnings, liveTaxonomyChanges: 0 };
  } catch(error) {
    if (begun) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
