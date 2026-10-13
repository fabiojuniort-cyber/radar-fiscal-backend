import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJson,
} from '../src/modules/taxonomy/baseline/baseline.canonical-json.js';
import {
  buildDerivationFingerprint,
  manifestBytes,
  manifestSha256,
} from '../src/modules/taxonomy/baseline/baseline.manifest.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';

test('canonical JSON is independent of object insertion order', () => {
  const left = {
    z: 1,
    a: {
      y: 2,
      b: 3,
    },
  };
  const right = {
    a: {
      b: 3,
      y: 2,
    },
    z: 1,
  };

  assert.equal(
    canonicalJson(left),
    canonicalJson(right),
  );
});

test('same derivation inputs produce identical manifest bytes and hash', async () => {
  const left = await loadBaseline();
  const right = await loadBaseline();

  assert.equal(
    manifestBytes(left.manifest),
    manifestBytes(right.manifest),
  );
  assert.equal(
    manifestSha256(left.manifest),
    manifestSha256(right.manifest),
  );
  assert.equal(
    left.manifest.derivation.fingerprint,
    right.manifest.derivation.fingerprint,
  );
});

test('parser evolution changes derivation fingerprint without source corruption', async () => {
  const loaded = await loadBaseline();

  const v1 = buildDerivationFingerprint({
    source: loaded.source,
    technicalContract: loaded.technicalContract,
    parserVersion: 'r6-markdown-parser/v1',
  });
  const v2 = buildDerivationFingerprint({
    source: loaded.source,
    technicalContract: loaded.technicalContract,
    parserVersion: 'r6-markdown-parser/v2',
  });

  assert.notEqual(v1, v2);
  assert.equal(
    loaded.source.sha256,
    '7f68d7be2dfc5486f4fb5c88259de629976b1daa54b62cf9248f4e6efbbadfd2',
  );
});

test('technical contract and relation seed version participate in derivation fingerprint', async () => {
  const loaded = await loadBaseline();
  const baseline = loaded.manifest.derivation.fingerprint;

  const relationV2 = buildDerivationFingerprint({
    source: loaded.source,
    technicalContract: loaded.technicalContract,
    relationSeedContractVersion:
      'relation-seed-contract/v2',
  });

  const modifiedContract = {
    ...loaded.technicalContract,
    sha256: '0'.repeat(64),
  };

  const contractChanged = buildDerivationFingerprint({
    source: loaded.source,
    technicalContract: modifiedContract,
  });

  assert.notEqual(baseline, relationV2);
  assert.notEqual(baseline, contractChanged);
});

test('manifest excludes runtime-specific timestamp and physical UUID fields', async () => {
  const loaded = await loadBaseline();
  const bytes = manifestBytes(loaded.manifest);

  assert.equal(bytes.includes('generated_at'), false);
  assert.equal(bytes.includes('hostname'), false);
  assert.equal(bytes.includes('"pid"'), false);
  assert.equal(
    /"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/i
      .test(bytes),
    false,
  );
});
