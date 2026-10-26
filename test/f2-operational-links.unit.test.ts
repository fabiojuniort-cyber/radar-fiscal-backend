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
  for(const value of ['0','01','010','0101','01012','010121','0101210','01012100','010121000']) assert.equal(operationalNcm(value),value);
  for(const value of ['','1e6','0101/21','01-01','abc0101']) assert.equal(operationalNcm(value),null);
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

test('three-digit and other prefixes require exact CURRENT catalog or strict descendant evidence',()=>{
  const data=input();data.sources[0]!.ncms='010;0100;012';
  data.catalogNcms=['010','01000'];
  const plan=buildOperationalPlan(data);
  assert.deepEqual(plan.links.filter(l=>l.kind==='NCM').map(l=>l.target).sort(),['010','0100']);
  assert.ok(plan.links.some(l=>l.target==='0100'&&l.evidence.token==='0100'&&l.evidence.sourceLine===2));
  assert.ok(plan.exclusions.some(e=>e.token==='012'&&e.reason==='NCM_NOT_IN_CURRENT_CATALOG'));
  assert.ok(!plan.links.some(l=>l.target==='01000'),'never invent a descendant from a short token');
});

test('approval survives JSONB key ordering but rejects changes to persisted evidence',()=>{
  const plan=buildOperationalPlan(input());
  const approval=approveOperationalPlan(plan,{planSha256:plan.planSha256,candidateIds:plan.links.map(l=>l.id),
    approvedBy:'curator-test',justification:'JSONB roundtrip'});
  const reorder=(v:unknown):unknown=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'
    ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,reorder(x)])):v;
  const persisted=reorder(approval);
  assert.deepEqual(checkedOperationalApproval(plan,persisted),approval);
  const tampered=structuredClone(approval);tampered.links[0]!.evidence.token='changed';
  assert.throws(()=>checkedOperationalApproval(plan,tampered),/STALE/);
});

test('1213, 2302.40 and 2716 keep their digit prefixes when only CURRENT descendants exist',()=>{
  const data=input();data.sources[0]!.products='';data.sources[0]!.ncms='1213;2302.40;2716;9999';
  data.catalogNcms=['12130000','23024000','27160000'];
  const plan=buildOperationalPlan(data);
  assert.deepEqual(plan.links.map(l=>l.target).sort(),['1213','230240','2716'].sort());
  assert.equal(plan.links.find(l=>l.target==='230240')!.evidence.token,'2302.40');
  assert.deepEqual(plan.exclusions.map(e=>[e.token,e.reason]),[['9999','NCM_NOT_IN_CURRENT_CATALOG']]);
  assert.ok(!plan.links.some(l=>data.catalogNcms.includes(l.target)),'no expansion to descendants');
  data.catalogNcms=[];assert.equal(buildOperationalPlan(data).links.length,0);
});
test('any digit length needs exact or descendant evidence; siblings and ancestors cannot validate a longer code',()=>{
  const data=input();data.sources[0]!.products='';data.sources[0]!.ncms='0;0123456789;271600;230241;123';
  data.catalogNcms=['01010101','0123456789','2716','23024000','1234'];
  assert.deepEqual(buildOperationalPlan(data).links.map(l=>l.target).sort(),['0','0123456789','123']);
});
test('removing the last CURRENT descendant invalidates approval; legacy rule approvals require reapproval',()=>{
  const data=input();data.sources[0]!.ncms='1213';data.catalogNcms=['12130000'];
  const plan=buildOperationalPlan(data),approval=approveOperationalPlan(plan,{planSha256:plan.planSha256,
    candidateIds:plan.links.map(l=>l.id),approvedBy:'curator-test',justification:'Prefix evidence'});
  data.catalogNcms=['12140000'];
  assert.throws(()=>checkedOperationalApproval(buildOperationalPlan(data),approval),/STALE/);
  assert.throws(()=>checkedOperationalApproval(plan,{...approval,ruleVersion:'onb03-t07-t08-v2'}),/INVALID/);
});
