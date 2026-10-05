import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyDouContractExcerpt,
  DOU_SCOPE_RULE_VERSION,
  type DouScopeClassification,
  type DouScopePublication,
} from '../src/modules/collection/dou-scope.rules.js';

function excerpt(object: string, overrides: Partial<DouScopePublication> = {}, additionalContent = ''): DouScopePublication {
  return {
    title: 'EXTRATO DE CONTRATO Nº 7/2026',
    actType: 'EXTRATO DE CONTRATO',
    agency: 'Órgão público federal',
    content: [
      'Contratante: UNIÃO.', 'Contratada: Fornecedora Privada Ltda.', 'CNPJ: 12.345.678/0001-90.',
      'Pregão Eletrônico nº 7/2026.', `Objeto: ${object}.`, 'Valor Global: R$ 100.000,00.',
      'Vigência: 01/10/2026 a 30/09/2027.', 'Fundamento Legal: Lei nº 14.133/2021.', additionalContent,
    ].filter(Boolean).join(' '),
    ...overrides,
  };
}
function classified(publication: DouScopePublication): DouScopeClassification {
  const classification = classifyDouContractExcerpt(publication);
  ok(classification !== null);
  equal(classification.ruleVersion, DOU_SCOPE_RULE_VERSION);
  return classification;
}

test('rule applies only to the explicit EXTRATO DE CONTRATO title family', () => {
  equal(classifyDouContractExcerpt(excerpt('Aquisição de papel A4', { title: 'EXTRATO DE TERMO ADITIVO Nº 7/2026' })), null);
});
test('proven routine procurement is ignored despite incidental CNPJ and procurement law', () => {
  const c = classified(excerpt('Aquisição de papel A4'));
  equal(c.category, 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA'); equal(c.decision, 'IGNORE');
  deepEqual(c.reasonCodes, ['procurement_structure_confirmed', 'routine_object_office_supplies']);
});
test('fiscal boilerplate does not convert routine procurement into tax relevance', () => {
  const c = classified(excerpt('CONTRATAÇÃO DE SERVIÇOS DE LIMPEZA E CONSERVAÇÃO PREDIAL', {}, 'O fiscal do contrato será designado. Pagamento mediante nota fiscal e regularidade fiscal.'));
  equal(c.category, 'CONTRATACAO_ADMINISTRATIVA_ROTINEIRA'); equal(c.decision, 'IGNORE');
});
test('keeps a concession hidden behind the generic contract-excerpt title', () => {
  const c = classified(excerpt('Concessão para exploração da infraestrutura rodoviária da BR-000'));
  equal(c.category, 'REGULATORIO_CONCESSAO'); equal(c.decision, 'KEEP');
});
test('keeps a tax transaction', () => {
  const c = classified(excerpt('Transação tributária de débitos inscritos em dívida ativa'));
  equal(c.category, 'TRIBUTARIO_FISCAL'); equal(c.decision, 'KEEP');
});
test('keeps an explicit material corporate event', () => {
  const c = classified(excerpt('Transferência de controle societário da empresa Alfa S.A.'));
  equal(c.category, 'EMPRESARIAL_RELEVANTE'); equal(c.decision, 'KEEP');
});
test('routine object cannot hide incorporation of the contractor or corporate succession', () => {
  for (const clause of [
    'O contrato formaliza a incorporação da contratada pela empresa Beta S.A., sucessora em todos os direitos e obrigações.',
    'A empresa Beta S.A. é sucessora em todos os direitos e obrigações.',
  ]) {
    const c = classified(excerpt('Aquisição de papel A4', {}, clause));
    equal(c.category, 'EMPRESARIAL_RELEVANTE'); equal(c.decision, 'KEEP');
  }
});
test('explicit corporate passive and active verb forms are KEEP', () => {
  for (const clause of [
    'A contratada foi incorporada pela empresa Beta S.A.',
    'A contratada será incorporada pela empresa Beta S.A.',
    'A empresa incorpora a contratada.',
    'A empresa Beta deverá incorporar a contratada.',
  ]) {
    const c = classified(excerpt('Aquisição de papel A4', {}, clause));
    equal(c.category, 'EMPRESARIAL_RELEVANTE'); equal(c.decision, 'KEEP');
  }
});
test('corporate morphology without an unequivocal relation remains REVIEW, not routine or corporate KEEP', () => {
  for (const clause of [
    'A sociedade Alfa foi cindida parcialmente.',
    'A contratada fundiu-se com a empresa Beta S.A.',
    'A parte sucedida ainda será identificada.',
    'Os bens serão incorporados ao patrimônio da contratante.',
    'A parte informou que incorporará bens e que os incorporaria novamente.',
  ]) {
    const c = classified(excerpt('Aquisição de papel A4', {}, clause));
    equal(c.decision, 'REVIEW'); equal(c.category, 'AMBIGUO');
  }
});
test('instituting electronic invoice issuance is tax relevance, not billing boilerplate', () => {
  const c = classified(excerpt('Aquisição de papel A4', {}, 'Fica instituída a obrigatoriedade de emissão de notas fiscais eletrônicas.'));
  equal(c.decision, 'KEEP'); equal(c.category, 'TRIBUTARIO_FISCAL');
  ok(c.reasonCodes.includes('electronic_invoice_obligation'));
});
test('unknown material clauses never inherit routine status from the object in any available text', () => {
  const signals = [
    'A contratada foi incorporada pela empresa Beta S.A.',
    'A contratada será incorporada pela empresa Beta S.A.',
    'A empresa incorpora a contratada.',
    'A contratada será sucedida pela empresa Beta S.A.',
    'Fica determinada a retenção do INSS.',
    'Dispõe sobre contribuição previdenciária sobre receita bruta.',
    'Institui obrigações acessórias no eSocial e na EFD-Reinf.',
    'Altera a emissão de NF-e e a DCTFWeb.',
    'Determina a retenção do IRRF.',
    'Fica instituída a obrigatoriedade de emissão de notas fiscais eletrônicas.',
    'Altera os requisitos de regularidade fiscal.',
    'Autoriza serviços de telecomunicações pela contratada.',
    'Cláusula adicional: efeito econômico ainda não classificado.',
  ];
  for (const signal of signals) {
    for (const publication of [
      excerpt('Aquisição de papel A4', {}, signal),
      excerpt('Aquisição de papel A4', { metadata: { dou: { abstract: signal } } }),
      excerpt('Aquisição de papel A4', { metadata: { dou: { continuationTitles: [signal] } } }),
      excerpt('Aquisição de papel A4', { metadata: { dou: { continuationAbstracts: [signal] } } }),
    ]) {
      const c = classified(publication);
      ok(c.decision !== 'IGNORE', `${signal}: ${JSON.stringify(publication)}`);
    }
  }
});
test('unrecognized clauses fail safe even without a known relevance keyword', () => {
  const body = classified(excerpt('Aquisição de papel A4', {}, 'Cláusula adicional: efeito econômico ainda não classificado.'));
  equal(body.decision, 'REVIEW'); deepEqual(body.reasonCodes, ['unrecognized_administrative_content']);
  const metadata = classified(excerpt('Aquisição de papel A4', { metadata: { dou: { abstract: 'Determina efeito econômico ainda não classificado.' } } }));
  equal(metadata.decision, 'REVIEW'); deepEqual(metadata.reasonCodes, ['unrecognized_supplementary_text']);
});
test('neutral fiscal phrases cannot erase normative qualifiers in the same or next clause', () => {
  for (const signal of [
    'Pagamento mediante nota fiscal eletrônica cuja emissão passa a ser obrigatória.',
    'Pagamento mediante nota fiscal. Fica instituída a obrigatoriedade de emissão de notas fiscais eletrônicas.',
    'Conferência de notas fiscais referentes à obrigatoriedade de emissão eletrônica.',
    'Fica instituído novo regime de regularidade fiscal.',
  ]) {
    const c = classified(excerpt('Aquisição de papel A4', {}, signal));
    ok(c.decision !== 'IGNORE', signal);
  }
  for (const boilerplate of [
    'Pagamento mediante nota fiscal eletrônica.',
    'O pagamento será realizado após a apresentação da nota fiscal.',
    'Conferência de notas fiscais. Comprovação de regularidade fiscal.',
  ]) equal(classified(excerpt('Aquisição de papel A4', {}, boilerplate)).decision, 'IGNORE', boilerplate);
});
test('routine object cannot hide an exemption of a named tax anywhere in the body', () => {
  for (const tax of ['ICMS', 'ISS', 'ISSQN', 'IPI', 'PIS/Pasep', 'Cofins', 'IBS', 'CBS']) {
    const c = classified(excerpt('Aquisição de papel A4', {}, `A cláusula concede isenção do ${tax}.`));
    equal(c.category, 'TRIBUTARIO_FISCAL'); equal(c.decision, 'KEEP');
    ok(c.reasonCodes.includes('tax_exemption_reduction_or_suspension'));
  }
});
test('abstract and every continuation heading can veto routine exclusion', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ abstract: 'Concede isenção do ICMS.' }, 'TRIBUTARIO_FISCAL'],
    [{ continuationTitles: ['Continuação', 'Incorporação da contratada pela empresa Beta S.A.'] }, 'EMPRESARIAL_RELEVANTE'],
    [{ abstract: 'Contrato de concessão de serviço público.' }, 'REGULATORIO_CONCESSAO'],
  ];
  for (const [dou, category] of cases) {
    const c = classified(excerpt('Aquisição de papel A4', { metadata: { dou } }));
    equal(c.category, category); equal(c.decision, 'KEEP');
  }
});
test('unproven but material signals fail safe in body, abstract and continuation headings', () => {
  for (const signal of ['Tratamento do ICMS ainda pendente.', 'Incorporação sujeita a confirmação.', 'Outorga pendente de análise.']) {
    for (const publication of [
      excerpt('Aquisição de papel A4', {}, signal),
      excerpt('Aquisição de papel A4', { metadata: { dou: { abstract: signal } } }),
      excerpt('Aquisição de papel A4', { metadata: { dou: { continuationTitles: ['Continuação', signal] } } }),
    ]) {
      const c = classified(publication);
      equal(c.category, 'AMBIGUO'); equal(c.decision, 'REVIEW');
      ok(c.reasonCodes.some(reason => reason.startsWith('possible_')));
    }
  }
});
test('neutral fiscal boilerplate in metadata does not create material relevance', () => {
  const c = classified(excerpt('Aquisição de papel A4', { metadata: { dou: {
    abstract: 'Pagamento mediante nota fiscal e regularidade fiscal.',
    continuationTitles: ['Designação do fiscal do contrato.', 'Conferência de notas fiscais.'],
  } } }));
  equal(c.decision, 'IGNORE');
});
test('metadata never supplies the positive routine procurement evidence', () => {
  const c = classified(excerpt('Aquisição de papel A4', {
    content: '', metadata: { dou: { abstract: excerpt('Aquisição de papel A4').content } },
  }));
  equal(c.decision, 'REVIEW'); deepEqual(c.reasonCodes, ['missing_content']);
});
test('relevance vetoes exclusion with deterministic tax-first precedence', () => {
  const c = classified(excerpt('Aquisição de papel A4', {}, 'O ajuste também formaliza transação tributária e integra contrato de concessão de serviço público.'));
  equal(c.category, 'TRIBUTARIO_FISCAL'); equal(c.decision, 'KEEP');
  ok(c.reasonCodes.includes('tax_transaction_or_installment')); ok(c.reasonCodes.includes('concession_or_public_service_delegation'));
});
test('CNPJ and Lei 14.133 alone are neutral and cannot authorize exclusion', () => {
  const c = classified({ title: 'EXTRATO DE CONTRATO Nº 10/2026', content: 'Empresa Alfa Ltda. CNPJ: 12.345.678/0001-90. Fundamento Legal: Lei nº 14.133/2021.' });
  equal(c.category, 'AMBIGUO'); equal(c.decision, 'REVIEW'); deepEqual(c.reasonCodes, ['missing_object_field']);
});
test('missing, unbounded, compound or unclassified objects remain REVIEW', () => {
  const cases: Array<[DouScopePublication, string]> = [
    [{ title: 'EXTRATO DE CONTRATO' }, 'missing_content'],
    [{ title: 'EXTRATO DE CONTRATO', content: 'Contratante: União. Contratada: X. Pregão Eletrônico nº 1/2026. Valor Global: R$ 1.000. Objeto: Aquisição de papel A4' }, 'object_not_bounded'],
    [excerpt('Aquisição de papel A4 e desenvolvimento de sistema industrial'), 'ordinary_procurement_object_not_confirmed'],
    [excerpt('Execução de projeto especial'), 'ordinary_procurement_object_not_confirmed'],
  ];
  for (const [publication, reason] of cases) {
    const c = classified(publication); equal(c.category, 'AMBIGUO'); equal(c.decision, 'REVIEW'); deepEqual(c.reasonCodes, [reason]);
  }
});
test('routine object still requires complete procurement structure', () => {
  const c = classified({ title: 'EXTRATO DE CONTRATO', content: 'Objeto: Aquisição de papel A4. Valor Global: R$ 1.000. Fundamento Legal: Lei nº 14.133/2021.' });
  equal(c.category, 'AMBIGUO'); equal(c.decision, 'REVIEW'); deepEqual(c.reasonCodes, ['missing_procurement_structure']);
});
