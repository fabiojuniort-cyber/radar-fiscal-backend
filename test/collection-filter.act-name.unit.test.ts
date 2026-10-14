import assert from 'node:assert/strict';
import test from 'node:test';
import {collectionFilterActName,compileCollectionFilterPolicy,evaluateCollectionFilter} from '../src/modules/collection/collection-filter.engine.js';
import {groupCollectionFilterActNames} from '../src/modules/collection/collection-filter.act-name-inventory.js';
import {resolveDirectActNameRule} from '../src/modules/collection/collection-filter.direct.js';

const examples=[
  ['DESPACHO DO SECRETÁRIO, DE 13 DE OUTUBRO DE 2026','Despacho do Secretário'],
  ['Despacho do Chefe de Departamento - Substituto - DE 13/10/2026','Despacho do Chefe de Departamento'],
  ['DESPACHO Nº 238/630/2026, DE 13…','Despacho'],
  ['Comunicado de abertura PGE-SP','Comunicado de Abertura'],
  ['PORTARIA 123/2026','Portaria'],['COMUNICADO (RETIFICAÇÃO)','Comunicado'],
] as const;
for(const [title,expected] of examples)test('Nome do ato: '+title,()=>assert.equal(collectionFilterActName(title),expected));
const policy=(sourceCode:string)=>compileCollectionFilterPolicy({version:1,contextWindowWords:5,
  weakScoreThreshold:3,locationWeights:{title:3,summary:2,body:1},terms:[],rules:[
    {sourceCode,section:'',canonicalType:'COMUNICADO',mode:'EXCLUDE_ALWAYS'},
    {sourceCode,section:'',canonicalType:'COMUNICADO DE ABERTURA',mode:'KEEP_ALWAYS'},
  ]});
for(const sourceCode of ['dou','doe-sp']){
  test(sourceCode+': title name is decisive; longest whole-word prefix wins',()=>{
    const p=policy(sourceCode);
    const input={sourceCode,section:'DO1',sourceActType:'COMUNICADO',evidenceComplete:true};
    assert.equal(evaluateCollectionFilter(p,{...input,title:'Comunicado de abertura PGE-SP'}).decision,'KEEP');
    assert.equal(evaluateCollectionFilter(p,{...input,title:'Comunicado Nº 1/2026'}).decision,'DISCARD');
    const unknown=evaluateCollectionFilter(p,{...input,title:'Comunicados Nº 2'});
    assert.equal(unknown.reasonCode,'UNKNOWN_TYPE');assert.equal(unknown.decision,'KEEP');
    assert.equal(evaluateCollectionFilter(p,{...input,title:'NOTÍCIA SOBRE COMUNICADO'}).decision,'KEEP');
    assert.equal(evaluateCollectionFilter(p,{...input,title:'Comunicado',provenanceConflict:true}).decision,'KEEP');
  });
}
test('real archive groups are distinct, stable, deduplicated and not extrapolated from samples',()=>{
  const p=compileCollectionFilterPolicy({version:1,contextWindowWords:5,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},rules:[],terms:[]});
  const rows=Array.from({length:1031},(_,i)=>({publication_id:String(i),source_code:'dou',section:'DO1',
    title:i<1000?'Comunicado Nº '+i:'Comunicado de abertura PGE-SP'}));
  const before=JSON.stringify(rows);
  const groups=groupCollectionFilterActNames([...rows,rows[0]!],p);
  assert.equal(groups.length,2);assert.equal(groups[0]?.occurrence_count,1000);assert.equal(groups[1]?.occurrence_count,31);
  assert.equal(groups[0]?.examples.length,3);assert.equal(groups[1]?.examples.length,3);
  assert.ok(groups.every(x=>x.requires_review));
  assert.deepEqual(groups.map(x=>x.id),groupCollectionFilterActNames(rows,p).map(x=>x.id));
  assert.equal(JSON.stringify(rows),before);
});

test('F3-NOME-02: saved rules, aliases and scoped terms retain all words and numbers',()=>{
  const input={version:1,contextWindowWords:5,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},
    rules:[{sourceCode:'dou',section:'DO3',canonicalType:'EXTRATO DO 4 TERMO ADITIVO',mode:'EXCLUDE_ALWAYS' as const},
      {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE DISPENSA ELETRONICA UASG 988675',mode:'EXCLUDE_ALWAYS' as const},
      {sourceCode:'dou',section:'DO3',canonicalType:'DESPACHO - SUBSTITUTO',mode:'KEEP_IF_TAX_TERM' as const}],
    aliases:[{sourceCode:'dou',section:'DO3',alias:'COMUNICADO (INTERNO)',canonicalType:'DESPACHO - SUBSTITUTO'}],
    terms:[{text:'ICMS',strength:'STRONG' as const,canonicalType:'DESPACHO (INTERNO)'}]};
  const original=JSON.stringify(input);const p=compileCollectionFilterPolicy(input);
  const patterns=[...p.patterns.values()].flat().map(x=>x.pattern);
  for(const name of ['EXTRATO DO 4 TERMO ADITIVO','AVISO DE DISPENSA ELETRONICA UASG 988675','DESPACHO SUBSTITUTO','COMUNICADO INTERNO'])
    assert.ok(patterns.includes(name),name);
  assert.equal(p.terms[0]?.canonicalType,'DESPACHO INTERNO');
  for(const title of ['Extrato do Convênio nº 5','Aviso de Dispensa Eletronica UASG 123456','Despacho Nº 10','Comunicado Nº 10']){
    const d=evaluateCollectionFilter(p,{sourceCode:'dou',section:'DO3',title,body:'ICMS',evidenceComplete:true});
    assert.equal(d.reasonCode,'UNKNOWN_TYPE',title);assert.equal(d.decision,'KEEP');
  }
  // No shorter prefix was invented from any saved rule or alias.
  assert.equal(patterns.includes('EXTRATO DO'),false);
  assert.equal(patterns.includes('AVISO DE DISPENSA ELETRONICA UASG'),false);
  assert.equal(JSON.stringify(input),original);
});

test('numeric saved variants remain distinct, without implicit broader exclusions',()=>{
  const rules=Array.from({length:3000},(_,n)=>({sourceCode:'dou',section:'DO1',
    canonicalType:'COMUNICADO '+n,mode:'EXCLUDE_ALWAYS' as const}));
  const p=compileCollectionFilterPolicy({version:1,contextWindowWords:5,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},rules,terms:[]});
  assert.equal(p.rules.size,3000);assert.equal([...p.patterns.values()].flat().length,3000);
  assert.equal(evaluateCollectionFilter(p,{sourceCode:'dou',section:'DO1',title:'Comunicado Nº 10',evidenceComplete:true}).decision,'KEEP');
});

test('direct preview preserves saved identity and only lexically normalizes user rule input',()=>{
  const input={sourceCode:'dou',section:'DO1',canonicalType:'DESPACHO - SUBSTITUTO',mode:'EXCLUDE_ALWAYS' as const};
  assert.equal(resolveDirectActNameRule(input,[]).canonicalType,'DESPACHO SUBSTITUTO');
  assert.equal(resolveDirectActNameRule(input,[{source_code:'dou',section:'DO1',canonical_type:input.canonicalType}]).canonicalType,input.canonicalType);
  assert.equal(resolveDirectActNameRule({...input,canonicalType:'EXTRATO DO 4 TERMO ADITIVO'},[]).canonicalType,'EXTRATO DO 4 TERMO ADITIVO');
});
