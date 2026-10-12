import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { F2_ACTUACAO_SEED, F2_ACTUACAO_SOURCE_SHA256 } from '../src/modules/taxonomy/curation/curation.actuacao.js';

import {
  F2_SOURCE,
  planImport,
  parseApprovedWorkbook,
  parseWorksheet,
  normalizeProductNcm,
  ncmMatchesEitherPrefix,
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

test('T03 refuses a workbook when its bytes do not match the signed manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'f2-dryrun-'));
  const file = join(dir, 'forged.xlsx');
  try {
    await writeFile(file, 'not the approved workbook');
    await assert.rejects(
      parseApprovedWorkbook(file, 'segmento'),
      /hash divergente/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T03 CLI refuses --confirm before touching inputs, even when invoked accidentally', () => {
  const run = spawnSync(process.execPath, [
    new URL('../ops/taxonomy/f2-xlsx-dry-run.mjs', import.meta.url).pathname,
    '--confirm',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Carga produtiva proibida/);
});

test('T02 seeds exactly the seven workbook Atuação categories without inheriting Segmento aliases', () => {
  assert.equal(F2_ACTUACAO_SOURCE_SHA256, F2_SOURCE.segmento.sha256);
  assert.equal(F2_ACTUACAO_SEED.length, 7);
  assert.equal(F2_ACTUACAO_SEED.reduce((sum, item) => sum + item.count, 0), 1332);
  assert.deepEqual(F2_ACTUACAO_SEED.map(item => item.label), [
    'Serviço', 'Indústria', 'Comércio atacadista', 'Produção agropecuária',
    'Comércio varejista', 'Extração mineral', 'Representação comercial',
  ]);
  assert.ok(F2_ACTUACAO_SEED.every(item => item.code.startsWith('actuacao.')));
});

test('T03 reads unmasked 2/4/6/8 NCM and rejects non-digit/non-dot chars', () => {
  const valid = [
    ['10', '10'], ['1006', '1006'], ['1006.30', '100630'],
    ['1006.30.11', '10063011'], ['10063011', '10063011'],
  ];
  for (const [input, expected] of valid) assert.equal(normalizeProductNcm(input), expected);
  for (const bad of ['10063', '1006301', '10, 12', '1006/30', '10-06', 'Vazio', '...']) {
    assert.equal(normalizeProductNcm(bad), null, bad);
  }
  assert.equal(ncmMatchesEitherPrefix('1006', '1006.30.11'), true);
  assert.equal(ncmMatchesEitherPrefix('1006.30.11', '1006'), true);
  assert.equal(ncmMatchesEitherPrefix('1006', '1007'), false);
});

test('T03 rejects each invalid Produto NCM token without guessing or stripping punctuation', () => {
  const segments = [[
    'A', 'B', 'Serviço', '6201-5/01', 'CNAE', '', '', '', '', '', '1', 'sector.test',
  ]];
  const make = (value) => [[
    'A', 'B', 'Item', value, '', 'x', 'x', '1', 'product.test', 'Item',
  ]];
  const invalid = ['1006.30.11, 1006', '9001.10, 8544.70', '1006;Vazio', '1201-90'];
  for (const ncm of invalid) {
    const result = planImport(segments, make(ncm));
    assert.ok(result.issues.errors.some(e => e.includes('NCM inválido')), ncm);
  }
  for (const ncm of ['10', '1006', '1006.30', '1006.30.11', '10063011', '1006;3102.10']) {
    const result = planImport(segments, make(ncm));
    assert.ok(!result.issues.errors.some(e => e.includes('NCM inválido')), ncm);
  }
});

test('F2-T03: self-closing empty XLSX cells cannot shift following columns', () => {
  const xml = '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Segmento</x:t></x:is></x:c>' +
    '<x:c r="B1" s="2"/>' +
    '<x:c r="C1" t="inlineStr"><x:is><x:t>Atuação</x:t></x:is></x:c>' +
    '<x:c r="D1" t="inlineStr"><x:is><x:t>Produtos;Sementes</x:t></x:is></x:c>' +
    '</x:row></x:sheetData></x:worksheet>';
  const rows = parseWorksheet(xml, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['Segmento', '', 'Atuação', 'Produtos;Sementes']);
  assert.equal(rows[0][1], '', 'empty B1 remains at index 1 rather than consuming C1');
});

test('F2-T03: source cardinality warnings survive empty Sinônimos column', () => {
  const segments = [[
    'Agro', 'Grãos', 'Produção agropecuária', '0111-3/03', 'Trigo', '',
    'Trigo em grão;Trigo preto', '1001.10.90;1001.90.90;1008.10.90',
    'x', 'x', '1', 'sector.trigo',
  ]];
  const products = [[
    'Agro', 'Grãos', 'Trigo', '1001.10.90', '', 'x', 'x', '1', 'product.trigo', 'Trigo',
  ]];
  const result = planImport(segments, products);
  assert.equal(result.issues.warnings.filter(w => w.includes('cardinalidade')).length, 1);
  assert.equal(result.summary.warnings, 1);
});
