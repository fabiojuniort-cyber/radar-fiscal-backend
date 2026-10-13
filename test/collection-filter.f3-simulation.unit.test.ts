import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { classifySimulationPublication, summarizeSimulation, listRuleRedundancies,
  runF3TypeSimulation, type SimulationResultRow } from '../src/infrastructure/database/f3-type-simulation.js';
import type { CollectionFilterPolicyInput } from '../src/modules/collection/collection-filter.engine.js';

function row(id:string, overrides:Partial<SimulationResultRow>={}):SimulationResultRow {
  return {publicationId:id,source:'dou',section:'DO3',oldConflict:true,before:'KEEP',after:'DISCARD',
    hasCompany:false,originCount:1,sample:{publicationId:id,title:'Public act',publishedOn:null,
      source:'dou',section:'DO3',officialType:'Aviso',titleType:'EXTRATO DE CONTRATO',before:'KEEP',
      after:'DISCARD',reason:'EXCLUDE_ALWAYS',protection:[]},...overrides};
}
const policy:CollectionFilterPolicyInput={version:1,contextWindowWords:5,weakScoreThreshold:3,
  locationWeights:{title:3,summary:2,body:1},terms:[],rules:[
    {sourceCode:'dou',section:'DO3',canonicalType:'EXTRATO DE CONTRATO',mode:'EXCLUDE_ALWAYS'},
    {sourceCode:'dou',section:'DO3',canonicalType:'AVISO',mode:'KEEP_ALWAYS'},
    {sourceCode:'doe-sp',canonicalType:'PORTARIA',mode:'KEEP_ALWAYS'},
  ]};

test('count each publication once, protect every extra origin and company match',()=>{
  const report=summarizeSimulation([row('a'),row('a',{originCount:2}),row('b',{hasCompany:true}),
    row('c'),row('d',{after:'KEEP'}),row('d',{after:'KEEP'})]);
  assert.deepEqual(report.counts,{kept:1,eligible:1,protected:2});
  assert.equal(report.publications,4); assert.equal(report.conflicts.DO3?.publications,4);
  assert.equal(report.conflicts.DO3?.keepToDiscard,3);
  assert.equal(classifySimulationPublication([row('e',{after:'KEEP',hasCompany:true})]),'kept');
});
test('conflict counts and example caps are publication based, extra section inherits',()=>{
  const rows=Array.from({length:15},(_,i)=>row(String(i)));
  const report=summarizeSimulation(rows);
  assert.equal(report.samples.eligible.length,10);assert.equal(report.counts.eligible,15);
  assert.equal(report.conflicts.DO3?.beforeKeep,15);
  assert.throws(()=>classifySimulationPublication([]),/empty_publication_group/);
});
test('redundancy output keeps alphabetic variants and conflicting modes as review only',()=>{
  const rules=[...policy.rules,
    {sourceCode:'dou',section:'DO3',canonicalType:'EXTRATO DE CONTRATO BF',mode:'KEEP_ALWAYS' as const},
    {sourceCode:'dou',section:'DO3',canonicalType:'Extrato de Contrato nº 33/2026',mode:'EXCLUDE_ALWAYS' as const}];
  const original=JSON.stringify(rules);const findings=listRuleRedundancies({...policy,rules});
  assert.equal(JSON.stringify(rules),original);
  const root=findings.find(item=>item.pattern==='EXTRATO DE CONTRATO');
  assert.ok(root?.candidates.some(candidate=>candidate.type.endsWith('BF')&&candidate.kind==='PREFIX_VARIANT'));
  assert.ok(root?.candidates.some(candidate=>candidate.kind==='NORMALIZED_COLLISION'));
});
test('redundancy grouping keeps explicit extra and principal section scopes separate',()=>{
  const findings=listRuleRedundancies({...policy,rules:[
    {sourceCode:'dou',section:'DO1',canonicalType:'PORTARIA',mode:'KEEP_ALWAYS'},
    {sourceCode:'dou',section:'DO1E',canonicalType:'PORTARIA',mode:'EXCLUDE_ALWAYS'},
  ]});
  assert.deepEqual(findings,[]);
});
test('frozen baseline bytes match manifest and retain the old #215 Pompeia KEEP',async()=>{
  const url=pathToFileURL(resolve('ops/f3/ccfaa15.baseline-engine.mjs'));
  const baseline=await import(url.href);
  const manifest=JSON.parse(await readFile('ops/f3/ccfaa15.baseline-provenance.json','utf8'));
  assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'),manifest.moduleSha256);
  assert.equal(manifest.revision,'ccfaa15cffd322bb364c99f44eb04f759b781d1e');
  const old=baseline.evaluateCollectionFilter(baseline.compileCollectionFilterPolicy(policy),{
    sourceCode:'dou',section:'DO3',sourceActType:'Aviso',actType:'EXTRATO DE CONTRATO',
    title:'EXTRATO DE CONTRATO Nº 33/2026',typeConflict:true,evidenceComplete:true});
  assert.equal(old.decision,'KEEP');assert.equal(old.reasonCode,'TYPE_CONFLICT');
});
test('CLI simulation uses SELECT only, read-only snapshot, and no runtime cleanup helper',async()=>{
  const baseline=await import(pathToFileURL(resolve('ops/f3/ccfaa15.baseline-engine.mjs')).href);
  const commands:string[]=[];let pages=0;
  const client={query:async(sql:string)=>{
    commands.push(sql);
    if(sql.startsWith('SELECT transaction_timestamp'))return {rows:[{taken_at:'2026-10-13',snapshot:'1:2:',read_only:'on',unfiltered:true}]};
    if(sql.startsWith('SELECT p.id, p.version'))return {rows:[{id:'policy',version:1,revision:4,document:policy}]};
    if(sql.startsWith('SELECT id,source_code'))return {rows:[{id:'rule',source_code:'dou',section:'DO3',
      canonical_type:'EXTRATO DE CONTRATO',mode:'EXCLUDE_ALWAYS',created_at:'2026-10-10T00:00:00Z'}]};
    if(sql.startsWith('WITH page'))return {rows:pages++===0?[{id:'65411060-690d-46ac-8153-ce51562ea1f4',
      title:'EXTRATO DE CONTRATO Nº 33/2026',act_type:'EXTRATO DE CONTRATO',published_on:'2026-10-09',
      source_code:'dou',origin_metadata:{dou:{section:'DO3',sourceActType:'Aviso'}},
      version_metadata:{dou:{section:'DO3',sourceActType:'Aviso'}},content_text:'Full public act',
      current_version_count:1,has_company:false,origin_count:1,has_file:false,
      first_collected_at:'2026-10-09T12:00:00Z',first_version_captured_at:'2026-10-09T12:00:00Z',
      captured_at:'2026-10-09T12:00:00Z'}]:[]};
    return {rows:[]};
  }} as unknown as Client;
  const report=await runF3TypeSimulation(client,baseline);
  assert.deepEqual(report.counts,{kept:0,eligible:1,protected:0});
  assert.equal(report.conflicts.DO3?.keepToDiscard,1);
  assert.equal(report.pompeia.found,true);
  assert.equal(report.pompeia.origins[0]?.beforeReason,'TYPE_CONFLICT');
  assert.equal(report.pompeia.origins[0]?.winningRule?.id,'rule');
  assert.equal(report.pompeia.origins[0]?.capturedAtField,'publication_versions.captured_at');
  assert.equal(report.pompeia.origins[0]?.ruleCreatedAfterInitialCapture,true);
  assert.equal(commands[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(commands.at(-1),'ROLLBACK');
  assert.ok(commands.every(sql=>/^(SELECT|WITH page|BEGIN|ROLLBACK)/.test(sql)));
  assert.ok(!JSON.stringify(report).includes('Full public act'));
});
test('reject filtered role and rollback before querying publications',async()=>{
  const commands:string[]=[];
  const client={query:async(sql:string)=>{commands.push(sql);return{rows:[{read_only:'on',unfiltered:false}]};}} as unknown as Client;
  const baseline=await import(pathToFileURL(resolve('ops/f3/ccfaa15.baseline-engine.mjs')).href);
  await assert.rejects(runF3TypeSimulation(client,baseline),/readonly_unfiltered_role_required/);
  assert.equal(commands.at(-1),'ROLLBACK');assert.equal(commands.length,3);
});

test('isolated local PostgreSQL: real SELECTs, company/other-origin guards and unchanged data',
  {skip:!process.env.F3_LOCAL_CLI_TEST_DATABASE_URL},async()=>{
  const url=new URL(process.env.F3_LOCAL_CLI_TEST_DATABASE_URL!);
  // This opt-in fixture test must never accept a Railway/production URL.
  assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55483');
  assert.equal(url.pathname,'/f3_cli_smoke');
  const setup=new Client({connectionString:url.href});await setup.connect();
  const baseline=await import(pathToFileURL(resolve('ops/f3/ccfaa15.baseline-engine.mjs')).href);
  let createdPolicy:string|undefined,previousPolicy:string|undefined,tenant:string|undefined;
  const publications:string[]=[],sources:string[]=[];
  const digest=async()=>JSON.stringify((await setup.query(`SELECT
    (SELECT count(*) FROM publications) AS publications,
    (SELECT count(*) FROM publication_origins) AS origins,
    (SELECT count(*) FROM publication_versions) AS versions,
    (SELECT count(*) FROM company_publications) AS matches,
    (SELECT jsonb_agg(jsonb_build_array(id,revision,status) ORDER BY id) FROM collection_filter_policies) AS policies`)).rows);
  try {
    await setup.query('BEGIN');
    previousPolicy=(await setup.query("SELECT id FROM collection_filter_policies WHERE status='APPROVED'")).rows[0]?.id;
    if(previousPolicy)await setup.query("UPDATE collection_filter_policies SET status='SUPERSEDED' WHERE id=$1",[previousPolicy]);
    createdPolicy=(await setup.query(`INSERT INTO collection_filter_policies(version,status,approved_at)
      VALUES((SELECT COALESCE(max(version),0)+1 FROM collection_filter_policies),'APPROVED',now()) RETURNING id`)).rows[0].id;
    for(const rule of policy.rules)await setup.query(`INSERT INTO collection_filter_type_rules
      (policy_id,source_code,section,canonical_type,mode) VALUES($1,$2,$3,$4,$5)`,
      [createdPolicy,rule.sourceCode,rule.section??'',rule.canonicalType,rule.mode]);
    for(const [code,state] of [['dou',false],['doe-sp',true],['f3_cli_other',false]] as const) {
      const existing=(await setup.query('SELECT id FROM sources WHERE code=$1',[code])).rows[0];
      if(existing){sources.push(existing.id);continue;}
      sources.push((await setup.query(`INSERT INTO sources(code,name,jurisdiction_level,uf,base_url,connector_key)
        VALUES($1,$1,$2,$3,'https://example.invalid/f3-cli-smoke',$4) RETURNING id`,
        [code,state?'STATE':'FEDERAL',state?'SP':null,'f3_cli_'+code])).rows[0].id);
    }
    tenant=(await setup.query("INSERT INTO tenants(name,slug) VALUES('F3 local test','f3-cli-local-test') RETURNING id")).rows[0].id;
    const company=(await setup.query(`INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
      VALUES($1,'Synthetic local company','12345678901234') RETURNING id`,[tenant])).rows[0].id;
    for(let i=0;i<5;i++) {
      const source=i===4?'doe-sp':'dou',official=i===3?'TIPO SEM REGRA':i===4?'Portaria':'Aviso';
      const title=i===3?'TIPO SEM REGRA Nº 10':i===4?'PORTARIA Nº 10':'EXTRATO DE CONTRATO Nº 33/2026';
      const metadata=source==='dou'?{dou:{section:'DO3',sourceActType:official}}:{section:'EXECUTIVO',publicationType:official};
      const id=(await setup.query(`INSERT INTO publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,title,act_type)
        VALUES(encode(digest($1,'sha256'),'hex'),'SOURCE_SCOPED','{}','FEDERAL',$2,$3) RETURNING id`,
        ['f3-cli-local-'+i,title,i===3?'TIPO SEM REGRA':i===4?'PORTARIA':'EXTRATO DE CONTRATO'])).rows[0].id;
      publications.push(id);
      await setup.query(`INSERT INTO publication_origins(publication_id,source_id,official_url,metadata)
        VALUES($1,$2,$3,$4)`,[id,sources[i===4?1:0],'https://example.invalid/f3-cli/'+i,metadata]);
      await setup.query(`INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text,source_metadata)
        VALUES($1,1,encode(digest($2,'sha256'),'hex'),'Public fixture body',$3)`,[id,'f3-cli-body-'+i,metadata]);
      if(i===1)await setup.query('INSERT INTO company_publications(company_id,publication_id) VALUES($1,$2)',[company,id]);
      if(i===2)await setup.query(`INSERT INTO publication_origins(publication_id,source_id,official_url)
        VALUES($1,$2,'https://example.invalid/f3-cli/extra')`,[id,sources[2]]);
    }
    await setup.query('COMMIT');
    const before=await digest();
    const reader=new Client({connectionString:url.href,options:'-c default_transaction_read_only=on'});
    await reader.connect();
    try {
      await assert.rejects(reader.query('DELETE FROM publications WHERE id=$1',[publications[0]]),
        (error:unknown)=>(error as {code:string}).code==='25006');
      const report=await runF3TypeSimulation(reader,baseline);
      assert.deepEqual(report.counts,{kept:2,eligible:1,protected:2});
      assert.equal(report.conflicts.DO3?.keepToDiscard,3);
      assert.equal(report.originsEvaluated,5);assert.equal(report.publications,5);
      assert.ok(report.unknownTypesTop20.some(type=>type.type==='TIPO SEM REGRA'));
      assert.equal(await digest(),before);
    } finally {await reader.end();}
  } finally {
    await setup.query('ROLLBACK');await setup.query('BEGIN');
    if(tenant)await setup.query('DELETE FROM tenants WHERE id=$1',[tenant]);
    if(publications.length)await setup.query('DELETE FROM publications WHERE id=ANY($1::uuid[])',[publications]);
    if(createdPolicy)await setup.query('DELETE FROM collection_filter_policies WHERE id=$1',[createdPolicy]);
    if(previousPolicy)await setup.query("UPDATE collection_filter_policies SET status='APPROVED' WHERE id=$1",[previousPolicy]);
    await setup.query('COMMIT');await setup.end();
  }
});
