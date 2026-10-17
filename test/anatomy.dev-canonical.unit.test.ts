import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { computeDevelopmentCanonical, DEV_CANONICAL_PATH } from '../ops/anatomy/dev-canonical.js';

const RESERVED = ['04', '06', '08', '09', '12', '14', '16', '18', '24', '28'];

test('frozen development canonical text matches the versioned preparation and reader', () => {
  assert.equal(readFileSync(DEV_CANONICAL_PATH, 'utf8').replace(/\r\n/g, '\n'), computeDevelopmentCanonical());
});

test('frozen canonical file never contains reserved entries or text bodies', () => {
  const frozen = JSON.parse(readFileSync(DEV_CANONICAL_PATH, 'utf8')) as { entries: { id: string; [k: string]: unknown }[] };
  assert.deepEqual(frozen.entries.map((e) => e.id), ['01', '02', '03', '05', '07', '10', '11']);
  for (const e of frozen.entries) {
    assert.ok(!RESERVED.includes(e.id));
    assert.ok(!('canonicalText' in e));
  }
});
