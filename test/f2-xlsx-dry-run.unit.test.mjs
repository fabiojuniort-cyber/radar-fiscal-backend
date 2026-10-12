import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  F2_SOURCE,
  planImport,
  segmentSubsegmentLabel,
  sha256,
} from '../ops/taxonomy/f2-xlsx-dry-run.mjs';

test('source digests are pinned SHA-256 values and not Git blob SHAs', () => {
  assert.match(F2_SOURCE.segmento.sha256, /^[a-f0-9]{64}$/);
  assert.match(F2_SOURCE.produto.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(Buffer.from('abc')), createHash('sha256').update('abc').digest('hex'));
});

test('T01 label is compositional, never an identity', () => {
  assert.equal(
    segmentSubsegmentLabel('Agronegócio', 'Grãos e Cereais'),
    'Agronegócio – Grãos e Cereais',
  );
  assert.throws(() => segmentSubsegmentLabel('', 'Grãos e Cereais'), /obrigatórios/);
});

test('T02 Atuação has no inherited sector synonyms and preserves origin CNAE', () => {
  const sampleSegments = [[
    'Agropecuária', 'Grãos e Cereais', 'Produção agropecuária',
    '0111-3/01', 'Cultivo de arroz', 'sinônimo do CNAE',
    'Arroz', '1006.10.92', 'x', 'x', '1', 'sector.cultivo_de_arroz',
  ]];
  const sampleProducts = [[
    'Agropecuária', 'Grãos e Cereais', 'Arroz', '1006.10.92',
    null, 'x', 'x', '1', 'product.arroz', 'Grão de arroz',
  ]];
  const result = planImport(sampleSegments, sampleProducts);
  const activity = result.actuationSeed.find(item => item.label === 'Produção agropecuária');
  assert.deepEqual(activity?.synonyms, []);
  assert.deepEqual(activity?.cnaes, ['0111301']);
  assert.equal(result.segmentSubsegments[0].display, 'Agropecuária – Grãos e Cereais');
  assert.equal(result.summary.segmentRows, 1);
  assert.equal(result.summary.productRows, 1);
  assert.equal(result.noDatabaseWrites, true);
  assert.equal(result.noTaxonomicPublication, true);
  // Source frequency gate deliberately blocks synthetic/incomplete workbooks.
  assert.ok(result.summary.errors > 0);
});

test('T03 does not invent one-to-one mappings from suggested product and NCM lists', () => {
  const segments = [[
    'Agro', 'Grãos', 'Produção agropecuária', '0111-3/02', 'Milho',
    '', 'Milho;Sementes;Farelo', '1005.90.10;1201.90.00',
    'x', 'x', '1', 'sector.milho',
  ]];
  const products = [[
    'Agro', 'Grãos', 'Milho', '1005.90.10;1201.90.00',
    'Milho em grão; Milho grão', 'x', 'x', '1', 'product.milho', 'Definição',
  ]];
  const result = planImport(segments, products);
  assert.equal(result.products[0].ncms.length, 2);
  assert.deepEqual(result.products[0].synonyms, ['Milho em grão', 'Milho grão']);
  assert.ok(result.issues.warnings.some(w => w.includes('sem associação automática')));
});

test('T03 records malformed product source rows as errors, not guessed assignments', () => {
  const segments = [[
    'A', 'B', 'Serviço', '6201-5/01', 'CNAE', '', '', '', '', '', '1', 'sector.test',
  ]];
  const products = [[null, null, 'Combustíveis gasosos', '2711.21.00', null, 'x', '', '1', 'product.test', 'Definição']];
  const result = planImport(segments, products);
  assert.ok(result.issues.errors.some(error => error.includes('segmento/grupo/item')));
  assert.equal(result.mode, 'DRY_RUN_ONLY');
});
