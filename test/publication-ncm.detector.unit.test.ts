import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentWordingText,
  sanitizeLegalPresentationHtml,
} from '../src/modules/collection/legal-presentation.js';
import {
  extractNcmCandidates,
  selectText,
} from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

test('extractNcmCandidates normalizes formatted and plain NCMs and counts repeats', () => {
  const text = [
    'A tabela alcança o NCM 1006.30.11 para arroz branqueado.',
    'Também menciona 10062099 e repete 1006.30.11 em outra linha.',
    'O código 9999.99.99 tem formato plausível, mas será validado pelo catálogo.',
    'A sequência 123456789 não pode ser recortada como oito dígitos.',
  ].join(' ');

  const candidates = extractNcmCandidates(text);
  const byCode = new Map(candidates.map((candidate) => [candidate.code, candidate]));

  assert.equal(candidates.length, 3);
  assert.equal(byCode.get('10063011')?.occurrenceCount, 2);
  assert.equal(byCode.get('10062099')?.occurrenceCount, 1);
  assert.equal(byCode.get('99999999')?.occurrenceCount, 1);
  assert.ok(byCode.get('10063011')?.excerpt.includes('1006.30.11'));
  assert.equal(byCode.has('12345678'), false);
});

test('extractNcmCandidates ignores date-shaped and unrelated numeric text', () => {
  const text = [
    'Lei nº 14.133/2021, publicada em 01/10/2026, processo 12345.',
    'Datas ISO como 2026-10-01 também não são códigos NCM.',
    'Separações livres como 1006 30 11 não entram no detector conservador.',
  ].join(' ');
  assert.deepEqual(extractNcmCandidates(text), []);
});

test('extractNcmCandidates accepts the "8417.8020" typing of official annexes but not longer codes', () => {
  const codes = extractNcmCandidates(
    'Fornos para fusão de vidro 8417.8020. Ninhos metálicos 7326.90.9999. Motocultores 8701.10.',
  ).map((candidate) => candidate.code);
  assert.deepEqual(codes, ['84178020']);
});

test('selectText reads only the wording in force when the page marks previous wordings', () => {
  const presentation = [
    '<p class="TextoAcordo">Cláusula primeira Reduz a base de cálculo.</p>',
    '<table><tr><td><p>2.1</p></td><td><p class="A5-1TextoAcordo">Silos</p></td>',
    '<td><p class="A5-1TextoAcordo">3917.32.90</p><p>3925.10.00</p></td></tr>',
    '<tr><td colspan="3"><p class="A8-2RemissaoAnt">Redação original, efeitos até 31.05.2020.</p></td></tr>',
    '<tr><td><p class="A9-2Tabelajustificadoverde">2.1</p></td><td><p class="A9-2Tabelajustificadoverde">Silos</p></td>',
    '<td><p class="A9-2Tabelajustificadoverde">7612.90.19</p></td></tr></table>',
    '<p class="RedaoAnt">Redação anterior com 8701.90.00.</p>',
  ].join('');
  const row = {
    publication_version_id: 'v1',
    content_text: 'texto completo 3917.32.90 3925.10.00 7612.90.19 8701.90.00',
    relevant_excerpt: null,
    presentation_html: presentation,
  };
  const selected = selectText(row);
  assert.equal(selected.currentWordingOnly, true);
  assert.deepEqual(
    extractNcmCandidates(selected.text).map((candidate) => candidate.code),
    ['39173290', '39251000'],
  );
  // Without previous-wording marks the stored content text is kept.
  const plain = selectText({ ...row, presentation_html: '<p class="TextoAcordo">8701.90.00</p>' });
  assert.equal(plain.currentWordingOnly, false);
  assert.equal(plain.text, row.content_text);
});

test('the sanitized CONFAZ presentation keeps the green previous-wording table styles', () => {
  const html = sanitizeLegalPresentationHtml(
    '<table><tr><td><p class="A7-2Tabelajustificado">Silos</p></td><td><p class="A9-2Tabelajustificadoverde">7612.90.19</p></td></tr></table>',
  );
  assert.ok(html?.includes('class="A9-2Tabelajustificadoverde"'));
  assert.ok(!html?.includes('A7-2Tabelajustificado"'));
  assert.equal(currentWordingText(html), '');
});
