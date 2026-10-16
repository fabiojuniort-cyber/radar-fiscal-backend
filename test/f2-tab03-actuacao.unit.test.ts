import assert from 'node:assert/strict';
import test from 'node:test';
import {CurationError} from '../src/modules/taxonomy/curation/curation.draft.js';
import {MULTI_ACTUACAO_DRAFT_VERSION,validateActuacaoSelection}
 from '../src/modules/taxonomy/curation/curation.f2-multi-actuacao.js';

test('F2-TAB-03 rejects last Atuação removal and invalid/duplicate concepts',()=>{
 assert.equal(MULTI_ACTUACAO_DRAFT_VERSION,'v1.8.0');
 assert.throws(()=>validateActuacaoSelection([]),
   (e:unknown)=>e instanceof CurationError&&e.code==='F2_TAB03_LAST_ACTUACAO_REQUIRED');
 for(const codes of [
   ['actuacao.produtor_rural','actuacao.produtor_rural'],
   ['sector.agronegocio'],
   ['actuacao.unknown-code'],
   Array(13).fill('actuacao.produtor_rural'),
 ]){
   assert.throws(()=>validateActuacaoSelection(codes),
     (e:unknown)=>e instanceof CurationError&&e.code==='F2_TAB03_INVALID_ACTUACAO');
 }
 assert.doesNotThrow(()=>validateActuacaoSelection(['actuacao.produtor_rural']));
 assert.doesNotThrow(()=>validateActuacaoSelection(['actuacao.produtor_rural','actuacao.servico']));
});
