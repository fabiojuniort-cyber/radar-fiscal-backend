import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractNcmCandidates,
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
