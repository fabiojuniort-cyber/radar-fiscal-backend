import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildF2DraftPlan,auditF2Draft,readF2Stage,validateF2DraftProductNcms,safeF2DraftError,F2DraftStageError,F2_APPROVED_BATCH_ID,SEGMENTO_SHA,PRODUTO_SHA,type F2StageSnapshot} from '../src/modules/taxonomy/curation/curation.f2-draft-import.js';
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
  assert.throws(()=>buildF2DraftPlan(invalid),
    /F2_DRAFT_PRODUCT_NCM_INVALID line=2 reason=LENGTH_9/);
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

/** Exact normalized examples from the signed Produto v5 XLSX, lines from
 * xl/worksheets/sheet1.xml. Staging JSONB is an array of digit strings.
 * The previous validator wrongly required even lengths.
 */
test('F2-DRAFT-04 accepts all ten real 5/7-digit failures without truncation',()=>{
  const samples=[
    {line:204,raw:'2710.12.4',digits:'2710124'},
    {line:205,raw:'2710.19.3',digits:'2710193'},
    {line:207,raw:'2815.1',digits:'28151'},
    {line:232,raw:'2306.4',digits:'23064'},
    {line:280,raw:'2306.4',digits:'23064'},
    {line:4001,raw:'1209.2',digits:'12092'},
    {line:4035,raw:'0307.1',digits:'03071'},
    {line:4036,raw:'0307.3',digits:'03073'},
    {line:4040,raw:'0307.1',digits:'03071'},
    {line:4171,raw:'0901.1',digits:'09011'},
  ];
  const v=fixture();
  for(const {line,raw,digits} of samples){
    const r=v.products[line-2]!;
    r.raw_cells[3]=raw;
    r.ncm_normalized=[digits];
    r.row_sha256=sha(JSON.stringify(r.raw_cells));
  }
  v.batch.content_sha256=sha(JSON.stringify({
    segmento:v.segments.map(r=>r.raw_cells),produto:v.products.map(r=>r.raw_cells),
  }));
  const plan=buildF2DraftPlan(v);
  for(const {line,digits} of samples)
    assert.deepEqual(plan.product[line-2]?.officialCodes,[digits],String(line));
  assert.equal(plan.produtoRows,4225);
});

test('F2-DRAFT-04 preserves two-to-eight digits, odd lengths and leading zeroes',()=>{
  for(const ncm of ['01','001','0001','00101','001001','0010010','00100101'])
    assert.deepEqual(validateF2DraftProductNcms([ncm],42),[ncm]);
  assert.deepEqual(validateF2DraftProductNcms(['03071','03071','2710124'],204),
    ['03071','2710124']);
  assert.deepEqual(validateF2DraftProductNcms([],42),[]);
});

test('F2-DRAFT-04 error contains only safe line and reason, never actual values',()=>{
  const problems=[
    {value:['1'],reason:'LENGTH_1'},
    {value:['123456789'],reason:'LENGTH_9'},
    {value:['12.34'],reason:'NON_DIGIT'},
    {value:['-123'],reason:'NON_DIGIT'},
    {value:[12345],reason:'NOT_STRING'},
    {value:[null],reason:'NOT_STRING'},
    {value:{ncm:'03071'},reason:'NOT_ARRAY'},
    {value:'03071',reason:'NOT_ARRAY'},
  ];
  for(const {value,reason} of problems){
    assert.throws(()=>validateF2DraftProductNcms(value,123),error=>{
      assert.ok(error instanceof Error);
      assert.equal(error.message,'F2_DRAFT_PRODUCT_NCM_INVALID line=123 reason='+reason);
      assert.equal(error.message.includes('03071'),false);
      return true;
    });
  }
  const badSnapshot=fixture();
  badSnapshot.products[203]!.ncm_normalized=['123456789'];
  assert.throws(()=>buildF2DraftPlan(badSnapshot),
    /F2_DRAFT_PRODUCT_NCM_INVALID line=205 reason=LENGTH_9/);
});

test('F2-DRAFT-09 outputs only trusted PostgreSQL identifiers and exact stage and source line',()=>{
  const driverError=Object.assign(new Error('secret://dbuser:dbpassword@private; NCM 0101'),{
    code:'23505',constraint:'taxonomy_release_groups_release_dimension_code_key',
    table:'taxonomy_release_groups',column:'code',
    detail:'Key (code)=(sensitive-value) already exists',
    hint:'connect postgresql://private-user:password@db',
  });
  const result=safeF2DraftError(new F2DraftStageError('sector',123,driverError));
  assert.equal(result,
    'F2_DRAFT_IMPORT_BLOCK stage=sector line=123 sqlstate=23505 '+
    'constraint=taxonomy_release_groups_release_dimension_code_key '+
    'table=taxonomy_release_groups column=code');
  for(const secret of ['secret://','dbuser','dbpassword','NCM 0101','sensitive-value',
    'postgresql://private-user','password@db'])assert.equal(result.includes(secret),false);
});

test('F2-DRAFT-09 retains sanitized domain errors and F2 source diagnostics',()=>{
  assert.equal(safeF2DraftError(new F2DraftStageError('product',204,
    Object.assign(new Error('Confidential SQL parameter value'),{code:'INVALID_OFFICIAL_CODE'}))),
    'F2_DRAFT_IMPORT_BLOCK stage=product line=204 domain=INVALID_OFFICIAL_CODE');
  assert.equal(safeF2DraftError(new F2DraftStageError('readback',undefined,
    new Error('F2_DRAFT_READBACK_MISMATCH'))),
    'F2_DRAFT_READBACK_MISMATCH stage=readback');
  assert.equal(safeF2DraftError(new Error('F2_DRAFT_PRODUCT_NCM_INVALID line=207 reason=LENGTH_5')),
    'F2_DRAFT_PRODUCT_NCM_INVALID line=207 reason=LENGTH_5 stage=preflight');
  assert.equal(safeF2DraftError(new F2DraftStageError('actuacao',undefined,
    Object.assign(new Error('SQL with secret'), {code:'42501',table:'taxonomy_release_actuacao_cnae_origins'}))),
    'F2_DRAFT_IMPORT_BLOCK stage=actuacao sqlstate=42501 table=taxonomy_release_actuacao_cnae_origins');
});

test('F2-DRAFT-09 refuses untrusted SQL metadata and URLs in diagnostic fields',()=>{
  const unexpected=Object.assign(new Error('F2_READ_THE_PASSWORD url://secret'),{
    code:'23505 secrets',table:'taxonomy_release_concepts\\nleak',
    column:'password://url',constraint:'something-secret;DROP_TABLE',
  });
  assert.equal(safeF2DraftError(new F2DraftStageError('ledger',undefined,unexpected)),
    'F2_DRAFT_IMPORT_BLOCK stage=ledger');
  assert.equal(safeF2DraftError(null),'F2_DRAFT_IMPORT_BLOCK stage=preflight');
});
