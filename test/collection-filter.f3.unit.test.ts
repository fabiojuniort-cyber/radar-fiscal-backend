import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCollectionFilterPolicy, evaluateCollectionFilter,
  normalizeCollectionFilterType, collectionFilterTitleType,
  type CollectionFilterTypeRule } from '../src/modules/collection/collection-filter.engine.js';
import { evaluateHistoricalCollectionCandidate, couldMatchDirectRule } from '../src/modules/collection/collection-filter.direct.js';
import {rememberDirectPreview,findDirectPreview,forgetDirectPreview,DIRECT_PREVIEW_TTL_MS}
  from '../src/modules/collection/collection-filter.preview-witness.js';
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

test('aliases cannot activate opposing modes for one normalized prefix identity',()=>{
  assert.throws(()=>compileCollectionFilterPolicy({version:1,contextWindowWords:5,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},terms:[],
    rules:[rule('EXTRATO','EXCLUDE_ALWAYS'),rule('AVISO','KEEP_ALWAYS')],
    aliases:[{sourceCode:'dou',section:'DO3',alias:'EXTRATO',canonicalType:'AVISO'}],
  }),/conflicting filter rule/);
});

test('different saved extra/principal scopes remain valid and tied KEEP wins',()=>{
  const policy=compile([rule('EXTRATO','EXCLUDE_ALWAYS','DO3'),rule('EXTRATO','KEEP_ALWAYS','DO3E')]);
  assert.equal(evaluateCollectionFilter(policy,{...item,section:'DO3E'}).decision,'KEEP');
});

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
  assert.equal(collectionFilterTitleType('PORTARIA Nº10\nEXTRATO DE CONTRATO'),'Portaria');
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

test('F3-PERF-02: title-only necessary condition never drops a winning rule or alias',()=>{
  const exclude=rule('EXTRATO DE CONTRATO','EXCLUDE_ALWAYS');
  const policy=compileCollectionFilterPolicy({
    version:1,contextWindowWords:5,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},terms:[],
    rules:[exclude,rule('EXTRATO DE CONTRATO ESPECIAL','KEEP_ALWAYS'),
      rule('PORTARIA','KEEP_ALWAYS','DO1')],
    aliases:[{sourceCode:'dou',section:'DO3',alias:'AVISO DE CONTRATO',
      canonicalType:'EXTRATO DE CONTRATO'}],
  });
  const cases=[
    ['EXTRATO DE CONTRATO Nº 33/2026','DO3'],
    ['AVISO DE CONTRATO Nº 33/2026','DO3E'],
    ['extráto de contrato BF - SEFAZ','DO3'],
    ['EXTRATO DE CONTRATO ESPECIAL Nº 33/2026','DO3'],
    ['PORTARIA Nº 10/2026','DO3'],
    ['NOTÍCIA SOBRE EXTRATO DE CONTRATO','DO3'],
    ['EXTRATO DE CONTRATOS Nº 34','DO3'],
    ['EXTRATO DE CONTRATO Nº 35','DO1'],
  ] as const;
  for(const [title,section] of cases){
    const decision=evaluateCollectionFilter(policy,{...item,title,section,
      evidenceComplete:true,materialAttachmentsUnexamined:false});
    if(decision.decision==='DISCARD'&&decision.matchedRuleName===
      normalizeCollectionFilterType(exclude.canonicalType)){
      assert.ok(couldMatchDirectRule(policy,exclude,title,section),
        'winning DISCARD cannot be excluded by fast precheck: '+title);
    }
  }
  assert.equal(couldMatchDirectRule(policy,exclude,'AVISO DE CONTRATO Nº 33','DO3E'),true,
    'aliases inherit the principal section');
  assert.equal(couldMatchDirectRule(policy,exclude,'PORTARIA Nº 1','DO3'),false);
  assert.equal(couldMatchDirectRule(policy,exclude,'EXTRATO DE CONTRATOS Nº 1','DO3'),false);
  assert.equal(couldMatchDirectRule(policy,exclude,'EXTRATO DE CONTRATO Nº 1','DO1'),false);
});

test('F3-PERF-02: preview witness is user-bound, mode-bound, short-lived and single-use',()=>{
  const db={};
  const savedRule={sourceCode:'dou',section:'DO3',
    canonicalType:'Extrato de contrato',mode:'EXCLUDE_ALWAYS' as const,newTypeId:'queue-1'};
  const witness={userId:'admin-1',requested:savedRule,
    rule:{...savedRule,canonicalType:'EXTRATO DE CONTRATO'},
    count:42,token:'hash-123',policyRevision:10,
    confirmationToken:'confirm-123',archiveStamp:'archive-1',issuedAt:1000};
  rememberDirectPreview(db,witness,1000);
  const lookup=(userId:string,input:typeof savedRule,count=42,token='hash-123',
    revision=10,confirmation='confirm-123',now=1001)=>
    findDirectPreview(db,userId,input,count,token,revision,confirmation,now);
  assert.ok(lookup('admin-1',savedRule));
  assert.equal(lookup('admin-2',savedRule),undefined,'another admin cannot reuse a preview');
  assert.equal(lookup('admin-1',{...savedRule,mode:'KEEP_ALWAYS'}),undefined);
  assert.equal(lookup('admin-1',{...savedRule,newTypeId:'queue-2'}),undefined);
  assert.equal(lookup('admin-1',savedRule,43),undefined);
  assert.equal(lookup('admin-1',savedRule,42,'forged'),undefined);
  assert.equal(lookup('admin-1',savedRule,42,'hash-123',11),undefined);
  assert.equal(lookup('admin-1',savedRule,42,'hash-123',10,'forged'),undefined);
  assert.equal(lookup('admin-1',savedRule,42,'hash-123',10,'confirm-123',
    1001+DIRECT_PREVIEW_TTL_MS),undefined,'witness expires');
  rememberDirectPreview(db,witness,1000);
  const found=lookup('admin-1',savedRule);
  assert.ok(found);
  forgetDirectPreview(db,found);
  assert.equal(lookup('admin-1',savedRule),undefined,'witness consumed');
  assert.equal(findDirectPreview({},'admin-1',savedRule,42,'hash-123',10,'confirm-123',1001),
    undefined,'another process/db gets safe full-scan fallback');
});
