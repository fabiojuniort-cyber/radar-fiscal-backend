/**
 * Safe F2-T03 CLI. Approved XLSX hashes must match original v1.7.1/v1.7.3.
 * Creates only lossless global staging rows on isolated PostgreSQL 18.
 * NO production connection, NO release publish, NO tenant mutation.
 */
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { parseApprovedWorkbook } from './f2-xlsx-dry-run.mjs';
import { makeF2StagingPayload } from './f2-stage-payload.mjs';
import { stageF2Payload } from './f2-stage-persist.mjs';

export { makeF2StagingPayload, stageF2Payload };

async function main() {
  const args = process.argv.slice(2);
  const val = n => args.find(x => x.startsWith('--' + n + '='))?.slice(n.length + 3);
  if (!args.includes('--isolated-apply') || args.includes('--production') ||
      process.env.NODE_ENV !== 'test' ||
      process.env.F2_IMPORT_SCOPE !== 'ISOLATED_POSTGRES18_ONLY') {
    throw new Error('F2_PRODUCTION_LOAD_FORBIDDEN: isolated PostgreSQL 18 only');
  }
  if (!val('segmento') || !val('produto') || !process.env.DATABASE_ADMIN_URL) {
    throw new Error('Required: --segmento=<xlsx> --produto=<xlsx> --isolated-apply and DATABASE_ADMIN_URL');
  }
  const [segmento, produto] = await Promise.all([
    parseApprovedWorkbook(resolve(val('segmento')), 'segmento'),
    parseApprovedWorkbook(resolve(val('produto')), 'produto'),
  ]);
  const payload = makeF2StagingPayload(segmento.rows, produto.rows, {
    segmentoSha256: segmento.hash, produtoSha256: produto.hash,
  });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
  try {
    const result = await stageF2Payload(pool, payload);
    const report = {
      mode: 'F2_PG18_ISOLATED_STAGING_ONLY',
      sourceSha256: payload.hashes, contentSha256: payload.contentSha256,
      ...result,
    };
    if (val('report')) await writeFile(resolve(val('report')), JSON.stringify(report, null, 2)+'\n', {flag:'wx'});
    console.log(JSON.stringify(report));
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && new URL(import.meta.url).pathname === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
