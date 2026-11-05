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
  assert.equal(baseline.acts.length, 5);
  for (const a of baseline.acts) { assert.equal(a.promoted, false, `${a.idAto} not promoted`); assert.ok(a.unidentifiedChars <= a.canonicalChars); }
});
