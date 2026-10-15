import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildF2DraftPlan,auditF2Draft,readF2Stage,F2_APPROVED_BATCH_ID,SEGMENTO_SHA,PRODUTO_SHA,type F2StageSnapshot} from '../src/modules/taxonomy/curation/curation.f2-draft-import.js';
import type {ReleaseView} from '../src/modules/taxonomy/curation/curation.read.js';
import type {PoolClient} from 'pg';

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

test('F2-DRAFT-02: exact equal, updated, created and out-of-lot counts per dimension', () => {
  const plan=buildF2DraftPlan(fixture());
  plan.sector=plan.sector.slice(0,2);
  plan.product=plan.product.slice(0,2);
  const sector0=plan.sector[0]!,sector1=plan.sector[1]!,product0=plan.product[0]!;
  const asConcept=(c:typeof sector0,groupId:string,overrides:Record<string,unknown>={})=>({
    code:c.code,dimensionCode:c.dimension,label:c.label,definition:c.definition,
    officialCodes:c.officialCodes,groupId,profileVisible:c.profileVisible,
    classifyByLabel:c.classifyByLabel,displayOrder:c.displayOrder,
    membershipStatus:'INCLUDED',aliases:c.aliases,...overrides,
  });
  const view={
    groups:[{id:'sg',dimensionCode:'sector',label:sector0.group},
      {id:'pg',dimensionCode:'product',label:product0.group}],
    concepts:[
      asConcept(sector0,'sg'),
      asConcept(sector1,'sg',{label:'descrição antiga'}),
      asConcept(product0,'pg'),
      asConcept(sector0,'sg',{code:'sector.old',officialCodes:[sector0.officialCodes[0]??'']}),
      asConcept(product0,'pg',{code:'product.old',officialCodes:['0101']}),
    ],
  } as unknown as ReleaseView;
  const report=auditF2Draft(plan,view,'release-test');
  assert.deepEqual([report.dimensions.sector.created,report.dimensions.sector.updated,
    report.dimensions.sector.equal,report.dimensions.sector.outsideLot.count],[0,1,1,1]);
  assert.deepEqual([report.dimensions.product.created,report.dimensions.product.updated,
    report.dimensions.product.equal,report.dimensions.product.outsideLot.count],[1,0,1,1]);
  assert.equal(report.dimensions.sector.outsideLot.examples[0]?.code,'sector.old');
  assert.deepEqual(report.dimensions.sector.outsideLot.examples[0]?.officialCodes,[sector0.officialCodes[0]]);
  assert.equal(report.dimensions.product.outsideLot.examples[0]?.code,'product.old');
  assert.equal(report.dimensions.sector.duplicateOfficialCodes.count,1);
  assert.equal(report.dimensions.product.duplicateOfficialCodes.count,1);
  assert.deepEqual(report.dimensions.product.duplicateOfficialCodes.examples[0]?.conceptCodes,
    ['product.item_0','product.item_1','product.old']);
  assert.equal(report.requiresCoordApproval,true);
  assert.match(report.exceptionsApprovalSha256??'',/^[0-9a-f]{64}$/);
  assert.deepEqual(report.identicalCodes,{sector:[sector0.code],product:[product0.code]});
  // A different exception must change the approval digest.
  const less=auditF2Draft(plan,{...view,concepts:view.concepts.slice(0,-1)},'release-test');
  assert.notEqual(less.exceptionsApprovalSha256,report.exceptionsApprovalSha256);
});

test('F2-DRAFT-02: no outside items or collisions means no COORD exception token',()=>{
  const plan=buildF2DraftPlan(fixture());
  plan.sector=plan.sector.slice(0,1);
  plan.product=plan.product.slice(0,1);
  const view={concepts:[],groups:[]} as unknown as ReleaseView;
  const report=auditF2Draft(plan,view,'release-test');
  assert.equal(report.requiresCoordApproval,false);
  assert.equal(report.exceptionsApprovalSha256,null);
  assert.equal(report.dimensions.sector.created,1);
  assert.equal(report.dimensions.product.created,1);
});

test('F2-DRAFT-02: outside examples capped at ten, count and approval digest cover all',()=>{
  const plan=buildF2DraftPlan(fixture());
  plan.sector=[];
  plan.product=[];
  const view={groups:[],concepts:Array.from({length:15},(_,i)=>({
    code:'product.out_'+i,dimensionCode:'product',officialCodes:['01'+String(i).padStart(2,'0')],
    membershipStatus:'INCLUDED',aliases:[],
  }))} as unknown as ReleaseView;
  const report=auditF2Draft(plan,view,'release-test');
  assert.equal(report.dimensions.product.outsideLot.count,15);
  assert.equal(report.dimensions.product.outsideLot.examples.length,10);
  const changed=auditF2Draft(plan,{...view,concepts:view.concepts.slice(0,14)},'release-test');
  assert.notEqual(changed.exceptionsApprovalSha256,report.exceptionsApprovalSha256);
});

test('F2-DRAFT-02: approved batch status exists and is STAGED before reading rows',async()=>{
  const snapshot=fixture();
  const calls:string[]=[];
  const client={
    query:async(sql:string,params:unknown[])=>{
      calls.push(sql);
      if(sql.includes('FROM public.taxonomy_f2_import_batches')) {
        assert.deepEqual(params,[SEGMENTO_SHA,PRODUTO_SHA,F2_APPROVED_BATCH_ID]);
        return {rows:[{...snapshot.batch,id:F2_APPROVED_BATCH_ID,status:'STAGED'}]};
      }
      return {rows:[]};
    },
  } as unknown as PoolClient;
  const read=await readF2Stage(client);
  assert.equal(read.batch.status,'STAGED');
  assert.equal(calls.length,3);
  const invalid={
    query:async(sql:string)=>({rows:sql.includes('FROM public.taxonomy_f2_import_batches')?
      [{...snapshot.batch,id:F2_APPROVED_BATCH_ID,status:'READY'}]:[]}),
  } as unknown as PoolClient;
  await assert.rejects(readF2Stage(invalid),/F2_DRAFT_BATCH_NOT_STAGED/);
});
