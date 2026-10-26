import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import test from 'node:test';

// Inventory integrity only: never imports a reader/engine or evaluates holdout.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./fixtures/anatomy/corpus-manifest.json', import.meta.url), 'utf8'));
const entries = manifest.entries as Array<{
  id: string; source: string; partition: string; availability: string;
  inputs: Array<{ path: string; bytes: number; sha256: string }>;
  gold: { status: string; utf16SpansComplete: boolean; independentReview: string };
  evaluation: { executed: boolean; result: unknown };
  documentedExpectedSha256?: string; actualSha256?: string | null;
}>;

test('corpus inventory contains 30 unique publications and the fixed ten reserved IDs', () => {
  assert.deepEqual(entries.map(entry => entry.id), Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0')));
  assert.deepEqual(entries.filter(entry => entry.partition === 'reserved-final').map(entry => entry.id),
    ['04', '06', '08', '09', '12', '14', '16', '18', '24', '28']);
  assert.deepEqual(manifest.holdoutPolicy.ids, entries.filter(entry => entry.partition === 'reserved-final').map(entry => entry.id));
  assert.equal(entries.filter(entry => entry.source === 'CONFAZ').length, 2);
  assert.equal(entries.filter(entry => entry.source === 'DOU').length, 10);
  assert.equal(entries.filter(entry => entry.source === 'DOE-SP').length, 10);
  assert.equal(entries.filter(entry => entry.source === 'RFB').length, 8);
});

test('every frozen input matches its byte count and SHA-256 without text normalization', () => {
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const input of entry.inputs) {
      assert.match(input.path, /^test\/fixtures\/anatomy\/inputs\//);
      const path = resolve(root, input.path);
      assert.ok(path.startsWith(resolve(root, 'test/fixtures/anatomy/inputs') + sep));
      assert.ok(!paths.has(input.path));
      paths.add(input.path);
      const bytes = readFileSync(path);
      assert.equal(bytes.length, input.bytes, `${entry.id}: byte count`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), input.sha256, `${entry.id}: hash`);
    }
  }
  assert.equal(paths.size, manifest.counts.inputFilesFrozen);
  assert.equal(entries.find(entry => entry.id === '10')?.inputs.length, 3);
});

test('missing original bodies are explicit and are never assigned a verified hash', () => {
  const missing = entries.filter(entry => entry.availability === 'missing');
  assert.equal(missing.length, manifest.counts.publicationsMissingOriginalInputs);
  for (const entry of missing) {
    assert.deepEqual(entry.inputs, []);
    assert.equal(entry.actualSha256, null);
    assert.match(entry.documentedExpectedSha256!, /^[a-f0-9]{64}$/);
  }
  assert.equal(entries.filter(entry => entry.availability === 'available').length,
    manifest.counts.publicationsWithExactAvailableInputs);
});

test('inventory cannot be mistaken for reviewed gold or measured acceptance', () => {
  assert.equal(manifest.status, 'BLOCK_CORPUS_INPUTS_AND_GOLD');
  for (const entry of entries) {
    assert.equal(entry.gold.status, 'missing');
    assert.equal(entry.gold.utf16SpansComplete, false);
    assert.equal(entry.gold.independentReview, 'not-performed');
    assert.equal(entry.evaluation.executed, false);
    assert.equal(entry.evaluation.result, null);
  }
});
