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
  APPROVED_ACTUATIONS,
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
    'Agropecuária', 'Grãos e Cereais', 'Produtor rural',
    '0111-3/01', 'Cultivo de arroz', 'sinônimo do CNAE',
    'Arroz', '1006.10.92', 'x', 'x', '1', 'sector.cultivo_de_arroz',
  ]];
  const sampleProducts = [[
    'Agropecuária', 'Grãos e Cereais', 'Arroz', '1006.10.92',
    null, 'x', 'x', '1', 'product.arroz', 'Grão de arroz',
  ]];
  const result = planImport(sampleSegments, sampleProducts);
  const activity = result.actuationSeed.find(item => item.label === 'Produtor rural');
  assert.deepEqual(activity?.synonyms, []);
  assert.deepEqual(activity?.cnaes, ['0111301']);
  assert.equal(result.segmentSubsegments[0].display, 'Agropecuária – Grãos e Cereais');
  assert.equal(result.summary.segmentRows, 1);
  assert.equal(result.summary.productRows, 1);
  assert.equal(result.noDatabaseWrites, true);
  assert.equal(result.noTaxonomicPublication, true);
  // Total CNAE gate deliberately blocks synthetic/incomplete workbooks.
  assert.ok(result.summary.errors > 0);
});

test('T03 does not invent one-to-one mappings from suggested product and NCM lists', () => {
  const segments = [[
    'Agro', 'Grãos', 'Produtor rural', '0111-3/02', 'Milho',
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

test('T02 seeds only 12 approved v5 categories and eight explicit Energia e utilidades synonyms', () => {
  assert.equal(F2_ACTUACAO_SOURCE_SHA256, F2_SOURCE.segmento.sha256);
  assert.equal(F2_SOURCE.segmento.rows, 1332);
  assert.equal(F2_SOURCE.produto.rows, 4225);
  assert.equal(F2_ACTUACAO_SEED.length, 12);
  assert.equal(F2_ACTUACAO_SEED.reduce((sum, item) => sum + item.count, 0), 1262);
  assert.deepEqual(new Set(F2_ACTUACAO_SEED.map(item => item.label)), APPROVED_ACTUATIONS);
  assert.ok(!APPROVED_ACTUATIONS.has('Produção Agrícola'));
  const energia = F2_ACTUACAO_SEED.find(item => item.label === 'Energia e utilidades');
  assert.deepEqual(energia?.synonyms, [
    'geração de energia elétrica', 'transmissão de energia elétrica',
    'distribuição de energia elétrica', 'comercialização de energia elétrica',
    'produção de gás', 'distribuição de gás canalizado',
    'produção e distribuição de vapor', 'produção e distribuição de água quente',
  ]);
  assert.ok(!energia.synonyms.includes('energia'));
  assert.ok(!energia.synonyms.includes('gás'));
  assert.ok(F2_ACTUACAO_SEED.every(item => item.code.startsWith('actuacao.')));
});

test('T03 accepts 2-8 digits with prefix in both directions and preserves leading zeros', () => {
  const valid = [
    ['10', '10'], ['1006', '1006'], ['1006.30', '100630'],
    ['1006.30.11', '10063011'], ['10063011', '10063011'],
    ['2710.12.4', '2710124'], ['2815.1', '28151'], ['0307.1', '03071'],
  ];
  for (const [input, expected] of valid) assert.equal(normalizeProductNcm(input), expected);
  for (const bad of ['100630119', '10, 12', '1006/30', '10-06', 'Vazio', '...']) {
    assert.equal(normalizeProductNcm(bad), null, bad);
  }
  assert.equal(ncmMatchesEitherPrefix('1006', '1006.30.11'), true);
  assert.equal(ncmMatchesEitherPrefix('1006.30.11', '1006'), true);
  assert.equal(ncmMatchesEitherPrefix('0307.1', '0307.10.11'), true);
  assert.equal(ncmMatchesEitherPrefix('0307.10.11', '0307.1'), true);
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
  for (const ncm of ['10', '1006', '1006.30', '1006.30.11', '10063011', '1006;3102.10', '2710.12.4', '2815.1', '0307.1']) {
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
    'Agro', 'Grãos', 'Produtor rural', '0111-3/03', 'Trigo', '',
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


test('F2 v5: 1332 unique CNAEs, frequency report only, one consolidated unregistered category error', () => {
  const segments = Array.from({length: 1332}, (_, index) => [
    'A', 'B', index < 70 ? 'Produção Agrícola' : 'Serviço',
    String(index).padStart(7, '0'), 'CNAE', '', '', '', '', '', '1',
    'sector.' + index,
  ]);
  const products = [['A','B','Item','0307.1','','x','x','1','product.item','Definição']];
  const report = planImport(segments, products);
  assert.equal(report.summary.cnaeDistinct, 1332);
  assert.equal(report.summary.actuationCounts['Produção Agrícola'], 70);
  assert.equal(report.summary.actuationCounts['Serviço'], 1262);
  assert.deepEqual(report.issues.errors, ['Atuação não cadastrada na T02: Produção Agrícola']);
  segments[1][3] = segments[0][3];
  const repeated = planImport(segments, products);
  assert.ok(repeated.issues.errors.some(e => e.includes('mais de uma Atuação')));
  assert.ok(repeated.issues.errors.some(e => e.includes('1.332 CNAEs únicos')));
});
