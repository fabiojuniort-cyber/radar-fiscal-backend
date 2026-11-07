import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildMatrix, collectSamples, GRID, LAYOUT, MATRIX_FILE, SAMPLES_BASELINE, samplesBaseline, sizeOf, verifiedBytes, SampleIntegrityError, type Sample } from '../ops/anatomy/official-coverage-matrix.js';
import { decodeDeclared, ingestManual, UnsupportedEncodingError } from '../ops/anatomy/official-manual-ingest.js';

// E9 / P2–P3 (R2 of #303, c.6701945748): one grid; every axis required; stages kept apart; inputs checked.

const real = collectSamples();
test('E9 matrix and samples baseline are regenerated identical to the committed files', () => {
  assert.deepEqual(samplesBaseline(collectSamples([])), JSON.parse(readFileSync(SAMPLES_BASELINE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
  assert.deepEqual(buildMatrix(real), JSON.parse(readFileSync(MATRIX_FILE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
});

test('E9 current state: 9 cells covered, E9 incomplete; nothing promoted or accepted; normas.leg.br keeps its own identity and is not validated', () => {
  const m = buildMatrix(real);
  assert.deepEqual(m.cells.filter((c) => c.status === 'covered').map((c) => c.id).sort(), ['confaz--ajuste-sinief--grande', 'rfb--instrucao-normativa--grande',
    'rfb--ato-declaratorio-interpretativo--pequeno', 'rfb--instrucao-normativa--medio', 'rfb--instrucao-normativa--pequeno', 'rfb--portaria--pequeno', 'rfb--resolucao--pequeno', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--medio', 'sefaz-sp-portal--decreto-consolidado-ricms-2000-artigo--pequeno'].sort());
  assert.equal(m.e9MatrixComplete, false);
  assert.ok(m.requiredPending.includes('planalto--lei--grande'), 'the Planalto layout gap stays visible');
  assert.ok(m.requiredPending.includes('normas-leg-br--lei--grande'), 'normas.leg.br obtained, not read/validated');
  assert.ok(real.every((s) => !s.stages.accepted), 'collection acceptance is not anatomy acceptance');
  const leg = real.filter((s) => s.id.startsWith('lei-'));
  assert.equal(leg.length, 4); assert.ok(leg.every((s) => s.source === 'normas.leg.br' && !s.stages.read && !s.stages.validated && s.diagnostic?.profile.startsWith('DOU')));
  assert.equal(real.find((s) => s.id === 'M5')!.size, 'grande', 'the measured size decides, not the list label (M5 was listed as "pequeno")');
  assert.deepEqual([sizeOf(9_999), sizeOf(10_000), sizeOf(49_999), sizeOf(50_000)], ['pequeno', 'médio', 'médio', 'grande']);
});

const okStages = { captured: true, identified: true, read: true, validated: true, accepted: false };
const sample = (over: Partial<Sample>): Sample => ({ id: 'x', source: 'CONFAZ', type: 'Convênio ICMS', layout: LAYOUT.CONFAZ_HTML, chars: 20_000, size: 'médio', sha256: '0'.repeat(64), bytes: 1,
  stages: okStages, profile: 'CONFAZ', diagnostic: null, outputHash: 'h', evidence: [], notes: [], ...over });
const full = (): Sample[] => GRID.map((c, i) => sample({ id: `s${i}`, source: c.source, type: c.type, layout: c.layout, size: c.size === 'n/a' ? 'médio' : c.size }));

test('E9 single grid: complete only when the grid is approved AND every required cell has a validated sample; one absent category blocks it', () => {
  assert.equal(buildMatrix(full(), GRID, false).e9MatrixComplete, false, 'unapproved grid never completes E9');
  assert.equal(buildMatrix(full(), GRID, true).e9MatrixComplete, true);
  const noPortaria = full().filter((s) => !(s.source === 'RFB' && s.type === 'Portaria' && s.size === 'grande'));
  const m = buildMatrix(noPortaria, GRID, true);
  assert.equal(m.e9MatrixComplete, false); assert.deepEqual(m.requiredPending, ['rfb--portaria--grande']);
});

test('E9 predicates: a sample valid on every axis but ONE never covers the cell (source, type, layout, size, validation)', () => {
  const cell = GRID.find((c) => c.id === 'confaz--convenio-icms--medio')!;
  const ok = sample({});
  const hit = (s: Sample) => buildMatrix([s], [cell], true).e9MatrixComplete;
  assert.equal(hit(ok), true);
  for (const [axis, bad] of [['source', { source: 'DOU' }], ['type', { type: 'Ajuste SINIEF' }], ['layout', { layout: LAYOUT.DOU_HTML }], ['size', { size: 'grande' as const }],
    ['stage', { stages: { ...okStages, validated: false } }]] as const) assert.equal(hit(sample(bad as Partial<Sample>)), false, `divergent ${axis} must not cover`);
});

test('E9 M3/M4: each Convênio is one sample; it covers only the cell of its own measured size, and one never stands for the other', () => {
  const conv = GRID.filter((c) => c.source === 'CONFAZ' && c.type === 'Convênio ICMS');
  const m = buildMatrix([sample({ id: 'M3', size: 'médio' })], conv, true);
  assert.deepEqual(m.cells.filter((c) => c.status === 'covered').map((c) => c.id), ['confaz--convenio-icms--medio']);
  assert.deepEqual(m.requiredPending, ['confaz--convenio-icms--pequeno', 'confaz--convenio-icms--grande']);
});

test('E9 integrity: bytes that differ from the recorded provenance are refused before any use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-')); const f = join(dir, 'a.html'); writeFileSync(f, 'abc');
  const good = { sha256: createHash('sha256').update('abc').digest('hex'), bytes: 3 };
  assert.equal(verifiedBytes(f, good, 'a').byteLength, 3);
  assert.throws(() => verifiedBytes(f, { ...good, bytes: 4 }, 'a'), SampleIntegrityError);
  writeFileSync(f, 'abd'); assert.throws(() => verifiedBytes(f, good, 'a'), SampleIntegrityError);
});

test('E9 encoding: the declared encoding is respected; unsupported or invalid encodings are refused, never guessed', () => {
  assert.equal(decodeDeclared(new Uint8Array([0x63, 0xe9]), 'windows-1252'), 'cé');
  assert.equal(decodeDeclared(new Uint8Array([0x63, 0xe9]), 'ISO-8859-1'), 'cé');
  assert.throws(() => decodeDeclared(new Uint8Array([0x63, 0xe9]), 'utf-8'), TypeError, 'invalid UTF-8 is not repaired');
  assert.throws(() => decodeDeclared(new Uint8Array([0x63]), 'shift_jis'), UnsupportedEncodingError);
  assert.throws(() => decodeDeclared(new Uint8Array([0x63]), null), UnsupportedEncodingError);
});

const html = (body: string, charset = 'utf-8', savedFrom = '') => `<!DOCTYPE html>${savedFrom ? `<!-- saved from url=(0066)${savedFrom} -->` : ''}<html><head><meta charset="${charset}"><title>x</title></head><body>${body}</body></html>`;
const URL5 = 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ007_05';
const AJUSTE = html('<h1>AJUSTE SINIEF 7/05</h1><p>Cláusula primeira. Texto sintético.</p>', 'utf-8', URL5);

test('E9 P2 ingest: stored byte for byte as a browser reproduction; unknown save time recorded as an upper bound; exclusive; no overwrite, no orphan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const out = join(dir, 'out'); const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const r = ingestManual({ item: 'M5', file: f, url: URL5, receivedAt: '2026-11-07T03:57:36Z' }, out, () => '2026-11-07T04:00:00.000Z');
  assert.equal(r.status, 'accepted'); if (r.status !== 'accepted') return;
  assert.equal(r.meta.sha256, createHash('sha256').update(AJUSTE).digest('hex')); assert.equal(readFileSync(join(out, 'M5.html'), 'utf8'), AJUSTE);
  assert.equal(r.meta.savedAt, null); assert.match(r.meta.savedAtNote!, /limite superior/u); assert.equal(r.meta.browserSavedFromUrl, URL5);
  assert.equal(r.meta.original, false); assert.equal(r.meta.promoted, false);
  assert.match((ingestManual({ item: 'M5', file: f, url: URL5 }, out) as { reason: string }).reason, /already ingested/u, 'never overwritten');
  // orphan: bytes without meta (e.g. an interrupted earlier run) is a partial state → refused, not overwritten
  const out2 = join(dir, 'out2'); writeFileSync(join(dir, 'x'), ''); ingestManual({ item: 'M5', file: join(dir, 'nope'), url: URL5 }, out2);
  writeFileSync(join(out2, 'M5.html'), 'previous bytes');
  const orphan = ingestManual({ item: 'M5', file: f, url: URL5 }, out2);
  assert.equal(orphan.status, 'refused'); assert.match((orphan as { reason: string }).reason, /partial state/u);
  assert.equal(readFileSync(join(out2, 'M5.html'), 'utf8'), 'previous bytes'); assert.equal(existsSync(join(out2, 'M5.meta.json')), false);
});

test('E9 P2 ingest refusals: title, host, saved-from-url mismatch, encoding, reserved act, unknown item, PDF, missing file — all recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const out = join(dir, 'out');
  const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const sj = join(dir, 'sj.html'); writeFileSync(sj, html('<h1>AJUSTE SINIEF 7/05</h1>', 'shift_jis'));
  const bad8 = join(dir, 'bad8.html'); writeFileSync(bad8, Buffer.concat([Buffer.from(html('<h1>AJUSTE SINIEF 7/05</h1>')), Buffer.from([0xc3, 0x28])]));
  const pdf = join(dir, 'in.pdf'); writeFileSync(pdf, '%PDF-1.7\n...');
  const cases: [string, Parameters<typeof ingestManual>[0], RegExp][] = [
    ['title', { item: 'M3', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18' }, /saved from url|expected title/u],
    ['host', { item: 'M5', file: f, url: 'https://example.com/AJ007_05' }, /not the official host/u],
    ['saved-from', { item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05' }, /saved from url/u],
    ['encoding', { item: 'M5', file: sj, url: URL5 }, /not supported/u],
    ['invalid utf-8', { item: 'M5', file: bad8, url: URL5 }, /not valid/u],
    ['reserved', { item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91?ref=52/91' }, /reserved/u],
    ['unknown', { item: 'M99', file: f, url: URL5 }, /unknown item/u],
    ['pdf', { item: 'M5', file: pdf, url: URL5 }, /PDF/u],
    ['missing', { item: 'M5', file: join(dir, 'nope.html'), url: URL5 }, /not found/u],
  ];
  for (const [name, input, reason] of cases) {
    const r = ingestManual(input, out); assert.equal(r.status, 'refused', name);
    if (r.status === 'refused') assert.match(r.reason, reason, name);
  }
  assert.equal(readFileSync(join(out, 'refusals.jsonl'), 'utf8').trim().split('\n').length, cases.length);
  assert.equal(existsSync(join(out, 'M5.meta.json')), false);
});
