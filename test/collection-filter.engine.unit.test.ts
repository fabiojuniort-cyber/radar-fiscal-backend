import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  compileCollectionFilterPolicy,
  evaluateCollectionFilter,
  normalizeCollectionFilterType,
} from '../src/modules/collection/collection-filter.engine.js';

function basePolicy() {
  return compileCollectionFilterPolicy({
    version: 7,
    contextWindowWords: 5,
    weakScoreThreshold: 3,
    locationWeights: {
      title: 3,
      summary: 2,
      body: 1,
    },
    rules: [
      {
        sourceCode: 'dou',
        section: 'DO3',
        canonicalType: 'EXTRATO DE CONTRATO',
        mode: 'EXCLUDE_UNLESS_STRONG',
      },
      {
        sourceCode: 'dou',
        section: 'DO1',
        canonicalType: 'PORTARIA',
        mode: 'KEEP_IF_TAX_TERM',
      },
      {
        sourceCode: 'dou',
        section: 'DO1',
        canonicalType: 'LEI',
        mode: 'KEEP_ALWAYS',
      },
      {
        sourceCode: 'dou',
        section: 'DO3',
        canonicalType: 'AVISO DE LICITACAO',
        mode: 'EXCLUDE_ALWAYS',
      },
    ],
    aliases: [
      {
        sourceCode: 'dou',
        section: 'DO3',
        alias: 'Extrato de Contrato nº',
        canonicalType: 'EXTRATO DE CONTRATO',
      },
    ],
    terms: [
      { text: 'ICMS', strength: 'STRONG' },
      { text: 'IBS', strength: 'STRONG' },
      { text: 'crédito presumido', strength: 'STRONG' },
      { text: 'tributário', strength: 'WEAK' },
      { text: 'fiscal', strength: 'WEAK' },
      { text: 'regularidade fiscal', strength: 'NEGATIVE' },
    ],
  });
}

const complete = {
  evidenceComplete: true,
  materialAttachmentsUnexamined: false,
  typeConflict: false,
  provenanceConflict: false,
} as const;

test('normalização de tipo é determinística para acentos e pontuação', () => {
  assert.equal(
    normalizeCollectionFilterType('  Instrução  Normativa / RFB '),
    'INSTRUCAO NORMATIVA RFB',
  );
});

test('tipo desconhecido sempre KEEP e entra em Novos tipos', () => {
  const decision = evaluateCollectionFilter(basePolicy(), {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'Tipo recém-publicado',
    title: 'Ato novo',
    body: 'Sem matéria tributária conhecida.',
    ...complete,
  });
  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'UNKNOWN_TYPE');
  assert.equal(decision.requiresNewTypeReview, true);
});

test('evidência incompleta e material não examinado impedem descarte', () => {
  const policy = basePolicy();
  const incomplete = evaluateCollectionFilter(policy, {
    sourceCode: 'dou',
    section: 'DO3',
    actType: 'AVISO DE LICITAÇÃO',
    title: 'Aviso',
    body: 'Compra de cadeiras',
    ...complete,
    evidenceComplete: false,
  });
  assert.deepEqual(
    [incomplete.decision, incomplete.reasonCode],
    ['KEEP', 'INCOMPLETE_EVIDENCE'],
  );

  const attachment = evaluateCollectionFilter(policy, {
    sourceCode: 'dou',
    section: 'DO3',
    actType: 'AVISO DE LICITAÇÃO',
    title: 'Aviso',
    body: 'Compra de cadeiras',
    ...complete,
    materialAttachmentsUnexamined: true,
  });
  assert.deepEqual(
    [attachment.decision, attachment.reasonCode],
    ['KEEP', 'UNEXAMINED_MATERIAL'],
  );
});

test('conflito de tipo ou proveniência falha aberto', () => {
  const policy = basePolicy();
  for (const conflict of ['typeConflict', 'provenanceConflict'] as const) {
    const decision = evaluateCollectionFilter(policy, {
      sourceCode: 'dou',
      section: 'DO3',
      actType: 'AVISO DE LICITAÇÃO',
      title: 'Aviso',
      body: 'Compra de cadeiras',
      ...complete,
      [conflict]: true,
    });
    assert.equal(decision.decision, 'KEEP');
    assert.equal(
      decision.reasonCode,
      conflict === 'typeConflict'
        ? 'TYPE_CONFLICT'
        : 'PROVENANCE_CONFLICT',
    );
  }
});

test('CNPJ/processo/valor não podem ser termos positivos autônomos', () => {
  for (const term of ['CNPJ', 'processo administrativo', 'valor total']) {
    assert.throws(
      () =>
        compileCollectionFilterPolicy({
          version: 1,
          contextWindowWords: 5,
          weakScoreThreshold: 3,
          locationWeights: { title: 3, summary: 2, body: 1 },
          rules: [],
          terms: [{ text: term, strength: 'STRONG' }],
        }),
      /cannot preserve a publication by itself/,
    );
  }
});

test('termos duplicados ou conflitantes no mesmo escopo são recusados', () => {
  const common = {
    version: 1,
    contextWindowWords: 5,
    weakScoreThreshold: 3,
    locationWeights: { title: 3, summary: 2, body: 1 },
    rules: [],
  } as const;

  assert.throws(
    () =>
      compileCollectionFilterPolicy({
        ...common,
        terms: [
          { text: 'tributário', strength: 'WEAK' },
          { text: 'TRIBUTARIO', strength: 'WEAK' },
        ],
      }),
    /duplicate filter term/,
  );

  assert.throws(
    () =>
      compileCollectionFilterPolicy({
        ...common,
        terms: [
          { text: 'regularidade fiscal', strength: 'WEAK' },
          { text: 'regularidade fiscal', strength: 'NEGATIVE' },
        ],
      }),
    /conflicting filter term strength/,
  );
});

test('EXTRATO DE CONTRATO não é preservado por CNPJ isolado', () => {
  const decision = evaluateCollectionFilter(basePolicy(), {
    sourceCode: 'dou',
    section: 'DO3',
    actType: 'Extrato de Contrato nº',
    title: 'Extrato de contrato',
    body:
      'Contratado CNPJ 12.345.678/0001-00. Processo 1234. Valor R$ 10.000.',
    ...complete,
  });
  assert.equal(decision.canonicalType, 'EXTRATO DE CONTRATO');
  assert.equal(decision.decision, 'DISCARD');
  assert.equal(decision.reasonCode, 'NO_STRONG_TERM');
});

test('termo forte resgata modo EXCLUDE_UNLESS_STRONG', () => {
  const decision = evaluateCollectionFilter(basePolicy(), {
    sourceCode: 'dou',
    section: 'DO3',
    actType: 'EXTRATO DE CONTRATO',
    title: 'Extrato de contrato',
    body:
      'Objeto: solução tecnológica para apuração do ICMS em operações interestaduais.',
    ...complete,
  });
  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'STRONG_TERM');
  assert.ok(decision.termHits.some((hit) => hit.text === 'ICMS'));
});

test('termo fraco no título alcança limiar; negativo próximo neutraliza corpo', () => {
  const policy = basePolicy();
  const title = evaluateCollectionFilter(policy, {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'PORTARIA',
    title: 'Portaria fiscal',
    body: 'Dispõe sobre procedimentos internos.',
    ...complete,
  });
  assert.equal(title.weakScore, 3);
  assert.equal(title.decision, 'KEEP');
  assert.equal(title.reasonCode, 'WEAK_TERM_THRESHOLD');

  const negative = evaluateCollectionFilter(policy, {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'PORTARIA',
    title: 'Portaria administrativa',
    body:
      'Exige regularidade fiscal do fornecedor para contratação pública.',
    ...complete,
  });
  assert.equal(negative.weakScore, 0);
  assert.equal(negative.decision, 'DISCARD');
  assert.ok(
    negative.termHits.some(
      (hit) =>
        hit.strength === 'WEAK' &&
        hit.neutralizedByNegative,
    ),
  );
});

test('KEEP_ALWAYS preserva sem executar heurística de descarte', () => {
  const decision = evaluateCollectionFilter(basePolicy(), {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'LEI',
    title: 'Lei administrativa',
    body: 'Sem termos tributários.',
    ...complete,
  });
  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'KEEP_ALWAYS');
  assert.equal(decision.termHits.length, 0);
});

test('EXCLUDE_ALWAYS só descarta com evidência completa e tipo conhecido', () => {
  const decision = evaluateCollectionFilter(basePolicy(), {
    sourceCode: 'dou',
    section: 'DO3',
    actType: 'AVISO DE LICITAÇÃO',
    title: 'Aviso ICMS',
    body: 'Compra de material.',
    ...complete,
  });
  assert.equal(decision.decision, 'DISCARD');
  assert.equal(decision.reasonCode, 'EXCLUDE_ALWAYS');
});

test('benchmark de referência supera 2 mil documentos/s', () => {
  const policy = basePolicy();
  const sample = {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'PORTARIA',
    title: 'Portaria fiscal',
    body:
      'Dispõe sobre crédito presumido e procedimentos tributários de ICMS.',
    ...complete,
  };
  const count = 25_000;
  for (let i = 0; i < 500; i += 1) {
    evaluateCollectionFilter(policy, sample);
  }
  const started = performance.now();
  for (let i = 0; i < count; i += 1) {
    evaluateCollectionFilter(policy, sample);
  }
  const elapsedMs = Math.max(performance.now() - started, 1);
  const rate = (count * 1000) / elapsedMs;
  assert.ok(
    rate >= 2_000,
    `collection filter benchmark below reference: ${rate.toFixed(0)} docs/s`,
  );
});


test('L-20: both conflicting DO3 types EXCLUDE_ALWAYS -> DISCARD; any non-excluded secondary type stays KEEP', () => {
  const policy=compileCollectionFilterPolicy({
    version:1,contextWindowWords:12,weakScoreThreshold:3,
    locationWeights:{title:3,summary:2,body:1},
    rules:[
      {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE DISPENSA DE LICITACAO',mode:'EXCLUDE_ALWAYS'},
      {sourceCode:'dou',section:'DO3',canonicalType:'AVISO DE ADJUDICACAO',mode:'EXCLUDE_ALWAYS'},
      {sourceCode:'dou',section:'DO3',canonicalType:'PORTARIA',mode:'KEEP_ALWAYS'},
      {sourceCode:'dou',section:'DO1',canonicalType:'AVISO DE ADJUDICACAO',mode:'KEEP_ALWAYS'},
    ],
    aliases:[],terms:[],
  });
  const base={
    sourceCode:'dou',section:'DO3',actType:'AVISO DE DISPENSA DE LICITACAO',
    title:'AVISO DE DISPENSA DE LICITAÇÃO 7/2026',
    body:'Prefeitura de Douradoquara/MG; 09/10/2026',
    evidenceComplete:true,materialAttachmentsUnexamined:false,
    typeConflict:true,provenanceConflict:false,
  };
  const both=evaluateCollectionFilter(policy,{...base,sourceActType:'Aviso de Adjudicação'});
  assert.deepEqual([both.decision,both.reasonCode],['DISCARD','TYPE_CONFLICT_BOTH_EXCLUDED']);
  const kept=evaluateCollectionFilter(policy,{...base,sourceActType:'PORTARIA'});
  assert.deepEqual([kept.decision,kept.reasonCode],['KEEP','TYPE_CONFLICT']);
  const unknown=evaluateCollectionFilter(policy,{...base,sourceActType:'AVISO NÃO CADASTRADO'});
  assert.deepEqual([unknown.decision,unknown.reasonCode],['KEEP','TYPE_CONFLICT']);
  const missing=evaluateCollectionFilter(policy,{...base});
  assert.deepEqual([missing.decision,missing.reasonCode],['KEEP','TYPE_CONFLICT']);
  const otherSection=evaluateCollectionFilter(policy,{...base,section:'DO1',sourceActType:'Aviso de Adjudicação'});
  assert.equal(otherSection.decision,'KEEP');
  const incomplete=evaluateCollectionFilter(policy,{...base,sourceActType:'Aviso de Adjudicação',evidenceComplete:false});
  assert.equal(incomplete.decision,'KEEP');
  const originConflict=evaluateCollectionFilter(policy,{...base,sourceActType:'Aviso de Adjudicação',provenanceConflict:true});
  assert.equal(originConflict.decision,'KEEP');
});
