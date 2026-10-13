import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCollectionFilterPolicy, evaluateCollectionFilter,
  normalizeCollectionFilterType, collectionFilterTitleType,
  type CollectionFilterTypeRule } from '../src/modules/collection/collection-filter.engine.js';
import { evaluateHistoricalCollectionCandidate } from '../src/modules/collection/collection-filter.direct.js';
import { evaluateRuntimeCollectionFilter } from '../src/modules/collection/collection-filter.runtime.js';

const compile = (rules: CollectionFilterTypeRule[]) => compileCollectionFilterPolicy({
  version:1,contextWindowWords:5,weakScoreThreshold:3,
  locationWeights:{title:3,summary:2,body:1},rules,terms:[],
});
const rule = (type:string,mode:CollectionFilterTypeRule['mode'],section='DO3',sourceCode='dou') =>
  ({sourceCode,section,canonicalType:type,mode});
const item = {sourceCode:'dou',section:'DO3',sourceActType:'Aviso',
  title:'EXTRATO DE CONTRATO Nº 33/2026',evidenceComplete:false,
  materialAttachmentsUnexamined:true,body:'ICMS',provenanceConflict:false};

test('Pompeia: Aviso oficial × Extrato numerado, específico do título vence',()=>{
  const result=evaluateCollectionFilter(compile([
    rule('AVISO','KEEP_ALWAYS'),rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS'),
  ]),item);
  assert.equal(result.decision,'DISCARD');
  assert.equal(result.matchedTypeSource,'TITLE');
  assert.equal(result.matchedPattern,'EXTRATO DE CONTRATO');
});
test('Portaria oficial e Portaria Nº10 mantida pela regra cadastrada',()=>{
  const result=evaluateCollectionFilter(compile([rule('PORTARIA','KEEP_ALWAYS','DO1')]),{
    ...item,section:'DO1',sourceActType:'Portaria',title:'PORTARIA Nº 10',
  });
  assert.equal(result.decision,'KEEP');
  assert.equal(result.requiresNewTypeReview,false);
});
test('prefixo inteiro, sufixo de órgão e grafia normalizada',()=>{
  const policy=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS')]);
  for(const title of ['extráto de contrato BF nº 12/2026','EXTRATO-DE-CONTRATO PE SRP N° 1/2026'])
    assert.equal(evaluateCollectionFilter(policy,{...item,title}).decision,'DISCARD');
  assert.equal(evaluateCollectionFilter(policy,{...item,title:'EXTRATO DE CONTRATOS'}).decision,'KEEP');
  assert.equal(evaluateCollectionFilter(policy,{...item,title:'NOTÍCIA SOBRE EXTRATO DE CONTRATO'}).decision,'KEEP');
});
test('normalização remove identificadores do ato, não 5G/P2 nem todos os números',()=>{
  for(const marker of ['Nº 33/2026','N°33/2026','N. 33/2026','NÚMERO 33/2026'])
    assert.equal(normalizeCollectionFilterType('PORTARIA '+marker),'PORTARIA');
  assert.equal(normalizeCollectionFilterType('PADRAO P2 5G'),'PADRAO P2 5G');
  assert.equal(collectionFilterTitleType('PORTARIA Nº10\nEXTRATO DE CONTRATO'),'PORTARIA');
});
test('seções extras herdam somente sua principal e ausente só regra geral',()=>{
  for(const section of ['DO1','DO2','DO3']) {
    const policy=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS',section)]);
    assert.equal(evaluateCollectionFilter(policy,{...item,section:section+'E'}).decision,'DISCARD');
    assert.equal(evaluateCollectionFilter(policy,{...item,section:null}).decision,'KEEP');
  }
  const general=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS','')]);
  assert.equal(evaluateCollectionFilter(general,{...item,section:null}).decision,'DISCARD');
});
test('KEEP mais específico supera exclusão genérica, em qualquer campo',()=>{
  const policy=compile([rule('EXTRATO','EXCLUDE_ALWAYS'),
    rule('EXTRATO DE CONTRATO','KEEP_ALWAYS')]);
  assert.equal(evaluateCollectionFilter(policy,item).decision,'KEEP');
});
test('empate entre tipos diferentes mantém, independente da ordem das regras',()=>{
  const rules=[rule('AVISO DE LICITACAO','EXCLUDE_ALWAYS'),rule('EXTRATO DE CONTRATO','KEEP_ALWAYS')];
  for(const entries of [rules,[...rules].reverse()]){
    const result=evaluateCollectionFilter(compile(entries),{
      ...item,sourceActType:'AVISO DE LICITACAO',title:'EXTRATO DE CONTRATO Nº1/2026',evidenceComplete:true,
    });
    assert.equal(result.decision,'KEEP');
  }
});
test('sem casamento ou tipo vazio mantém e pede classificação',()=>{
  for(const input of [{...item,title:'TIPO NOVO',sourceActType:'OUTRO'},
    {...item,title:'',sourceActType:''}]) {
    const result=evaluateCollectionFilter(compile([]),input);
    assert.equal(result.decision,'KEEP');
    assert.equal(result.requiresNewTypeReview,true);
  }
});
test('corpo não oferece tipo; proveniência conflitante impede exclusão',()=>{
  const policy=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS')]);
  assert.equal(evaluateCollectionFilter(policy,{...item,title:'BOLETIM',body:item.title}).decision,'KEEP');
  assert.equal(evaluateCollectionFilter(policy,{...item,provenanceConflict:true}).decision,'KEEP');
});
test('casamento mais longo por palavras, não tamanho dos caracteres',()=>{
  const policy=compile([rule('AAAAAAAAAAAA','KEEP_ALWAYS'),rule('B C','EXCLUDE_ALWAYS')]);
  assert.equal(evaluateCollectionFilter(policy,{...item,sourceActType:'AAAAAAAAAAAA',title:'B C Nº2'}).decision,'DISCARD');
});
test('DOE-SP só usa metadado oficial; captura e adaptador histórico equivalentes',()=>{
  const policy=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS','ATOS NORMATIVOS','doe-sp')]);
  const runtime={policy,policyId:'x',policyRevision:1,policyVersion:1,sourceCode:'doe-sp',sourceId:'x',connectorKey:'doe-sp'};
  const publication={title:item.title,actType:'INFERIDO',contentText:'',metadata:{},
    originMetadata:{publicationType:'Aviso',section:'Atos Normativos'},files:[]};
  const capture=evaluateRuntimeCollectionFilter(runtime,publication as Parameters<typeof evaluateRuntimeCollectionFilter>[1]);
  const history=evaluateHistoricalCollectionCandidate(policy,{
    publication_id:'x',title:item.title,act_type:'INFERIDO',source_act_type:'Aviso',source_code:'doe-sp',
    section:'Atos Normativos',content_text:'',relevant_excerpt:null,evidence_complete:false,
    has_material:false,type_conflict:true,provenance_conflict:false,has_company:false,
    has_other_source:false,content_hash:null,
  });
  assert.equal(capture.decision.decision,'DISCARD');
  assert.deepEqual(capture.decision,history);
});
test('nenhuma rotina altera a política ao avaliar uma publicação histórica',()=>{
  const policy=compile([rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS')]);
  const before=JSON.stringify([...policy.rules]);
  evaluateCollectionFilter(policy,item);
  assert.equal(JSON.stringify([...policy.rules]),before);
});
