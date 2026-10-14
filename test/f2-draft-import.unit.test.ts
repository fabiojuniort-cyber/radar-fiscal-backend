import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildF2DraftPlan,SEGMENTO_SHA,PRODUTO_SHA,type F2StageSnapshot} from '../src/modules/taxonomy/curation/curation.f2-draft-import.js';

const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
function fixture():F2StageSnapshot {
  const segments=Array.from({length:1332},(_,i)=>{
    const cnae=String(1000000+i);
    const raw_cells=['Produção agrícola','Cultivo','Produtor rural',cnae,'CNAE '+i,'', '', '', 'x','','','sector.cnae_'+cnae];
    return {source_line:i+2,cnae_code:cnae,atuacao:'Produtor rural',raw_cells,row_sha256:sha(JSON.stringify(raw_cells))};
  });
  const products=Array.from({length:4225},(_,i)=>{
    const raw_cells=['Agro','Grãos','Produto '+i,'0101','','x','','','product.item_'+i,''];
    return {source_line:i+2,product_code:'item_'+i,ncm_normalized:['0101'],
      raw_cells,row_sha256:sha(JSON.stringify(raw_cells))};
  });
  return {batch:{
    id:'11111111-1111-4111-8111-111111111111',status:'STAGED',
    segmento_sha256:SEGMENTO_SHA,produto_sha256:PRODUTO_SHA,
    content_sha256:sha(JSON.stringify({segmento:segments.map(s=>s.raw_cells),produto:products.map(p=>p.raw_cells)})),
    segmento_rows:1332,produto_rows:4225,expected_warnings:448,
  },segments,products};
}
test('F2-DRAFT-01 plans exact staging counts, retains source codes and leading NCM zeroes',()=>{
  const plan=buildF2DraftPlan(fixture());
  assert.equal(plan.segmentoRows,1332);assert.equal(plan.produtoRows,4225);
  assert.equal(plan.expectedWarnings,448);
  assert.equal(plan.sector[0]?.code,'sector.cnae_1000000');
  assert.deepEqual(plan.product[0]?.officialCodes,['0101']);
  assert.equal(plan.atuacaoOrigins.length,1332);
});
test('F2-DRAFT-01 fails on changed cells and duplicate concept codes',()=>{
  const changed=fixture();
  changed.segments[0]!.raw_cells[4]='ALTERAÇÃO';
  assert.throws(()=>buildF2DraftPlan(changed),/F2_DRAFT_ROW_HASH_MISMATCH/);
  const duplicate=fixture();
  duplicate.products[1]!.raw_cells[8]=duplicate.products[0]!.raw_cells[8]!;
  duplicate.products[1]!.row_sha256=sha(JSON.stringify(duplicate.products[1]!.raw_cells));
  duplicate.batch.content_sha256=sha(JSON.stringify({segmento:duplicate.segments.map(s=>s.raw_cells),
    produto:duplicate.products.map(p=>p.raw_cells)}));
  assert.throws(()=>buildF2DraftPlan(duplicate),/F2_DRAFT_DUPLICATE_CODE/);
});
test('F2-DRAFT-01 rejects nine-digit NCM with no truncation',()=>{
  const invalid=fixture();
  invalid.products[0]!.ncm_normalized=['123456789'];
  assert.throws(()=>buildF2DraftPlan(invalid),/F2_DRAFT_PRODUCT_NCM_INVALID/);
});
