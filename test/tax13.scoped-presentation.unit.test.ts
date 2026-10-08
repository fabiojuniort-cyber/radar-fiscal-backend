import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { extractActBodyHtml } from '../src/modules/collection/confaz.connector.js';
import {
  currentWordingText,
  sanitizeLegalPresentationHtml,
} from '../src/modules/collection/legal-presentation.js';

/**
 * TAX13 scoped visual regression: these assertions do not attest vigência.
 * They only forbid marking identifiable editorial/historical presentation
 * regions and preserve explicitly current sibling cells.
 */
test('TAX13 scoped: saved official CV100/97 and CV52/91 strip editorial history', () => {
  const body = (filename: string): string => {
    const saved = readFileSync(filename, 'utf8');
    const extracted = extractActBodyHtml(saved);
    assert.ok(extracted, 'official CONFAZ HTML has a legal body');
    const sanitized = sanitizeLegalPresentationHtml(extracted);
    assert.ok(sanitized, 'legal body survives sanitization');
    return currentWordingText(sanitized) ?? '';
  };

  const cv100 = body('ops/confaz/acts/CV100_97.html');
  assert.match(cv100, /calcário e gesso/i);
  assert.doesNotMatch(cv100, /CONVÊNIO ICMS 100\/97|Publicado no DOU de 06\.11\.97/i);

  const cv52 = body('ops/confaz/acts/CV052_91.html');
  assert.match(cv52, /7307\.19\.20/, 'current table NCM remains visible to the parser');
  assert.doesNotMatch(cv52, /8450\.11\.00/, 'historical green annex must be excluded');
  assert.doesNotMatch(cv52, /CONVÊNIO ICMS 52\/91|Publicação DOU de 30\.09\.91/i);
});

test('TAX13 R2 B1: green historical cell does not remove verified current sibling', () => {
  const html = '<table><tr>' +
    '<td><p class="A9-2Tabelajustificadoverde">8450.11.00</p></td>' +
    '<td data-legal-status="current">7307.19.20</td>' +
    '</tr></table>';
  const selected = currentWordingText(html) ?? '';
  assert.ok(selected.includes('7307.19.20'));
  assert.ok(!selected.includes('8450.11.00'));
});

test('TAX13 R2 B3: revoked table annex scope ends at next TH annex', () => {
  const html = '<table><tr><th data-legal-status="revoked">ANEXO II</th></tr>' +
    '<tr><td>8450.11.00</td></tr>' +
    '<tr><th>ANEXO III</th></tr><tr><td>7307.19.20</td></tr></table>';
  const selected = currentWordingText(html) ?? '';
  assert.ok(selected.includes('7307.19.20'));
  assert.ok(!selected.includes('8450.11.00'));
  assert.ok(!selected.includes('ANEXO II') && !selected.includes('ANEXO III'));
});

test('TAX13 scoped: revoked and previous paragraphs do not contaminate current body', () => {
  const html = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 52/91</p>',
    '<p class="Ementa">NCM 9999.99.99</p>',
    '<p class="RedaoAnt">Redação anterior: NCM 8450.11.00</p>',
    '<p class="TextoAcordo">Cláusula primeira: NCM 7307.19.20</p>',
    '<p data-legal-status="revoked">Revogado: 1006.30.11</p>',
  ].join('');
  const selected = currentWordingText(html) ?? '';
  assert.match(selected, /7307\.19\.20/);
  assert.doesNotMatch(selected, /9999\.99\.99|8450\.11\.00|1006\.30\.11|CONVÊNIO ICMS 52\/91/);
});
