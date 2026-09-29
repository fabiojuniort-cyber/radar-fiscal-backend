import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolClient, QueryResult } from 'pg';

import {
  planBaselinePersistence,
} from '../src/modules/taxonomy/baseline/baseline.planner.js';
import {
  loadBaseline,
} from '../src/modules/taxonomy/baseline/baseline.source-reader.js';

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
