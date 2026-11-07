import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildMatrix, MATRIX_FILE, sizeOf } from '../ops/anatomy/official-coverage-matrix.js';
import { ingestManual } from '../ops/anatomy/official-manual-ingest.js';

// E9 / P2–P3: the official coverage matrix is computed from the samples in the repository; manual files keep their bytes.

test('E9 matrix: regenerated from the samples, identical to the committed docs/anatomy/official-coverage-matrix.json', () => {
  assert.deepEqual(buildMatrix(), JSON.parse(readFileSync(MATRIX_FILE, 'utf8')), 'run: npx tsx ops/anatomy/official-coverage-matrix.ts --write');
});

test('E9 matrix: size criterion reproduces the sizes chosen for M6/M7/M8 and the pending cells are exactly the ones without samples', () => {
  const m = buildMatrix();
  const size = (id: string) => m.samples.find((s) => s.id === id)!.size;
  assert.deepEqual([size('rfb:115131'), size('rfb:141910'), size('rfb:108391')], ['grande', 'médio', 'pequeno']);
  assert.deepEqual([sizeOf(9_999), sizeOf(10_000), sizeOf(49_999), sizeOf(50_000)], ['pequeno', 'médio', 'médio', 'grande']);
  assert.deepEqual(m.requiredPending, ['confaz-convenio', 'confaz-ajuste-pequeno', 'dou-pagina-ato', 'doesp-diario']);
  assert.equal(m.e9MatrixComplete, false);
  assert.ok(m.samples.every((s) => s.promoted === false), 'nothing is promoted');
  assert.ok(m.cells.find((c) => c.id === 'lei-federal-grande')!.samples.includes('lei-10637-2002-atualizada'), 'M1 via normas.leg.br');
});

const html = (body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title></head><body>${body}</body></html>`;
const AJUSTE = html('<h1>AJUSTE SINIEF 07/05</h1><p>Cláusula primeira. Texto sintético do ajuste.</p>');

test('E9 P2 ingest: a matching manual file is stored byte for byte as a browser reproduction, never as original; nothing promoted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const r = ingestManual({ item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05', savedAt: '2026-11-07T10:00:00-03:00' }, join(dir, 'out'), () => '2026-11-07T13:05:00.000Z');
  assert.equal(r.status, 'accepted');
  if (r.status !== 'accepted') return;
  assert.equal(r.meta.sha256, createHash('sha256').update(AJUSTE).digest('hex'));
  assert.equal(readFileSync(join(dir, 'out', 'M5.html'), 'utf8'), AJUSTE);
  assert.equal(r.meta.original, false); assert.equal(r.meta.promoted, false); assert.match(r.meta.origin, /reprodução salva pelo navegador/u);
  assert.equal(r.meta.savedAt, '2026-11-07T13:00:00.000Z');
  const again = ingestManual({ item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05', savedAt: '2026-11-07T10:00:00-03:00' }, join(dir, 'out'));
  assert.equal(again.status, 'refused', 'bytes are never overwritten');
});

test('E9 P2 ingest: wrong title, foreign host, reserved act, unknown item, PDF and missing file are refused and recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-')); const out = join(dir, 'out');
  const f = join(dir, 'in.html'); writeFileSync(f, AJUSTE);
  const pdf = join(dir, 'in.pdf'); writeFileSync(pdf, '%PDF-1.7\n...');
  const cases: [string, Parameters<typeof ingestManual>[0], RegExp][] = [
    ['title', { item: 'M3', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18', savedAt: '2026-11-07' }, /expected title/u],
    ['host', { item: 'M5', file: f, url: 'https://example.com/AJ_007_05', savedAt: '2026-11-07' }, /not the official host/u],
    ['reserved', { item: 'M5', file: f, url: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91?ref=52/91', savedAt: '2026-11-07' }, /reserved/u],
    ['unknown', { item: 'M99', file: f, url: 'https://www.confaz.fazenda.gov.br/x', savedAt: '2026-11-07' }, /unknown item/u],
    ['pdf', { item: 'M5', file: pdf, url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05', savedAt: '2026-11-07' }, /PDF/u],
    ['missing', { item: 'M5', file: join(dir, 'nope.html'), url: 'https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05', savedAt: '2026-11-07' }, /not found/u],
  ];
  for (const [name, input, reason] of cases) {
    const r = ingestManual(input, out); assert.equal(r.status, 'refused', name);
    if (r.status === 'refused') assert.match(r.reason, reason, name);
  }
  assert.equal(readFileSync(join(out, 'refusals.jsonl'), 'utf8').trim().split('\n').length, cases.length);
  assert.equal(existsSync(join(out, 'M5.meta.json')), false);
});
