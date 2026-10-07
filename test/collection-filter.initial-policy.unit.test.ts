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
