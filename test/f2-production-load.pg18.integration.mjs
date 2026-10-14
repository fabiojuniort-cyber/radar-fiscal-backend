import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {makeF2StagingPayload} from '../ops/taxonomy/f2-stage-payload.mjs';
import {authorizeF2Load,executeF2Load,SOURCE_SHA256} from '../ops/taxonomy/f2-production-load.mjs';
import {F2_SOURCE} from '../ops/taxonomy/f2-xlsx-dry-run.mjs';
test('production entrypoint transaction on isolated PG18: rollback, two jobs and full readback',async()=>{
 assert.equal(process.env.NODE_ENV,'test');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_ADMIN_URL,max:1});
 try{
  const identity=(await pool.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(identity.db,'radar_fiscal_test');assert.ok(identity.version>=180000);
  const empty=await pool.query('SELECT count(*)::int AS n FROM taxonomy_f2_import_batches');
  assert.equal(empty.rows[0].n,0,'dedicated fresh CI PG18 required');
  const labels=[['Serviço',505],['Indústria',370],['Comércio atacadista',115],['Produtor rural',107],
   ['Comércio varejista',86],['Transportador',44],['Extração mineral',40],['Locação e licenciamento',20],
   ['Institucional',19],['Representação comercial',15],['Energia e utilidades',8],['Armazém',3]];
  const segmentos=[],produtos=[];let j=0;
  for(const [label,count] of labels)for(let k=0;k<count;k++,j++){
   const moreNcm=j<198,moreProduct=j>=198&&j<448;
   segmentos.push(['Agro','Grãos',label,String(1000000+j),'CNAE fixture '+j,'',
    moreProduct?'Prod A;Prod B;Prod C':moreNcm?'Prod A;Prod B':'Prod A',
    moreNcm?'1001;1002;1003':moreProduct?'1001;1002':'1001','x','x',String(j),'sector.fixture_'+j]);
  }
  for(let i=0;i<4225;i++)produtos.push(['Agro','Grãos','Produto '+i,'1001;1001.90;1001.90.00',
   'Sinônimo '+i,'x','x',String(i),'product.fixture_'+i,'Definição '+i]);
  const payload=makeF2StagingPayload(segmentos,produtos);
  const stamp=new Date().toISOString(),hash='a'.repeat(64);
  // Synthetic fixture gate; not a claim of approved original XLSX or backup rehearsal.
  const manifest={sha256:hash,startedAt:stamp,restoreVerifiedAt:stamp,restoreVerifiedSha256:hash,
   target:{projectId:'d7291d78-020d-42d5-8cd9-c387a156a580',database:identity.db,host:'localhost'}};
  const gate=authorizeF2Load({mode:'apply',confirmSourceSha256:SOURCE_SHA256},manifest,
   {segmento:F2_SOURCE.segmento.sha256,produto:F2_SOURCE.produto.sha256},hash,
   {NODE_ENV:'production',F2_IMPORT_SCOPE:'PRODUCTION_STAGING_ONLY',F2_LOAD_ENABLED:'true'});
  const broken=structuredClone(payload);broken.products[0].source_line=99999;
  await assert.rejects(executeF2Load(pool,broken,gate));
  const rolled=(await pool.query('SELECT (SELECT count(*)::int FROM taxonomy_f2_import_batches) AS batches,'+
   '(SELECT count(*)::int FROM taxonomy_f2_import_segment_rows) AS segments,'+
   '(SELECT count(*)::int FROM taxonomy_f2_import_product_rows) AS products')).rows[0];
  assert.deepEqual(rolled,{batches:0,segments:0,products:0});
  const first=await executeF2Load(pool,payload,gate);
  assert.deepEqual(first.before,rolled);assert.deepEqual(first.after,{batches:1,segments:1332,products:4225});
  assert.equal(first.readback,'PASS');assert.equal(first.liveTaxonomyChanges,0);
  const second=await executeF2Load(pool,payload,gate);
  assert.equal(second.batchId,first.batchId);
  assert.deepEqual(second.before,second.after);
  assert.equal(second.insertedBatches+second.insertedSegments+second.insertedProducts,0);
  // Altered source cells with the same source identifiers must not overwrite.
  const forged=structuredClone(payload);forged.contentSha256='b'.repeat(64);
  await assert.rejects(executeF2Load(pool,forged,gate),/EXISTING_BATCH_CONFLICT/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM taxonomy_f2_import_batches')).rows[0].n,1);
 }finally{await pool.end();}
});
