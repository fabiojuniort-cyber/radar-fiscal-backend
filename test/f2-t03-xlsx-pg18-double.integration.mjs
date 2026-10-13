/**
 * ONE job: synthetic XLSX ZIP -> real parser -> PG18 isolated -> write twice.
 * Explicitly not a test of the approved XLSX binary until T00 is uploaded.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { F2_SOURCE, parseF2TestFixtureWorkbook } from '../ops/taxonomy/f2-xlsx-dry-run.mjs';
import { makeF2StagingPayload } from '../ops/taxonomy/f2-stage-payload.mjs';
import { stageF2Payload } from '../ops/taxonomy/f2-stage-persist.mjs';

const labels = [
  ['Serviço',583], ['Indústria',380], ['Comércio atacadista',116],
  ['Produção agropecuária',108], ['Comércio varejista',89],
  ['Extração mineral',41], ['Representação comercial',15],
];

function makeRows() {
  const segmentos = [], produtos = [];
  let j = 0;
  for (const [label, count] of labels) {
    for (let k = 0; k < count; k++, j++) {
      const moreNcm = j < 368, moreProduct = j >= 368 && j < 442;
      const candidates = moreProduct ? 'Prod A;Prod B;Prod C' : moreNcm ? 'Prod A;Prod B' : 'Prod A';
      const ncms = moreNcm ? '1001;1002;1003' : moreProduct ? '1001;1002' : '1001';
      segmentos.push(['Agro', 'Grãos',label,String(1000000+j), 'CNAE sintético '+j,'',
        candidates,ncms,'x','x',String(j),'sector.fixture_'+j]);
    }
  }
  for (let i = 0; i < 3793; i++) {
    produtos.push(['Agro','Grãos','Produto sintético '+i,
      '1001;1001.90;1001.90.00','Sinônimo '+i,'x','x',String(i),
      'product.fixture_'+i,'Definição sintética '+i]);
  }
  return { segmentos, produtos };
}
const esc = text => String(text).replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

async function makeXlsx(dir, name, headers, rows) {
  const root = join(dir,name+'-folder'), xl = join(root,'xl'), sheets = join(xl,'worksheets');
  await mkdir(sheets,{recursive:true});
  const all = [headers,...rows];
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  for (let i=0;i<all.length;i++) {
    xml.push('<row r="'+(i+1)+'">');
    all[i].forEach((v,col) => {
      const ref = String.fromCharCode(65+col)+(i+1);
      xml.push(v===''?'<c r="'+ref+'"/>':
        '<c r="'+ref+'" t="inlineStr"><is><t>'+esc(v)+'</t></is></c>');
    });
    xml.push('</row>');
  }
  xml.push('</sheetData></worksheet>');
  await writeFile(join(sheets,'sheet1.xml'),xml.join(''));
  await writeFile(join(xl,'sharedStrings.xml'),
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></sst>');
  await writeFile(join(root,'[Content_Types].xml'),
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  const path = join(dir,name+'.xlsx');
  execFileSync('zip',['-q','-r',path,'.'],{cwd:root});
  return path;
}

if (process.env.F2_IMPORT_SCOPE !== 'ISOLATED_POSTGRES18_ONLY' ||
    process.env.NODE_ENV !== 'test') throw new Error('ISOLATED_TEST_ONLY');

const dir = await mkdtemp(join(tmpdir(),'f2-pg18-'));
const pool = new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1});
try {
  const rows = makeRows();
  const [segPath,productPath] = await Promise.all([
    makeXlsx(dir,'segmento',F2_SOURCE.segmento.columns,rows.segmentos),
    makeXlsx(dir,'produto',F2_SOURCE.produto.columns,rows.produtos),
  ]);
  const [seg,prod] = await Promise.all([
    parseF2TestFixtureWorkbook(segPath,'segmento'),
    parseF2TestFixtureWorkbook(productPath,'produto'),
  ]);
  const payload = makeF2StagingPayload(seg.rows,prod.rows,{
    segmentoSha256:seg.hash,produtoSha256:prod.hash,
  });
  const first = await stageF2Payload(pool,payload);
  assert.equal(first.errors,0);
  assert.equal(first.warnings,442);
  assert.equal(first.insertedBatches,1);
  assert.equal(first.insertedSegments,1332);
  assert.equal(first.insertedProducts,3793);
  assert.equal(first.liveTaxonomyChanges,0);

  const second = await stageF2Payload(pool,payload);
  assert.equal(second.batchId,first.batchId);
  assert.deepEqual({
    insertedBatches:second.insertedBatches,
    insertedSegments:second.insertedSegments,
    insertedProducts:second.insertedProducts,
    liveTaxonomyChanges:second.liveTaxonomyChanges,
  },{insertedBatches:0,insertedSegments:0,insertedProducts:0,liveTaxonomyChanges:0});

  const check = await pool.query(
    'SELECT (SELECT count(*)::int FROM taxonomy_f2_import_batches) AS batches,'+
    '(SELECT count(*)::int FROM taxonomy_f2_import_segment_rows) AS segmento,'+
    '(SELECT count(*)::int FROM taxonomy_f2_import_product_rows) AS produtos');
  assert.deepEqual(check.rows[0],{batches:1,segmento:1332,produtos:3793});

  const modified = rows.produtos.map(r=>r.slice());
  modified[0][9]='DEFINIÇÃO NÃO AUTORIZADA';
  const forged = makeF2StagingPayload(rows.segmentos,modified,payload.hashes);
  await assert.rejects(stageF2Payload(pool,forged),/EXISTING_BATCH_CONFLICT/);
  const after = await pool.query('SELECT count(*)::int AS n FROM taxonomy_f2_import_product_rows');
  assert.equal(after.rows[0].n,3793);

  const summary={source:'SYNTHETIC_XLSX_CI_NOT_APPROVED_SOURCE',first,second,
    sourceHashes:payload.hashes,readback:check.rows[0]};
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      '\n### F2 T03 PostgreSQL 18 synthetic-XLSX idempotency\n'+
      '- First: 0 errors, 442 warnings; 1332+3793 rows inserted\n'+
      '- Second: 0 inserted/updated/deleted rows, full readback PASS\n'+
      '- **Only synthetic XLSX in CI; official source binary remains pending T00 upload.**\n',
      {flag:'a'});
} finally {
  await pool.end();
  await rm(dir,{recursive:true,force:true});
}
