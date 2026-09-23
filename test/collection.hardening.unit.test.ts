import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../src/modules/collection/checkpoint.repository.js';
import type { ConnectorPublication, ConnectorTimeBudget } from '../src/modules/collection/connector.contract.js';
import {
  createTimeBudget,
  defaultBudgetGraceMs,
  executeConnector,
} from '../src/modules/collection/connector.executor.js';
import { resolveCollectionRunStatus } from '../src/modules/collection/run-status.js';
import { SpedConnector, type SpedSourceState } from '../src/modules/collection/sped.connector.js';
import {
  CAPACITY_CRITICAL_RATIO,
  CAPACITY_WARNING_RATIO,
  capacityAlertLevel,
} from '../src/modules/operations/db-capacity.js';
import { pruneAttemptMetadata } from '../src/modules/operations/metadata-retention.js';
import { fakePortal, productionLikeInventory } from './sped.govbr.fixtures.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};
const NOW = () => new Date('2026-09-23T03:00:00Z');

function flagBudget(flag: { yield: boolean }): ConnectorTimeBudget {
  const far = new Date(Date.now() + 3_600_000);
  return { deadlineAt: far, softDeadlineAt: far, remainingMs: () => 3_600_000, shouldYield: () => flag.yield };
}

function fileSets(publications: ConnectorPublication[]): Map<string, string> {
  return new Map(publications.map((publication) => [
    publication.externalId!,
    (publication.files ?? []).map((file) => file.rawSha256).sort().join(','),
  ]));
}

async function referenceRun() {
  const portal = fakePortal(productionLikeInventory());
  return new SpedConnector({ fetch: portal.fetch, now: NOW }).collect(CONTEXT);
}

// ---------------------------------------------------------------------------
// Time budget primitives
// ---------------------------------------------------------------------------

test('default budget grace: 15% of the timeout, at least 2 min, at most half', () => {
  assert.equal(defaultBudgetGraceMs(1_200_000), 180_000);
  assert.equal(defaultBudgetGraceMs(600_000), 120_000);
  assert.equal(defaultBudgetGraceMs(100_000), 50_000);
  assert.equal(defaultBudgetGraceMs(10_000_000), 1_500_000);
});

test('createTimeBudget: soft deadline = hard deadline - grace; invalid grace rejected', () => {
  let clock = 1_000;
  const budget = createTimeBudget(1_000, 10_000, 3_000, () => clock);
  assert.equal(budget.deadlineAt.getTime(), 11_000);
  assert.equal(budget.softDeadlineAt.getTime(), 8_000);
  assert.equal(budget.shouldYield(), false);
  assert.equal(budget.remainingMs(), 10_000);
  clock = 8_000;
  assert.equal(budget.shouldYield(), true);
  assert.equal(budget.remainingMs(), 3_000);
  assert.throws(() => createTimeBudget(0, 10_000, 10_000), RangeError);
  assert.throws(() => createTimeBudget(0, 10_000, -1), RangeError);
});

test('executor passes a budget to the connector and keeps SUCCESS for a voluntary incomplete result', async () => {
  const outcome = await executeConnector({
    connector: {
      key: 'budget-probe',
      async collect(context) {
        assert.ok(context.budget);
        assert.ok(context.budget.softDeadlineAt < context.budget.deadlineAt);
        return { publications: [], completion: { complete: false, reason: 'TIME_BUDGET_REACHED' } };
      },
    },
    sourceId: CONTEXT.sourceId,
    runId: CONTEXT.runId,
    attemptId: CONTEXT.attemptId,
    timeoutMs: 60_000,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'SUCCESS');
  assert.equal(resolveCollectionRunStatus(outcome), 'PARTIAL_SUCCESS');
});

test('run status: completion.complete === false is PARTIAL_SUCCESS, complete runs are unchanged', () => {
  const base = { ok: true as const, status: 'SUCCESS' as const, durationMs: 1 };
  assert.equal(resolveCollectionRunStatus({ ...base, result: { publications: [], completion: { complete: false, reason: 'TIME_BUDGET_REACHED' } } }), 'PARTIAL_SUCCESS');
  assert.equal(resolveCollectionRunStatus({ ...base, result: { publications: [], completion: { complete: true } } }), 'SUCCESS_NO_RESULTS');
  assert.equal(resolveCollectionRunStatus({ ...base, result: { publications: [] } }), 'SUCCESS_NO_RESULTS');
});

// ---------------------------------------------------------------------------
// SPED graceful yield
// ---------------------------------------------------------------------------

test('SPED: budget exhausted before start yields an empty but valid result (no ALL_MODULES_FAILED)', async () => {
  const portal = fakePortal(productionLikeInventory());
  const result = await new SpedConnector({ fetch: portal.fetch, now: NOW })
    .collect({ ...CONTEXT, budget: flagBudget({ yield: true }) });
  assert.equal(result.publications.length, 0);
  assert.deepEqual(result.completion, {
    complete: false,
    reason: 'TIME_BUDGET_REACHED',
    pending: { modules: 4, crawlPages: 0, rechecks: 0, files: 0, deferredDocuments: 0 },
  });
  assert.ok(result.checkpoint);
  assert.equal(portal.stats.documentPageFetches + portal.stats.listingFetches, 0, 'no request after the soft deadline');
  assert.equal(result.metadata?.spedState, undefined, 'state is returned as checkpoint, not metadata');
});

test('SPED: yield during downloads emits only complete documents, defers the rest and resumes to the full set', async () => {
  const reference = fileSets((await referenceRun()).publications);

  const portal = fakePortal(productionLikeInventory());
  const flag = { yield: false };
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await portal.fetch(input, init);
    if (portal.stats.fileDownloads >= 3) flag.yield = true;
    return response;
  };
  const first = await new SpedConnector({ fetch: fetchImpl, now: NOW })
    .collect({ ...CONTEXT, budget: flagBudget(flag) });

  assert.equal(first.completion?.complete, false);
  assert.ok((first.completion?.pending?.files ?? 0) > 0);
  assert.ok((first.completion?.pending?.deferredDocuments ?? 0) > 0);
  const firstSets = fileSets(first.publications);
  assert.ok(firstSets.size > 0 && firstSets.size < reference.size);
  for (const [externalId, files] of firstSets) {
    assert.equal(files, reference.get(externalId), 'no publication with a partial file set: ' + externalId);
  }

  const state = first.checkpoint!.state as unknown as SpedSourceState;
  assert.ok(state.cycle, 'interrupted cycle stored in the checkpoint');
  assert.equal(state.cycle.completedModules.length, 4, 'discovery was complete');
  assert.equal(state.cycle.frontier.length, first.completion?.pending?.deferredDocuments);
  assert.ok(state.cycle.frontier.every((page) => page.forceFetch === true));

  flag.yield = false;
  portal.reset();
  const second = await new SpedConnector({ fetch: portal.fetch, now: NOW, readState: async () => state })
    .collect({ ...CONTEXT, budget: flagBudget(flag) });
  assert.equal(second.completion, undefined, 'the resumed run completes');
  assert.equal((second.checkpoint!.state as { cycle?: unknown }).cycle, undefined, 'cycle cleared');
  assert.equal(portal.stats.listingFetches, 0, 'resume starts from the frontier, not from the seeds');

  const union = new Map([...firstSets, ...fileSets(second.publications)]);
  assert.deepEqual([...union.entries()].sort(), [...reference.entries()].sort());
});

test('SPED: yield in the middle of discovery never emits a partial document and every budget size converges', async () => {
  const reference = fileSets((await referenceRun()).publications);

  // Virtual clock: each request costs 10 units. Each run gets a soft window
  // of `requestsPerRun` requests (60% for discovery, the rest for downloads).
  for (const requestsPerRun of [3, 5, 8, 12, 20]) {
    const portal = fakePortal(productionLikeInventory());
    let clock = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      clock += 10;
      return portal.fetch(input, init);
    };
    let state: SpedSourceState | undefined;
    const seen = new Map<string, string>();
    let yields = 0;
    for (let run = 0; run < 60; run += 1) {
      const started = clock;
      const soft = started + requestsPerRun * 10;
      const hard = soft + 1_000;
      const budget: ConnectorTimeBudget = {
        deadlineAt: new Date(hard),
        softDeadlineAt: new Date(soft),
        remainingMs: () => Math.max(0, hard - clock),
        shouldYield: () => clock >= soft,
      };
      const result = await new SpedConnector({
        fetch: fetchImpl,
        now: NOW,
        ...(state ? { readState: async () => state! } : {}),
      }).collect({ ...CONTEXT, budget });
      for (const [externalId, files] of fileSets(result.publications)) {
        assert.equal(files, reference.get(externalId), 'partial file set for ' + externalId + ' (' + requestsPerRun + ' requests/run)');
        seen.set(externalId, files);
      }
      state = result.checkpoint!.state as unknown as SpedSourceState;
      if (!result.completion) break;
      yields += 1;
    }
    if (requestsPerRun <= 8) assert.ok(yields > 0, 'budget pressure must force yields');
    assert.deepEqual([...seen.keys()].sort(), [...reference.keys()].sort(), 'converges with ' + requestsPerRun + ' requests/run');
  }
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

test('pruneAttemptMetadata keeps counters, drops heavy keys, keeps legacy state without a checkpoint', () => {
  const at = new Date('2030-01-01T00:00:00Z');
  const metadata = {
    publicationCount: 2,
    checkpointRef: { id: 'x', generation: 3 },
    completion: { complete: true },
    spedState: { items: {} },
    sped: { deferredDocumentCount: 1, deferredDocuments: [{}], identityAudit: { collisionsResolved: [{}], mirrorGroups: [], unresolvedCollisions: 0 } },
  };
  const kept = pruneAttemptMetadata(metadata, { hasSpedCheckpoint: false, hasNfeEncatCheckpoint: false }, at)!;
  assert.ok('spedState' in kept.metadata);
  assert.deepEqual(kept.removed.sort(), ['sped.deferredDocuments', 'sped.identityAudit']);

  const pruned = pruneAttemptMetadata(metadata, { hasSpedCheckpoint: true, hasNfeEncatCheckpoint: false }, at)!;
  assert.equal(pruned.metadata.spedState, undefined);
  assert.deepEqual(pruned.metadata.checkpointRef, metadata.checkpointRef);
  assert.deepEqual(pruned.metadata.completion, metadata.completion);
  assert.equal(pruned.metadata.publicationCount, 2);
  assert.equal((pruned.metadata.sped as Record<string, unknown>).deferredDocumentCount, 1);
  assert.deepEqual(pruned.metadata.metadataPruned, { at: at.toISOString(), keys: ['sped.deferredDocuments', 'sped.identityAudit', 'spedState'] });

  const untouched = { publicationCount: 1, douArchives: { a: 1 }, confaz: { x: 1 } };
  assert.deepEqual(pruneAttemptMetadata(untouched, { hasSpedCheckpoint: true, hasNfeEncatCheckpoint: true }, at), { metadata: untouched, removed: [] });
});

test('capacity alert levels: WARNING at 70%, CRITICAL at 85%, UNKNOWN without capacity', () => {
  assert.equal(CAPACITY_WARNING_RATIO, 0.7);
  assert.equal(CAPACITY_CRITICAL_RATIO, 0.85);
  assert.equal(capacityAlertLevel(null), 'UNKNOWN');
  assert.equal(capacityAlertLevel(0.69), 'OK');
  assert.equal(capacityAlertLevel(0.7), 'WARNING');
  assert.equal(capacityAlertLevel(0.85), 'CRITICAL');
});

test('canonicalJson is independent of key order (checkpoint integrity hash)', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});
