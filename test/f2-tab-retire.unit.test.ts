import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {
 RETIRED_TAXONOMY_DIMENSIONS,F2_TAB_DRAFT_ID,
 makeRetirementPlan,plannedToRetire,
} from '../src/infrastructure/database/taxonomy-f2-tab-retire-draft.js';

test('F2-TAB-01: exact five dimensions, confirmed draft and deterministic plan digest',()=>{
 assert.deepEqual([...RETIRED_TAXONOMY_DIMENSIONS],
  ['treatment','act_type','platform','tax_species','sphere']);
 assert.equal(F2_TAB_DRAFT_ID,'52791d3b-afdc-496f-8ada-c6cd5c819dff');
 const plan=makeRetirementPlan({
  draftId:F2_TAB_DRAFT_ID,version:'v1.7.0',status:'DRAFT',
  dimensions:RETIRED_TAXONOMY_DIMENSIONS.map(dimension=>({
   dimension,dimension_status:'INCLUDED',included:3,retired:0,groups:0,relations:0,mappings:0,relation_rules:0,
  })),historical:{publishedConceptMemberships:2000,automaticTags:91,manualTags:9},
 });
 assert.match(plan.planSha256,/^[a-f0-9]{64}$/);
 assert.equal(makeRetirementPlan({...plan}).planSha256===plan.planSha256,false,
  'hash requires raw snapshot, not a plan with an embedded digest');
 assert.equal(plannedToRetire(plan),5);
 const done=makeRetirementPlan({...plan,
  dimensions:plan.dimensions.map(x=>({...x,dimension_status:'RETIRED',included:0,retired:3})),
 });
 assert.equal(plannedToRetire(done),0);
 assert.deepEqual(done.historical,plan.historical);
});

test('F2-TAB-01: rollback-safe CLI permits only membership updates and no physical deletion',()=>{
 const source=readFileSync(new URL('../src/infrastructure/database/taxonomy-f2-tab-retire-draft.ts',import.meta.url),'utf8');
 const sqlBlocks=[...source.matchAll(/client\.query\(\s*`([\s\S]*?)`/g)].map(match=>match[1]??'');
 const mutations=sqlBlocks.filter(sql=>/^\s*(?:UPDATE|DELETE|INSERT|TRUNCATE)\b/i.test(sql));
 assert.equal(mutations.length,2);
 assert.ok(mutations.every(sql=>/^\s*UPDATE\s+taxonomy_release_(?:concepts|dimensions)\b/i.test(sql)));
 assert.ok(mutations.every(sql=>/membership_status='RETIRED'/.test(sql)));
 assert.ok(mutations.every(sql=>/release_id=\$1::uuid/.test(sql)));
 assert.ok(source.includes('BEGIN TRANSACTION READ ONLY'));
 assert.ok(source.includes('withCuratorTransaction(pool,client=>apply(client,expected))'));
 assert.ok(!/\b(?:DELETE|TRUNCATE)\s+FROM\s+taxonomy_/i.test(source));
});
