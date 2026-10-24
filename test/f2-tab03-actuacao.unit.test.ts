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

test('F2-TAB-03: publish gate rejects unassigned CNAE only in v1.8, preserves v1.7 rules',async()=>{
 const {validateReleaseView}=await import('../src/modules/taxonomy/curation/curation.draft.js');
 const mk=(version:string,atuacaoCodes:string[])=>({
   release:{id:'release-fixture',version,status:version==='v1.7.0'?'PUBLISHED':'DRAFT'},
   dimensions:[
     {code:'sector',profileVisible:false,officialCodeType:'CNAE',name:'Segmento'},
     {code:'actuacao',profileVisible:false,officialCodeType:null,name:'Atuação'},
   ],
   groups:[],
   concepts:[
     {code:'sector.cnae_0111301',label:'Cultivo de arroz',dimensionCode:'sector',
       membershipStatus:'INCLUDED',officialCodes:['0111301'],atuacaoCodes,
       aliases:[],groupId:null},
     {code:'actuacao.produtor_rural',label:'Produtor rural',dimensionCode:'actuacao',
       membershipStatus:'INCLUDED',officialCodes:[],aliases:[],groupId:null},
   ],
 }) as unknown as import('../src/modules/taxonomy/curation/curation.read.js').ReleaseView;
 const issuesV17=await validateReleaseView(null,mk('v1.7.0',[]));
 assert.equal(issuesV17.some(x=>x.code==='F2_TAB03_CNAE_ACTUACAO_REQUIRED'),false);
 const issuesMissing=await validateReleaseView(null,mk('v1.8.0',[]));
 assert.equal(issuesMissing.filter(x=>x.code==='F2_TAB03_CNAE_ACTUACAO_REQUIRED').length,1);
 const issuesOK=await validateReleaseView(null,mk('v1.8.0',['actuacao.produtor_rural']));
 assert.equal(issuesOK.some(x=>x.code==='F2_TAB03_CNAE_ACTUACAO_REQUIRED'),false);
});
