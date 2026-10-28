import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveSelections,productNcmCodes,synchronizeUnit} from '../src/modules/onboarding/assistant.profile.js';
test('product evidence never mixes independent CNAE codes or ranges',()=>{
 assert.deepEqual(productNcmCodes({dimensionCode:'product',officialCodes:['1006','10.06','1006-1008','NCM 2302']}),['1006']);
 assert.deepEqual(productNcmCodes({dimensionCode:'sector',officialCodes:['1006']}),[]);
});
test('legacy global and explicit unit selections are visible without mutating a profile or inheriting to a new branch',()=>{
 const profile={tax_regime:'LUCRO_REAL',segments:['Old segment'],activities:['Legacy activity'],personalization:{products:['Manual'],ncmCodes:['2716'],taxonomy:{releaseId:'old',conceptCodes:['product.retired']},establishmentOverrides:[{establishmentId:'head',taxRegime:'LUCRO_REAL',conceptCodes:['product.manual'],ncmCodes:['1006']}]}};
 const snapshot=structuredClone(profile),units=[{id:'head',name:'Matriz',is_head_office:true},{id:'new',name:'Filial',is_head_office:false}];
 const result=effectiveSelections(profile,units);
 assert.deepEqual(result[0]!.conceptCodes,['product.manual','product.retired']);assert.deepEqual(result[0]!.ncmCodes,['1006','2716']);assert.deepEqual(result[0]!.legacyFields.products,['Manual']);
 assert.deepEqual(result[1]!.conceptCodes,[]);assert.deepEqual(result[1]!.ncmCodes,[]);assert.deepEqual(result[1]!.legacyFields.products,[]);assert.deepEqual(profile,snapshot);
});
test('explicit removal prunes stale cards and manual baseline so future saves cannot resurrect a legacy choice',()=>{
 const unit={baseConceptCodes:['product.retired'],baseNcmCodes:['2716'],cards:{'cnae:0111301':{status:'CONFIRMED' as const,conceptCodes:['product.rice'],ncmCodes:['1006']}}};
 const next=synchronizeUnit(unit,'profile','CONFIRMED',{conceptCodes:['product.rice'],ncmCodes:['1006']},new Set());
 assert.deepEqual(next.baseConceptCodes,[]);assert.deepEqual(next.baseNcmCodes,[]);assert.deepEqual(unit.baseConceptCodes,['product.retired']);
});
