import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
 buildF2GroupRepairPlan,F2_GROUP_REPAIR_DRAFT_ID,
} from '../src/modules/taxonomy/curation/curation.f2-group-repair.js';
import {f2GroupSlugify,type F2DraftPlan} from '../src/modules/taxonomy/curation/curation.f2-draft-import.js';
import type {ReleaseView} from '../src/modules/taxonomy/curation/curation.read.js';

const label='Produção Agrícola';
const base='a'.repeat(60);
const first=base+' A',second=base+' B';
function scenario(applied=false){
 const sector=[first,second].map((group,i)=>({
   line:2+i,code:'sector.cnae_'+(1000000+i),dimension:'sector' as const,
   label:'CNAE '+i,definition:'CNAE '+i,group,parentSegment:label,
   officialCodes:[String(1000000+i)],aliases:[],profileVisible:true,
   classifyByLabel:true,displayOrder:i,
 }));
 const plan={
  batchId:'f4ab4f0c-9755-4957-9b51-826aeddb4bca',contentSha256:'a'.repeat(64),
  segmentoRows:2,produtoRows:0,expectedWarnings:0,sector,product:[],atuacaoOrigins:[],
 } satisfies F2DraftPlan;
 const originalCode=f2GroupSlugify(first);
 const groups=[
  {id:'legacy',dimensionCode:'sector',code:originalCode,label:first,segmentCodes:applied?['sector.parent']:[]},
  ...(applied?[{id:'new-group',dimensionCode:'sector',
    code:base.slice(0,46)+'_'+
      'unused-suffix-placeholder',label:second,segmentCodes:['sector.parent']}]:[]),
 ];
 const concepts=[
  {code:'sector.parent',label,dimensionCode:'sector',membershipStatus:'INCLUDED',
   officialCodes:[],groupId:null},
  ...sector.map((item,i)=>({
   code:item.code,label:item.label,dimensionCode:'sector',membershipStatus:'INCLUDED',
   officialCodes:item.officialCodes,
   groupId:!i?'legacy':applied?'new-group':'legacy',
  })),
 ];
 const view={release:{id:F2_GROUP_REPAIR_DRAFT_ID,status:'DRAFT',version:'v1.7.0'},
  groups,concepts} as unknown as ReleaseView;
 return {plan,view};
}
test('F2-TAB-02: 60-character slug collision splits distinct labels without modifying source',()=>{
 const {plan,view}=scenario();
 const result=buildF2GroupRepairPlan({draftId:F2_GROUP_REPAIR_DRAFT_ID,plan,view});
 assert.equal(f2GroupSlugify(first),f2GroupSlugify(second));
 assert.equal(result.unresolved.length,0);
 assert.equal(result.stats.sourceConcepts,2);
 assert.equal(result.stats.slugFusions,1);
 assert.equal(result.stats.newGroups,1);
 assert.equal(result.stats.changedConceptLinks,1);
 assert.equal(result.stats.missingSegmentLinks,2);
 assert.equal(new Set(result.targets.map(t=>t.groupCode)).size,2);
 assert.deepEqual(result.targets.flatMap(t=>t.conceptCodes).sort(),
    plan.sector.map(c=>c.code).sort());
 assert.ok(result.targets.every(t=>t.segmentCode==='sector.parent'));
 assert.match(result.planSha256,/^[0-9a-f]{64}$/);
});
test('F2-TAB-02: missing or ambiguous parent blocks apply, never guesses segment',()=>{
 const {plan,view}=scenario();
 view.concepts=view.concepts.filter(c=>c.code!=='sector.parent');
 const result=buildF2GroupRepairPlan({draftId:F2_GROUP_REPAIR_DRAFT_ID,plan,view});
 assert.equal(result.unresolved.length,2);
 assert.equal(result.unresolved[0]!.reason,'PARENT_MISSING');
});
test('F2-TAB-02: same source and release make stable plan hash',()=>{
 const input=scenario();
 const one=buildF2GroupRepairPlan({draftId:F2_GROUP_REPAIR_DRAFT_ID,...input});
 const two=buildF2GroupRepairPlan({draftId:F2_GROUP_REPAIR_DRAFT_ID,...input});
 assert.equal(one.planSha256,two.planSha256);
});
