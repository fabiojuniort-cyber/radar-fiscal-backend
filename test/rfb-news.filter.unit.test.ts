import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRfbNewsRelevance } from '../src/modules/collection/rfb-news.filter.js';

const base = {
  title: 'Notícia institucional',
  tags: [] as string[],
  url: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/exemplo',
};

test('RFB news filter includes Tributação category', () => {
  const result = classifyRfbNewsRelevance({
    ...base,
    category: 'Tributação',
  });
  assert.equal(result.relevant, true);
  assert.equal(result.reason, 'TAX_CATEGORY');
});

test('RFB news filter includes strong tax terms', () => {
  const result = classifyRfbNewsRelevance({
    ...base,
    title: 'Cronograma de documentos fiscais eletrônicos com IBS e CBS',
  });
  assert.equal(result.relevant, true);
  assert.equal(result.reason, 'STRONG_TERM');
  assert.ok(result.matchedTerms.includes('IBS'));
  assert.ok(result.matchedTerms.includes('CBS'));
});

test('RFB news filter excludes unrelated contraband news', () => {
  const result = classifyRfbNewsRelevance({
    ...base,
    title: 'Receita Federal retém cigarros eletrônicos no Porto de Santos',
    summary: 'Ação de fiscalização aduaneira apreendeu mercadorias irregulares.',
    category: 'Combate ao Contrabando',
  });
  assert.deepEqual(result, {
    relevant: false,
    matchedTerms: [],
    reason: 'NO_MATCH',
  });
});

test('RFB news filter accepts combined tax and business context', () => {
  const result = classifyRfbNewsRelevance({
    ...base,
    title: 'Novas regras para empresas',
    content: 'As empresas deverão observar nova apuração e declaração de valores tributários.',
  });
  assert.equal(result.relevant, true);
  assert.equal(result.reason, 'TAX_CONTEXT');
});
