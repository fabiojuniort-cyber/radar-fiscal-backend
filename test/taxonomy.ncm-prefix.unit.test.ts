import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ncmMatchesEitherPrefix,
  normalizeNcmPrefix,
} from '../src/modules/taxonomy/ncm/ncm-prefix.js';

test('F2-T03: NCM mask is ignored and 2/4/6/8 digits are accepted', () => {
  for (const [masked, canonical] of [
    ['10', '10'], ['1006', '1006'],
    ['1006.30', '100630'], ['1006.30.11', '10063011'],
    ['10063011', '10063011'], ['31.02.10', '310210'],
  ]) {
    assert.equal(normalizeNcmPrefix(masked), canonical, masked);
  }
});

test('F2-T03: only digits/dots allowed and length must be 2,4,6,8', () => {
  for (const invalid of ['', '1', '100', '10063', '1006301', '100630111',
    '10, 12', '1006/30', '1006-30', '10 06', 'NCM 1006',
    '1006;3004', 'Vazio', '...']) {
    assert.equal(normalizeNcmPrefix(invalid), null, invalid);
    assert.equal(ncmMatchesEitherPrefix(invalid, '10063011'), false, invalid);
  }
});

test('F2-T03: legislation and profile NCM share prefix both directions', () => {
  for (const [a, b] of [
    ['10', '10063011'],
    ['1006', '10063011'],
    ['1006.30', '1006.30.11'],
    ['1006.30.11', '1006'],
    ['10063011', '10'],
    ['3102.10', '3102.10.10'],
    ['10063011', '10063011'],
  ]) {
    assert.ok(ncmMatchesEitherPrefix(a, b), a + ' ' + b);
    assert.ok(ncmMatchesEitherPrefix(b, a), b + ' ' + a);
  }
  assert.equal(ncmMatchesEitherPrefix('1006.30.11', '1007'), false);
  assert.equal(ncmMatchesEitherPrefix('1006.30.11', '1006.31'), false);
  assert.equal(ncmMatchesEitherPrefix('1201', '1006'), false);
});
