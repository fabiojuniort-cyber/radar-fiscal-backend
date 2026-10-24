import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { approveOperationalPlan, buildOperationalPlan, checkedOperationalApproval, operationalNcm,
  type LinkConcept } from '../src/modules/taxonomy/curation/curation.f2-links.plan.js';
import { publishedOperationalLinks, validateOperationalPublication } from '../src/modules/taxonomy/curation/curation.f2-links.js';

const concepts:LinkConcept[]=[
  {code:'sector.rice',dimensionCode:'sector',label:'Cultivo de arroz',membershipStatus:'INCLUDED',officialCodes:['0111301']},
  {code:'product.rice',dimensionCode:'product',label:'Arroz',membershipStatus:'INCLUDED',officialCodes:['1006']},
  {code:'product.other',dimensionCode:'product',label:'Produto, composto',membershipStatus:'INCLUDED',officialCodes:[]},
];
const input=()=>({sourceSha256:'a'.repeat(64),catalogIdentity:'current-2026',
  sources:[{cnae:'0111301',segment:'Grãos',line:2,rowSha256:'b'.repeat(64),
    products:'Arroz;ARROZ;Produto, composto;Desconhecido',ncms:'10.06;10063011;123;9999;01012;0101210'}],
  concepts:structuredClone(concepts),catalogNcms:['1006','10063011','01012','0101210']});
test('T07/T08 resolves only unique products and explicit source NCMs, independently by CNAE',()=>{
  const plan=buildOperationalPlan(input());
  assert.deepEqual(plan.bySegment,[{segment:'Grãos',products:2,ncms:4,excluded:3}]);
  assert.equal(plan.links.filter(l=>l.target==='product.rice').length,1);
  assert.ok(plan.links.some(l=>l.target==='product.other'));
  assert.deepEqual(plan.exclusions.map(e=>e.reason).sort(),
    ['NCM_NOT_IN_CURRENT_CATALOG','NCM_NOT_IN_CURRENT_CATALOG','PRODUCT_NOT_FOUND'].sort());
  assert.ok(plan.links.every(l=>l.cnae==='0111301'&&l.evidence.origin==='STAGING'&&l.evidence.sourceLine===2));
});
test('NCM examines all lengths preserving zeros; malformed or unsupported values are excluded, never padded',()=>{
  for(const value of ['01','010','0101','01012','010121','0101210','01012100']) assert.equal(operationalNcm(value),value);
  for(const value of ['','0','010121000','1e6','0101/21','01-01','abc0101']) assert.equal(operationalNcm(value),null);
  assert.equal(operationalNcm('0101.21.00'),'01012100');
});
test('ambiguous product, missing CNAE, duplicate source CNAE and retired products cannot become links',()=>{
  const data=input();
  data.concepts.push({...concepts[1]!,code:'product.duplicate'});
  assert.ok(buildOperationalPlan(data).exclusions.some(e=>e.reason==='PRODUCT_AMBIGUOUS'));
  data.concepts[0]!.officialCodes=['0111302'];assert.equal(buildOperationalPlan(data).links.length,0);
  const duplicate=input();duplicate.sources.push({...duplicate.sources[0]!,line:3});
  assert.equal(buildOperationalPlan(duplicate).links.length,0);
  const retired=input();retired.concepts[1]!.membershipStatus='EXCLUDED';
  assert.ok(!buildOperationalPlan(retired).links.some(l=>l.target==='product.rice'));
});
test('explicit empty curated selections remove staging fallback, without editing the source',()=>{
  const data=input();const before=JSON.stringify(data.sources);
  data.concepts[0]!.f2DraftSuggestions={products:[],ncms:[]};
  assert.equal(buildOperationalPlan(data).links.length,0);
  assert.equal(JSON.stringify(data.sources),before);
});
test('approval is an explicit subset bound to the complete plan, and cannot be reused after edits',()=>{
  const data=input(),plan=buildOperationalPlan(data);
  const approval=approveOperationalPlan(plan,{planSha256:plan.planSha256,candidateIds:[plan.links[0]!.id],
    approvedBy:'curator-test',justification:'Aprovação de teste'});
  assert.equal(approval.links.length,1);
  assert.deepEqual(checkedOperationalApproval(plan,approval),approval);
  assert.throws(()=>approveOperationalPlan(plan,{...approval,candidateIds:['bad']}),/UNKNOWN/);
  assert.throws(()=>approveOperationalPlan(plan,{...approval,justification:''}),/REQUIRED/);
  data.catalogIdentity='new-edition';
  assert.throws(()=>checkedOperationalApproval(buildOperationalPlan(data),approval),/STALE/);
  const changed=input();changed.sources[0]!.rowSha256='c'.repeat(64);
  assert.notEqual(buildOperationalPlan(changed).planSha256,plan.planSha256);
  assert.throws(()=>checkedOperationalApproval(plan,{...approval,links:[]}),/STALE/);
});
test('runtime reads only the latest PUBLISHED manifest, never staging, and never writes profiles',async()=>{
  const plan=buildOperationalPlan(input());
  const approval=approveOperationalPlan(plan,{planSha256:plan.planSha256,candidateIds:plan.links.map(l=>l.id),
    approvedBy:'curator-test',justification:'Teste publicado'});
  const queries:string[]=[];
  const run=async<T>(sql:string):Promise<T[]>=>{
    queries.push(sql);assert.match(sql,/WHERE status='PUBLISHED'/);
    assert.doesNotMatch(sql,/staging|company|INSERT|UPDATE|DELETE/i);
    return [{approval}] as T[];
  };
  assert.equal((await publishedOperationalLinks(run,'0111301')).length,6);
  assert.deepEqual(await publishedOperationalLinks(run,'0111302'),[]);
  assert.deepEqual(await publishedOperationalLinks(run,'invalid'),[]);
  assert.equal(queries.length,2);
});
test('legacy publication without explicit operational approval performs no staging queries',async()=>{
  const client={query:()=>{throw new Error('unexpected query');}} as unknown as PoolClient;
  assert.equal(await validateOperationalPublication(client,'unused',{}),null);
  assert.deepEqual(await publishedOperationalLinks(async<T>()=>[{approval:null}] as T[],'0111301'),[]);
});

test('three-digit NCM is proposed only on an exact CURRENT catalog match, with exclusion evidence otherwise',()=>{
  const data=input();data.sources[0]!.ncms='010;0100;012';
  data.catalogNcms=['010','01000'];
  const plan=buildOperationalPlan(data);
  assert.deepEqual(plan.links.filter(l=>l.kind==='NCM').map(l=>l.target),['010']);
  assert.ok(plan.exclusions.some(e=>e.token==='0100'&&e.normalized==='0100'&&e.sourceLine===2&&e.rowSha256==='b'.repeat(64)));
  assert.ok(plan.exclusions.some(e=>e.token==='012'&&e.reason==='NCM_NOT_IN_CURRENT_CATALOG'));
  assert.ok(!plan.links.some(l=>l.target==='01000'),'never invent a descendant from a short token');
});
