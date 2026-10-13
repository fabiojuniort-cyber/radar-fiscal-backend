import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolClient, QueryResult } from 'pg';

import {
  DIMENSIONS,
} from '../src/modules/taxonomy/baseline/baseline.constants.js';
import {
  planBaselinePersistence,
} from '../src/modules/taxonomy/baseline/baseline.planner.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';
import {
  REQUIRED_PRESERVED_DIMENSION_CODES,
  RETIRED_DIMENSION_CODES,
  planTaxonomyV11FromCanonicalV1,
  planTaxonomyV11Successor,
} from '../src/modules/taxonomy/release/taxonomy-successor-v1-1.js';

function fakeClient(responses: unknown[][]): PoolClient {
  let index = 0;

  return {
    query: async () =>
      ({
        rows: responses[index++] ?? [],
      }) as QueryResult,
  } as unknown as PoolClient;
}

test('empty database plans all 20+628 identities/revisions as new', async () => {
  const loaded = await loadBaseline();
  const plan = await planBaselinePersistence(
    fakeClient([[], [], []]),
    loaded.manifest,
    loaded.manifestSha256,
  );

  assert.equal(plan.releaseAction, 'CREATE_RELEASE');
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.summary.newIdentities, 648);
  assert.equal(plan.summary.newRevisions, 648);
  assert.equal(plan.summary.reusedIdentities, 0);
  assert.equal(plan.summary.reusedRevisions, 0);
});

test('same target with identical derivation is idempotent', async () => {
  const loaded = await loadBaseline();
  const plan = await planBaselinePersistence(
    fakeClient([
      [{
        id: 'release-id',
        manifest: {
          manifestSha256: loaded.manifestSha256,
          derivationFingerprint:
            loaded.manifest.derivation.fingerprint,
        },
      }],
      [],
      [],
    ]),
    loaded.manifest,
    loaded.manifestSha256,
  );

  assert.equal(
    plan.releaseAction,
    'IDEMPOTENT_EXISTING_RELEASE',
  );
});

test('same target bound to another fingerprint is blocked', async () => {
  const loaded = await loadBaseline();
  const plan = await planBaselinePersistence(
    fakeClient([
      [{
        id: 'release-id',
        manifest: {
          manifestSha256: '0'.repeat(64),
          derivationFingerprint: '1'.repeat(64),
        },
      }],
      [],
      [],
    ]),
    loaded.manifest,
    loaded.manifestSha256,
  );

  assert.equal(plan.releaseAction, 'VERSION_CONFLICT');
  assert.ok(
    plan.conflicts.includes('TARGET_VERSION_ALREADY_BOUND'),
  );
});

test('v1.1 retires only the five non-canonical dimensions', () => {
  const plan = planTaxonomyV11FromCanonicalV1();

  assert.equal(plan.targetVersion, 'v1.1.0');
  assert.equal(plan.sourceDimensions, 20);
  assert.equal(plan.sourceConcepts, 628);
  assert.equal(plan.retiredDimensions, 5);
  assert.equal(plan.retiredConcepts, 38);
  assert.equal(plan.retainedDimensions, 15);
  assert.equal(plan.retainedConcepts, 590);
  assert.deepEqual(
    plan.retiredDimensionCodes,
    [...RETIRED_DIMENSION_CODES],
  );

  for (const code of REQUIRED_PRESERVED_DIMENSION_CODES) {
    assert.ok(
      plan.retainedDimensionCodes.includes(code),
      code + ' must remain in v1.1',
    );
  }
});

test('v1.1 retained dimensions are canonical V1 minus retired dimensions', () => {
  const plan = planTaxonomyV11FromCanonicalV1();
  const retired = new Set<string>(RETIRED_DIMENSION_CODES);
  const expected = DIMENSIONS
    .map(([code]) => code)
    .filter((code) => !retired.has(code));

  assert.deepEqual(plan.retainedDimensionCodes, expected);
});

test('v1.1 planner blocks an incomplete V1 source', () => {
  const source = DIMENSIONS
    .filter(([code]) => code !== 'event')
    .map(([code, , conceptCount]) => ({ code, conceptCount }));

  assert.throws(
    () => planTaxonomyV11Successor(source),
    /TAXONOMY_V1_1_SOURCE_MISSING_RETIRED_DIMENSION:event/,
  );
});

test('v1.1 planner protects legislation dimensions', () => {
  const source = DIMENSIONS
    .filter(([code]) => code !== 'theme')
    .map(([code, , conceptCount]) => ({ code, conceptCount }));

  assert.throws(
    () => planTaxonomyV11Successor(source),
    /TAXONOMY_V1_1_SOURCE_MISSING_REQUIRED_DIMENSION:theme/,
  );
});
