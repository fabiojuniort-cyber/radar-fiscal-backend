import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileCollectionFilterPolicy,
  evaluateCollectionFilter,
} from '../src/modules/collection/collection-filter.engine.js';
import {
  initialCollectionFilterMode,
  initialCollectionFilterTerms,
} from '../src/modules/collection/collection-filter.initial-policy.js';

const complete = {
  evidenceComplete: true,
  materialAttachmentsUnexamined: false,
  typeConflict: false,
  provenanceConflict: false,
} as const;

function policyFor(
  section: string,
  canonicalType: string,
) {
  return compileCollectionFilterPolicy({
    version: 1,
    contextWindowWords: 12,
    weakScoreThreshold: 3,
    locationWeights: { title: 3, summary: 2, body: 1 },
    rules: [
      {
        sourceCode: 'dou',
        section,
        canonicalType,
        mode: initialCollectionFilterMode('dou', canonicalType),
      },
    ],
    terms: initialCollectionFilterTerms(),
  });
}

test('tipos DOU inequivocamente tributários começam em KEEP_ALWAYS', () => {
  for (const type of [
    'SOLUCAO DE CONSULTA',
    'SOLUCAO DE DIVERGENCIA',
    'ATO DECLARATORIO INTERPRETATIVO',
    'CONVENIO ICMS',
    'AJUSTE SINIEF',
    'PROTOCOLO ICMS',
    'ATO COTEPE/PMPF',
  ]) {
    assert.equal(initialCollectionFilterMode('dou', type), 'KEEP_ALWAYS');
  }
  assert.equal(
    initialCollectionFilterMode('dou', 'PORTARIA'),
    'KEEP_IF_TAX_TERM',
  );
  assert.equal(
    initialCollectionFilterMode('dou', 'EXTRATO DE CONTRATO'),
    'EXCLUDE_UNLESS_STRONG',
  );
});

test('regressão: Solução de Consulta previdenciária não pode ser descartada', () => {
  const policy = policyFor('DO1', 'SOLUCAO DE CONSULTA');
  const decision = evaluateCollectionFilter(policy, {
    sourceCode: 'dou',
    section: 'DO1',
    actType: 'SOLUCAO DE CONSULTA',
    title: 'Solução de Consulta SRRF/DISIT',
    body:
      'Assunto: Contribuições Sociais Previdenciárias. Retenção. Dispositivos legais: Código Tributário Nacional.',
    ...complete,
  });

  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'KEEP_ALWAYS');
});

test('sinais tributários inequívocos preservam tipo DOU genérico mesmo no corpo', () => {
  const signals = [
    'Código Tributário Nacional',
    'Reforma Tributária',
    'Simples Nacional',
    'IRPJ',
    'CSLL',
    'DCTFWeb',
    'EFD-Reinf',
    'benefício fiscal',
    'benefícios fiscais',
    'incentivos fiscais',
    'REIDI',
    'EQBEN',
    'TFAC',
    'CORAT',
  ];

  for (const signal of signals) {
    const decision = evaluateCollectionFilter(
      policyFor('DO1', 'PORTARIA'),
      {
        sourceCode: 'dou',
        section: 'DO1',
        actType: 'PORTARIA',
        title: 'Portaria administrativa',
        body: `Disciplina matéria referente a ${signal}.`,
        ...complete,
      },
    );
    assert.equal(
      decision.decision,
      'KEEP',
      `expected KEEP for signal: ${signal}`,
    );
    assert.equal(decision.reasonCode, 'STRONG_TERM');
  }
});

test('regressão: Resolução SUFRAMA com benefícios fiscais no plural é preservada', () => {
  const decision = evaluateCollectionFilter(
    policyFor('DO1', 'RESOLUCAO'),
    {
      sourceCode: 'dou',
      section: 'DO1',
      actType: 'RESOLUCAO',
      title: 'RESOLUÇÕES CAS-SUFRAMA DE 14 DE AGOSTO DE 2026',
      body:
        'Aprova projeto industrial na Zona Franca de Manaus com fruição de benefícios fiscais.',
      ...complete,
    },
  );

  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'STRONG_TERM');
  assert.equal(
    decision.termHits.some((hit) => hit.text === 'BENEFICIOS FISCAIS'),
    true,
  );
});

test('regressão: retificação EQBEN de habilitação REIDI é preservada', () => {
  const decision = evaluateCollectionFilter(
    policyFor('DO1', 'ATO DECLARATORIO'),
    {
      sourceCode: 'dou',
      section: 'DO1',
      actType: 'ATO DECLARATORIO',
      title: 'Retificação',
      body:
        'No Ato Declaratório Executivo EQBEN/DELEBEN/SRRF08ª/RFB, fica corrigida a habilitação ao REIDI.',
      ...complete,
    },
  );

  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'STRONG_TERM');
});

test('regressão: incidência de TFAC é preservada sem tornar taxa genérica forte', () => {
  const taxDecision = evaluateCollectionFilter(
    policyFor('DO1', 'PORTARIA'),
    {
      sourceCode: 'dou',
      section: 'DO1',
      actType: 'PORTARIA',
      title: 'Portaria de fiscalização da aviação civil',
      body: 'Disciplina hipóteses de incidência de TFAC no âmbito da ANAC.',
      ...complete,
    },
  );
  assert.equal(taxDecision.decision, 'KEEP');
  assert.equal(taxDecision.reasonCode, 'STRONG_TERM');

  const feeDecision = evaluateCollectionFilter(
    policyFor('DO3', 'EDITAL'),
    {
      sourceCode: 'dou',
      section: 'DO3',
      actType: 'EDITAL',
      title: 'Edital de concurso',
      body: 'Prevê isenção da taxa de inscrição para candidatos elegíveis.',
      ...complete,
    },
  );
  assert.equal(feeDecision.decision, 'DISCARD');
});

test('regressão: retificação CORAT de ADE sobre devedor contumaz é preservada', () => {
  const decision = evaluateCollectionFilter(
    policyFor('DO1', 'ATO DECLARATORIO'),
    {
      sourceCode: 'dou',
      section: 'DO1',
      actType: 'ATO DECLARATORIO',
      title: 'RETIFICAÇÃO',
      body:
        'No art. 1º dos Atos Declaratórios Executivos Corat nºs. 55, 56, 57, 58 e 59, de 4 de agosto de 2026, onde se lê Instrução Normativa RFB nº 2.119, de 6 de dezembro de 2026, leia-se Instrução Normativa RFB nº 2.119, de 6 de dezembro de 2022.',
      ...complete,
    },
  );

  assert.equal(decision.decision, 'KEEP');
  assert.equal(decision.reasonCode, 'STRONG_TERM');
  assert.equal(
    decision.termHits.some((hit) => hit.text === 'CORAT'),
    true,
  );
});

test('termo fiscal ambíguo no corpo continua insuficiente isoladamente', () => {
  const decision = evaluateCollectionFilter(
    policyFor('DO1', 'PORTARIA'),
    {
      sourceCode: 'dou',
      section: 'DO1',
      actType: 'PORTARIA',
      title: 'Portaria administrativa',
      body: 'Designa fiscal do contrato para acompanhamento da execução.',
      ...complete,
    },
  );

  assert.equal(decision.decision, 'DISCARD');
  assert.equal(decision.reasonCode, 'NO_TAX_TERM');
  assert.equal(decision.weakScore, 1);
});

test('EXTRATO DE CONTRATO continua sem preservação por CNPJ/valor isolados', () => {
  const decision = evaluateCollectionFilter(
    policyFor('DO3', 'EXTRATO DE CONTRATO'),
    {
      sourceCode: 'dou',
      section: 'DO3',
      actType: 'EXTRATO DE CONTRATO',
      title: 'Extrato de contrato',
      body:
        'Contratada CNPJ 12.345.678/0001-00. Valor total R$ 10.000,00. Processo 1234.',
      ...complete,
    },
  );

  assert.equal(decision.decision, 'DISCARD');
  assert.equal(decision.reasonCode, 'NO_STRONG_TERM');
});
