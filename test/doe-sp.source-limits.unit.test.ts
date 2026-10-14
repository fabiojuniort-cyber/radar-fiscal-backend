import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { DOE_SP_SEARCH_API, DoeSpClient } from '../src/modules/collection/doe-sp.client.js';
import {
  DOE_SP_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN,
  DOE_SP_DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DoeSpConnector,
  EMPTY_DOE_SP_STATE,
  resolveDoeSpSourceLimits,
  type DoeSpSourceState,
} from '../src/modules/collection/doe-sp.connector.js';
import { parseDoeSpSourceState } from '../src/modules/collection/doe-sp-source-state.repository.js';
import { resolveCollectionRunStatus } from '../src/modules/collection/run-status.js';
import { ID, list0901, list0902, list0904, structured0902, structured0904 } from './doe-sp.fixtures.js';
import { portal } from './doe-sp.portal.js';

/*
 * DOE-SP-42: politeness towards the official API. After a heavy bootstrap
 * run (447 requests / 88 MB) the workers started getting connect timeouts
 * from the source while another service could still reach it.
 */

const context = () => ({
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
});
const NOW = new Date('2026-09-04T12:00:00Z');
const DAYS = {
  '2026-09-01': { structured: { items: [] }, list: list0901 },
  '2026-09-02': { structured: structured0902, list: list0902 },
  '2026-09-04': { structured: structured0904, list: list0904 },
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('limits: production defaults and validation', () => {
  assert.deepEqual(resolveDoeSpSourceLimits({}), {
    minRequestIntervalMs: DOE_SP_DEFAULT_MIN_REQUEST_INTERVAL_MS,
    maxDownloadBytesPerRun: DOE_SP_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN,
  });
  assert.equal(DOE_SP_DEFAULT_MIN_REQUEST_INTERVAL_MS, 1_000);
  assert.equal(DOE_SP_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN, 50 * 1024 * 1024);
  assert.deepEqual(resolveDoeSpSourceLimits({ DOE_SP_MIN_REQUEST_INTERVAL_MS: '0', DOE_SP_MAX_DOWNLOAD_BYTES_PER_RUN: '0' }), {
    minRequestIntervalMs: 0, maxDownloadBytesPerRun: 0,
  });
  assert.throws(() => resolveDoeSpSourceLimits({ DOE_SP_MIN_REQUEST_INTERVAL_MS: '-1' }), RangeError);
  assert.throws(() => resolveDoeSpSourceLimits({ DOE_SP_MIN_REQUEST_INTERVAL_MS: 'fast' }), RangeError);
  assert.throws(() => resolveDoeSpSourceLimits({ DOE_SP_MAX_DOWNLOAD_BYTES_PER_RUN: '1.5' }), RangeError);
});

test('client: requests are spaced by the minimum interval; 0 keeps them back to back', async () => {
  const starts: number[] = [];
  const fetchMock = (async () => { starts.push(Date.now()); return json({ ok: true }); }) as typeof fetch;
  const spaced = new DoeSpClient({ fetch: fetchMock, minRequestIntervalMs: 150 });
  for (let i = 0; i < 3; i += 1) await spaced.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, new AbortController().signal);
  assert.ok(starts[1]! - starts[0]! >= 140 && starts[2]! - starts[1]! >= 140, `gaps ${starts[1]! - starts[0]!} / ${starts[2]! - starts[1]!}`);

  starts.length = 0;
  const free = new DoeSpClient({ fetch: fetchMock });
  for (let i = 0; i < 3; i += 1) await free.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, new AbortController().signal);
  assert.ok(starts[2]! - starts[0]! < 100);
});

test('client: cancellation interrupts the wait between requests', async () => {
  const client = new DoeSpClient({ fetch: (async () => json({ ok: true })) as typeof fetch, minRequestIntervalMs: 5_000 });
  await client.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, new AbortController().signal);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(
    client.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, controller.signal),
    (error: unknown) => error instanceof ConnectorError && error.kind === 'CANCELLED',
  );
  assert.ok(Date.now() - started < 1_000, 'did not wait the full interval');
});

test('connector: byte budget stops between backfill days, always advancing at least one day per run', async () => {
  let state: DoeSpSourceState = EMPTY_DOE_SP_STATE;
  const captured = new Set<string>();
  const pendingPerRun: number[] = [];
  for (let run = 0; run < 6; run += 1) {
    const current = state;
    const result = await new DoeSpConnector({
      fetch: portal({ days: DAYS }).fetch, now: () => NOW, readState: async () => current,
      lookbackDays: 1, bootstrapStartDate: '2026-09-01', forceReprocess: false,
      client: { timeoutMs: 1_000 }, maxDownloadBytesPerRun: 1,
    }).collect(context());
    for (const publication of result.publications) captured.add(publication.externalId!);
    const meta = result.metadata?.doeSp as { backfillDaysProcessed: number; pendingDays: number; sourceLimits: { reached: boolean } };
    pendingPerRun.push(meta.pendingDays);
    state = parseDoeSpSourceState(result.checkpoint?.state);
    if (meta.pendingDays > 0) {
      assert.equal(meta.backfillDaysProcessed, 1, 'exactly one backfill day per run under a tiny budget');
      assert.equal(result.completion?.reason, 'SOURCE_BUDGET_REACHED');
      assert.equal(meta.sourceLimits.reached, true);
      assert.equal(resolveCollectionRunStatus({ ok: true, status: 'SUCCESS', result, durationMs: 1 }), 'PARTIAL_SUCCESS');
    } else {
      assert.equal(result.completion, undefined);
      break;
    }
  }
  assert.deepEqual(pendingPerRun, [2, 1, 0], 'pending days decrease by one per run until the bootstrap ends');
  assert.deepEqual(state.pendingRanges, []);
  assert.deepEqual([...captured].sort(), [...list0904.publications.map(item => item.id), ID.dicar59, ID.retification].sort());
});

test('connector: without a byte budget the bootstrap completes in one run (unchanged behaviour)', async () => {
  const result = await new DoeSpConnector({
    fetch: portal({ days: DAYS }).fetch, now: () => NOW, readState: async () => EMPTY_DOE_SP_STATE,
    lookbackDays: 1, bootstrapStartDate: '2026-09-01', forceReprocess: false, client: { timeoutMs: 1_000 },
  }).collect(context());
  assert.equal(result.completion, undefined);
  assert.deepEqual(parseDoeSpSourceState(result.checkpoint?.state).pendingRanges, []);
  assert.equal((result.metadata?.doeSp as { sourceLimits: { reached: boolean } }).sourceLimits.reached, false);
});
