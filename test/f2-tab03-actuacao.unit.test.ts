import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {validateF2Tab03Actuacoes} from '../src/modules/taxonomy/curation/curation.actuacao-multiple.js';

test('F2-TAB-03: CNAE must keep 1..12 distinct registered Atuação codes',()=>{
 assert.deepEqual(validateF2Tab03Actuacoes(['actuacao.produtor_rural']),['actuacao.produtor_rural']);
 assert.deepEqual(validateF2Tab03Actuacoes(['actuacao.servico','actuacao.produtor_rural']),
  ['actuacao.servico','actuacao.produtor_rural']);
 for(const codes of [[],['actuacao.servico','actuacao.servico'],
  ['sector.agro'],['actuacao.outra;DROP'],Array(13).fill(0).map((_,i)=>'actuacao.item_'+i)]){
  assert.throws(()=>validateF2Tab03Actuacoes(codes),/F2_TAB03_/);
 }
});
test('F2-TAB-03: migration adds release-scoped overlay and does not rewrite published v1.7 source',()=>{
 const migration=readFileSync('migrations/072_f2_multi_actuacao_draft.sql','utf8');
 assert.match(migration,/CREATE TABLE public\.taxonomy_release_cnae_actuacoes/);
 assert.match(migration,/PRIMARY KEY \(release_id, cnae_code, release_actuacao_concept_id\)/);
 assert.match(migration,/taxonomy_guard_release_membership/);
 assert.doesNotMatch(migration,/\b(?:UPDATE|DELETE|TRUNCATE)\s+(?:FROM\s+)?(?:public\.)?taxonomy_release_actuacao_cnae_origins\b/i);
 assert.doesNotMatch(migration,/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?taxonomy_releases\b/i);
});
