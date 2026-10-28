import assert from 'node:assert/strict';
import test from 'node:test';
import {dimensionGroups,dimensionGroupReviewed} from '../src/modules/onboarding/assistant.dimensions.js';
test('three groups cover each of the nine dimensions exactly once and read legacy progress without writes',()=>{
 assert.deepEqual(dimensionGroups.map(g=>[g.title,g.dimensions.length]),[['Tributos e regime',2],['Operações e documentos',3],['Obrigações e contexto',4]]);
 const codes=dimensionGroups.flatMap(g=>g.dimensions);assert.equal(codes.length,9);assert.equal(new Set(codes).size,9);
 const group=dimensionGroups[0]!;const legacy={'dimension:tax':{},'dimension:regime':{}};const before=JSON.stringify(legacy);
 assert.equal(dimensionGroupReviewed(legacy,group,codes),true);assert.equal(JSON.stringify(legacy),before);
 assert.equal(dimensionGroupReviewed({'dimension:tax':{}},group,codes),false);
 assert.equal(dimensionGroupReviewed({'dimension-group:tax_regime':{}},group,codes),true);
});


import {publishedAssistantReader} from '../src/modules/onboarding/assistant.release.js';
import type {SqlRunner} from '../src/modules/taxonomy/curation/curation.read.js';
test('published snapshot cache is bounded, release-keyed, excludes drafts and never caches failures',async()=>{
 let reads=0,fail=false,status='PUBLISHED';
 const run=(async(text:string,params:unknown[]=[])=>{reads++;if(fail)throw Error('DB unavailable');if(text.includes("manifest->'f2Operational'"))return [{approval:{ruleVersion:'onb03-t07-t08-v3',links:[{cnae:'0111301',kind:'PRODUCT',target:'product.rice',segment:'Agro'}]}}];if(text.includes('FROM taxonomy_releases'))return [{id:params[0],version:'v1',status,created_at:'2026-01-01',published_at:'2026-01-01',previous_release_id:null,change_notes:null}];return [];}) as SqlRunner;
 const read=publishedAssistantReader(1),first=await read(run,'r1'),coldReads=reads;
 assert.equal(first?.links.length,1);assert.equal((await read(run,'r1'))?.view.release.id,'r1');assert.equal(reads,coldReads,'warm saves do not load release/manifest again');
 await read(run,'r2');assert.ok(reads>coldReads);const afterTwo=reads;await read(run,'r1');assert.ok(reads>afterTwo,'bounded cache evicts earlier releases');
 status='DRAFT';assert.equal(await read(run,'draft'),null);const draftReads=reads;assert.equal(await read(run,'draft'),null);assert.ok(reads>draftReads);
 status='PUBLISHED';fail=true;await assert.rejects(read(run,'retry'));fail=false;assert.ok(await read(run,'retry'));
});
