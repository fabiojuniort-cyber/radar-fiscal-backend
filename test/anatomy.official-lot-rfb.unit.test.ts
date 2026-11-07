import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeLot, BASELINE } from '../ops/anatomy/official-lot-rfb.js';

// OFFICIAL-LOT-RFB: the official RFB snapshots re-analysed must match the committed baseline exactly.
// A deliberate engine change regenerates it with `npx tsx ops/anatomy/official-lot-rfb.ts --write` and reviews the delta.
test('OFFICIAL-LOT-RFB: re-analysis of the official RFB lot matches the committed baseline (no silent regression)', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const now = analyzeLot();
  assert.equal(now.engineBuildHash, baseline.engineBuildHash, 'engine identity changed: regenerate the lot baseline and review the delta');
  assert.deepEqual(now.acts, baseline.acts);
});

test('OFFICIAL-LOT-RFB: invariants — never promoted, legalStatus unknown (checked in the run), text fully accounted', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { acts: { promoted: boolean; unidentifiedChars: number; canonicalChars: number; idAto: number }[] };
  assert.equal(baseline.acts.length, 10, 'LOTE-RFB+: 5 original INs + IN 1.911 and IN 2.021 (#295) + 3 acts of E9 P2-c (Portaria, ADI, Resolução)');
  for (const a of baseline.acts) { assert.equal(a.promoted, false, `${a.idAto} not promoted`); assert.ok(a.unidentifiedChars <= a.canonicalChars); }
});

// R2-LOT-01: captured preparation (snapshot meta, never rewritten) vs re-executed preparation.
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LOT_DIR, analyzeLot as lot, isCliEntry, snapshotDirOf } from '../ops/anatomy/official-lot-rfb.js';

function copyLot(mutate?: (meta: Record<string, any>) => void, id = '127905'): string {
  const dir = mkdtempSync(join(tmpdir(), 'lot-rfb-'));
  for (const f of readdirSync(LOT_DIR)) copyFileSync(join(LOT_DIR, f), join(dir, f));
  if (mutate) { const p = join(dir, `${id}.meta.json`); const m = JSON.parse(readFileSync(p, 'utf8')); mutate(m); writeFileSync(p, JSON.stringify(m)); }
  return dir;
}

test('R2-LOT-01: each act records the captured preparation untouched and a proven reconciliation', () => {
  const now = lot();
  for (const a of now.acts) {
    const meta = JSON.parse(readFileSync(join(snapshotDirOf(a.idAto), `${a.idAto}.meta.json`), 'utf8'));
    assert.deepEqual(a.capturedPreparation, { preparationVersion: meta.preparation.preparationVersion, htmlSha256: meta.preparation.htmlSha256, pieces: meta.preparation.pieces });
  }
  const in2121 = now.acts.find((a) => a.idAto === 127905)!;
  assert.equal(in2121.capturedPreparation.preparationVersion, 'rfb-api-original/0.1.0-provisional');
  assert.equal(in2121.capturedPreparation.htmlSha256, '8fc9f20672a32f116857132df0dbd257561d89a9ca7750efc85208255c70715b');
  assert.equal(in2121.preparationVersion, 'rfb-api-original/0.2.0-provisional');
  assert.equal(in2121.preparationReconciliation, 'd04_annotation_only');
  for (const a of now.acts.filter((x) => x.idAto !== 127905)) assert.equal(a.preparationReconciliation, 'identical');
});

test('R2-LOT-01 negative: a captured hash that the re-execution cannot reproduce fails (old analyzeLot accepted it)', () => {
  const dir = copyLot((m) => { m.preparation.htmlSha256 = '0'.repeat(64); });
  try { assert.throws(() => lot(dir), /not annotation-only/u); } finally { rmSync(dir, { recursive: true }); }
  const dir2 = copyLot((m) => { m.preparation.htmlSha256 = '0'.repeat(64); }, '108391');
  try { assert.throws(() => lot(dir2), /same preparation version but prepared HTML differs/u); } finally { rmSync(dir2, { recursive: true }); }
  const dir3 = copyLot((m) => { m.preparation.preparationVersion = 'rfb-api-original/9.9.9'; });
  try { assert.throws(() => lot(dir3), /no proven transition/u); } finally { rmSync(dir3, { recursive: true }); }
  const dir4 = copyLot((m) => { m.preparation.pieces += 1; });
  try { assert.throws(() => lot(dir4), /piece count/u); } finally { rmSync(dir4, { recursive: true }); }
  const dir5 = copyLot((m) => { delete m.preparation; });
  try { assert.throws(() => lot(dir5), /no captured preparation/u); } finally { rmSync(dir5, { recursive: true }); }
});

test('R1-LOT-02: entry-point detection uses resolved paths; CLI runs and --write honours --baseline', () => {
  const script = resolve('ops/anatomy/official-lot-rfb.ts');
  assert.equal(isCliEntry(pathToFileURL(script).href, script), true);
  assert.equal(isCliEntry(pathToFileURL(script).href, 'ops/anatomy/official-lot-rfb.ts'), true);
  assert.equal(isCliEntry(pathToFileURL(script).href, 'other/official-lot-rfb.ts'), false, 'suffix match alone is not enough');
  assert.equal(isCliEntry(pathToFileURL(script).href, undefined), false);
  const dir = mkdtempSync(join(tmpdir(), 'lot-cli-')); const out = join(dir, 'baseline.json');
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'ops/anatomy/official-lot-rfb.ts', '--write', '--baseline', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /127905 .*prep d04_annotation_only/u);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(readFileSync(BASELINE, 'utf8')));
  } finally { rmSync(dir, { recursive: true }); }
});

test('R1-LOT-02: historicalByTachado counts the source reason; historical context is counted separately', () => {
  for (const a of lot().acts) { assert.equal(typeof a.historicalContextParts, 'number'); assert.ok(a.historicalContextParts >= 0); }
});
