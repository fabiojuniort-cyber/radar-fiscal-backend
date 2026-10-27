import assert from 'node:assert/strict';
import test from 'node:test';
import {legacyActivityCards,upgradeLegacyUnit,mergeUnitCard,selectableAssistantConcept,phraseMapping,phraseSegment,phraseSegments} from '../src/modules/onboarding/assistant.model.js';
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
 assert.deepEqual(phraseSegments('Energia, petróleo, gás e combustíveis'),['energia','combustiveis']);
 assert.deepEqual(phraseSegments('Mineração, metalurgia e produtos metálicos'),['mineracao','metalurgia']);
 assert.equal(new Set(Object.values(phraseMapping).flat()).size,19);
});

test('a product with a seven-digit NCM is selectable; a CNAE activity is not a segment',()=>{
 assert.equal(selectableAssistantConcept({dimensionCode:'product',officialCodes:['1234567']}),true);
 assert.equal(selectableAssistantConcept({dimensionCode:'sector',officialCodes:['6201501']}),false);
 assert.equal(selectableAssistantConcept({dimensionCode:'sector',officialCodes:[]}),true);
});

test('legacy multi-segment CNAE conversion preserves other segments and manual extras on removal',()=>{
 const original={baseConceptCodes:['product.base'],baseNcmCodes:['1213'],cards:{'cnae:0111301':{status:'CONFIRMED' as const,conceptCodes:['product.rice','product.other','product.manual'],ncmCodes:['1006','2716','999']}}};
 const upgraded=upgradeLegacyUnit(original,[
  {cnaeCode:'0111301',segmentCode:'sector.agro',suggestions:[{target:'product.rice'},{target:'1006'}]},
  {cnaeCode:'0111301',segmentCode:'sector.energy',suggestions:[{target:'product.other'},{target:'2716'}]},
 ]);
 const removed=mergeUnitCard(upgraded,'segment:sector.agro',{status:'CONFIRMED',conceptCodes:[],ncmCodes:[]});
 assert.deepEqual(removed.conceptCodes,['product.base','product.manual','product.other']);
 assert.deepEqual(removed.ncmCodes,['1213','2716','999']);
 assert.ok(original.cards['cnae:0111301'],'source snapshot not mutated');
 assert.equal(upgraded.cards['cnae:0111301'],undefined);
});

test('GET legacy cards deduplicate the same CNAE while retaining all published segment suggestions',()=>{
 const rows=[
  {establishmentId:'head',cnaeCode:'0111301',segmentCode:'sector.agro',suggestions:[{kind:'PRODUCT',target:'product.rice',segment:'Agro'}]},
  {establishmentId:'head',cnaeCode:'0111301',segmentCode:'sector.food',suggestions:[{kind:'NCM',target:'1006',segment:'Food'}]},
  {establishmentId:'branch',cnaeCode:'0111301',segmentCode:'sector.agro',suggestions:[]},
 ];
 const legacy=legacyActivityCards(rows);
 assert.equal(legacy.length,2);
 assert.deepEqual(legacy[0].suggestions.map(s=>s.target),['product.rice','1006']);
 assert.equal(rows[0].suggestions.length,1,'GET conversion never mutates segment rows');
});
