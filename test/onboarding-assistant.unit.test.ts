import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeUnitCard,phraseMapping,phraseSegment} from '../src/modules/onboarding/assistant.model.js';
test('card removal preserves overlapping choices of another CNAE and preexisting manual choices',()=>{
 const base={baseConceptCodes:['product.manual'],baseNcmCodes:['1213'],cards:{}};
 const a=mergeUnitCard(base,'cnae:0111301',{status:'CONFIRMED',conceptCodes:['product.rice'],ncmCodes:['230240']});
 const b=mergeUnitCard(a.unit,'cnae:0111302',{status:'CONFIRMED',conceptCodes:['product.rice','product.corn'],ncmCodes:['230240']});
 const removed=mergeUnitCard(b.unit,'cnae:0111301',{status:'SKIPPED',conceptCodes:[],ncmCodes:[]});
 assert.deepEqual(removed.conceptCodes,['product.corn','product.manual','product.rice']);
 assert.deepEqual(removed.ncmCodes,['1213','230240']);
 const last=mergeUnitCard(removed.unit,'cnae:0111302',{status:'CONFIRMED',conceptCodes:[],ncmCodes:[]});
 assert.deepEqual(last.conceptCodes,['product.manual']);assert.deepEqual(last.ncmCodes,['1213']);
 assert.deepEqual(base.cards,{},'merge does not mutate another snapshot');
});
test('a new unit starts empty and does not inherit a matrix selection',()=>{
 const head=mergeUnitCard({baseConceptCodes:[],baseNcmCodes:[],cards:{}},'cnae:0111301',{status:'CONFIRMED',conceptCodes:['product.rice'],ncmCodes:['1006']});
 const branch=mergeUnitCard({baseConceptCodes:[],baseNcmCodes:[],cards:{}},'cnae:6201501',{status:'SKIPPED',conceptCodes:[],ncmCodes:[]});
 assert.deepEqual(branch.conceptCodes,[]);assert.deepEqual(branch.ncmCodes,[]);assert.deepEqual(head.ncmCodes,['1006']);
});
test('32 explicit F2 parent mappings; unknown/no corresponding domain uses generico',()=>{
 assert.equal(Object.keys(phraseMapping).length,32);
 assert.equal(phraseSegment('Agropecuária, pesca e insumos agrícolas'),'agro');
 assert.equal(phraseSegment('Jurídico, contabilidade e auditoria'),'generico');
 assert.equal(phraseSegment('future segment'),'generico');
});
