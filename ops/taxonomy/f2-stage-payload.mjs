// Preserve every XLSX source cell. Do not pair suggested products/NCM by index.
import { createHash } from 'node:crypto';
import { F2_SOURCE, planImport } from './f2-xlsx-dry-run.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalizeCells = (row, width) => {
  if (!Array.isArray(row) || row.length > width) throw new Error('INVALID_F2_COLUMN_COUNT');
  return Array.from({ length: width }, (_, i) => String(row[i] ?? ''));
};

export function makeF2StagingPayload(segmentRows, productRows, hashes = {
  segmentoSha256: F2_SOURCE.segmento.sha256,
  produtoSha256: F2_SOURCE.produto.sha256,
}) {
  const plan = planImport(segmentRows, productRows);
  const s = plan.summary;
  if (s.errors !== 0 || s.segmentRows !== F2_SOURCE.segmento.rows ||
      s.productRows !== F2_SOURCE.produto.rows ||
      s.cnaeDistinct !== F2_SOURCE.segmento.rows ||
      s.productCodesDistinct !== F2_SOURCE.produto.rows || s.actuationCategories !== 12) {
    throw new Error('F2_SOURCE_COUNTS_OR_VALIDATION_FAILED');
  }
  const segments = segmentRows.map((row, i) => {
    const raw_cells = normalizeCells(row, 12);
    return { source_line: i + 2, cnae_code: plan.actuationOrigins[i].cnaeCode,
      atuacao: plan.actuationOrigins[i].atuacaoLabel, raw_cells,
      row_sha256: digest(JSON.stringify(raw_cells)) };
  });
  const products = productRows.map((row, i) => {
    const raw_cells = normalizeCells(row, 10);
    const product = plan.products[i];
    const ncm_normalized = product.ncms.map(x => x.digits);
    if (ncm_normalized.some(x => !/^\d{2,8}$/.test(x)))
      throw new Error('F2_NCM_INVALID_IN_PLAN');
    return { source_line: i + 2, product_code: product.code,
      segmento: product.segment, grupo: product.group, item: product.item,
      ncm_normalized, raw_cells, row_sha256: digest(JSON.stringify(raw_cells)) };
  });
  const contentSha256 = digest(JSON.stringify({
    segmento: segments.map(x => x.raw_cells),
    produto: products.map(x => x.raw_cells),
  }));
  return { hashes, segments, products, contentSha256, summary: s };
}
