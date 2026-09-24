import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalizeRfbActType,
  canonicalizeRfbAgency,
  normalizeRfbActNumber,
  parseCanonicalRfbFormalAct,
} from '../src/modules/collection/rfb-normas.identity.js';

test('canonicalizes Receita aliases, act types and leading zeros', () => {
  assert.equal(canonicalizeRfbAgency('RFB - Secretaria da Receita Federal do Brasil'), 'RFB');
  assert.equal(canonicalizeRfbAgency('Secretaria Especial da Receita Federal do Brasil'), 'RFB');
  assert.equal(canonicalizeRfbAgency('Coordenação-Geral de Tributação - Cosit'), 'COSIT');
  assert.equal(canonicalizeRfbActType('IN RFB - Instrução Normativa'), 'INSTRUÇÃO NORMATIVA');
  assert.equal(normalizeRfbActNumber('002.344', 2026), '2344/2026');
});

test('parses canonical identity from formal titles', () => {
  assert.deepEqual(
    parseCanonicalRfbFormalAct(
      'INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026',
      'RFB',
    ),
    {
      agency: 'RFB',
      actType: 'INSTRUÇÃO NORMATIVA',
      actNumber: '2344/2026',
      actDate: new Date('2026-09-22T00:00:00Z'),
    },
  );
  const sc = parseCanonicalRfbFormalAct(
    'SOLUÇÃO DE CONSULTA COSIT Nº 180, DE 22 DE SETEMBRO DE 2026',
    'Cosit',
  );
  assert.equal(sc?.agency, 'COSIT');
  assert.equal(sc?.actNumber, '180/2026');
});
