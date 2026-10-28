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
