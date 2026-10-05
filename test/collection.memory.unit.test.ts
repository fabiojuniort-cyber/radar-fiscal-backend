import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FileHandle } from 'node:fs/promises';
import type { CollectionConnector, ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { connectorPublicationCount } from '../src/modules/collection/connector.contract.js';
import { createCollectionMemoryProbe } from '../src/modules/collection/collection.memory.js';
import { executeConnector } from '../src/modules/collection/connector.executor.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { DouConnector } from '../src/modules/collection/dou.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { resolveCollectionRunStatus } from '../src/modules/collection/run-status.js';
import { fixtureFetch } from './dou.fixtures.js';
import { PublicationSpool, disposePublicationSpool } from '../src/modules/collection/publication-spool.js';

const item: ConnectorPublication = {
  title: 'Ato oficial', sphere: 'FEDERAL', content: 'Conteúdo completo.',
  officialUrl: 'https://example.invalid/ato', externalId: 'ato-1',
  publishedAt: new Date('2026-09-18T00:00:00Z'),
};
const execute = (connector: CollectionConnector, timeoutMs = 5_000, signal?: AbortSignal) => executeConnector({
  connector, timeoutMs, sourceId: 'source', runId: 'run', attemptId: 'attempt',
  ...(signal ? { signal } : {}),
});

test('incremental executor preserves collect barrier, dates, counts and legacy collector API', async () => {
  let collectionFinished = false;
  const outcome = await execute({
    key: 'test', collect: async () => { throw new Error('array path must not be called'); },
    collectIncremental: async (_context, emit) => {
      await emit(item);
      assert.equal(collectionFinished, false);
      collectionFinished = true;
      return { publications: [], metadata: { receipt: 'complete' } };
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  try {
    assert.equal(collectionFinished, true);
    assert.equal(outcome.result.publications.length, 0);
    assert.equal(connectorPublicationCount(outcome.result), 1);
    assert.equal(resolveCollectionRunStatus(outcome), 'SUCCESS');
    for await (const replayed of outcome.result.publicationStream!) assert.deepEqual(replayed, item);
  } finally { await outcome.result.publicationStream?.dispose(); }

  const legacy = await execute({ key: 'legacy', collect: async () => ({ publications: [item] }) });
  assert.ok(legacy.ok);
  assert.equal(legacy.result.publicationStream, undefined);
  assert.deepEqual(legacy.result.publications, [item]);
});

test('late collection failure discards staged publications and receipts before persistence', async () => {
  const outcome = await execute({
    key: 'test', collect: async () => ({ publications: [] }),
    collectIncremental: async (_context, emit) => {
      await emit(item);
      throw new ConnectorError('LAST_PACKAGE_FAILED', { code: 'LAST_PACKAGE_FAILED', kind: 'NETWORK_ERROR', retryable: true });
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'LAST_PACKAGE_FAILED');
  assert.equal(outcome.retryable, true);
  assert.equal('result' in outcome, false);
});

test('incremental collectors cannot return a second retained publication array', async () => {
  const outcome = await execute({
    key: 'test', collect: async () => ({ publications: [] }),
    collectIncremental: async (_context, emit) => { await emit(item); return { publications: [item] }; },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, 'INCREMENTAL_CONNECTOR_INVALID_RESULT');
});

test('timeout and external cancellation reject late sink writes and discard staging', async () => {
  for (const externalCancellation of [false, true]) {
    const controller = new AbortController();
    let lateWriteRejected = false;
    let completed!: () => void;
    const done = new Promise<void>(resolve => { completed = resolve; });
    const timer = externalCancellation ? setTimeout(() => controller.abort(), 20) : undefined;
    const outcome = await execute({
      key: 'test', collect: async () => ({ publications: [] }),
      collectIncremental: async (_context, emit) => {
        await emit(item);
        await delay(70);
        try { await emit(item); } catch { lateWriteRejected = true; }
        completed();
        return { publications: [] };
      },
    }, externalCancellation ? 1_000 : 20, externalCancellation ? controller.signal : undefined);
    if (timer) clearTimeout(timer);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.status, externalCancellation ? 'CANCELLED' : 'TIMEOUT');
    await done;
    assert.equal(lateWriteRejected, true);
  }
});

test('pre-cancelled collection returns a sanitized cancellation without invoking the connector', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private cancellation reason'));
  let calls = 0;
  const outcome = await execute({ key: 'test', collect: async () => { calls++; return { publications: [] }; } }, 1_000, controller.signal);
  assert.equal(outcome.ok, false);
  assert.equal(calls, 0);
  if (!outcome.ok) {
    assert.equal(outcome.status, 'CANCELLED');
    assert.equal(outcome.message, 'Connector execution cancelled');
    assert.equal(JSON.stringify(outcome).includes('private'), false);
  }
});

test('spool cleanup failures are structured outcomes rather than rejected executor calls', async t => {
  const dispose = PublicationSpool.prototype.dispose;
  t.mock.method(PublicationSpool.prototype, 'dispose', async function (this: PublicationSpool) {
    await dispose.call(this);
    throw new Error('private path in cleanup failure');
  });
  const outcome = await execute({
    key: 'test', collect: async () => ({ publications: [] }),
    collectIncremental: async (_context, emit) => { await emit(item); throw new Error('fixture failure'); },
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 'PROCESSING_ERROR');
    assert.equal(outcome.code, 'PUBLICATION_SPOOL_CLEANUP_FAILED');
    assert.equal(outcome.retryable, false);
    assert.equal(JSON.stringify(outcome).includes('private'), false);
  }
});

test('blocked cleanup has bounded grace and remains fail closed', async () => {
  await assert.rejects(disposePublicationSpool({ dispose: () => new Promise<void>(() => {}) }, 10),
    (error: unknown) => error instanceof ConnectorError && error.code === 'PUBLICATION_SPOOL_CLEANUP_TIMEOUT' && !error.retryable);
});

test('a stuck spool write cannot make the executor hard timeout wait indefinitely', async t => {
  const create = PublicationSpool.create;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let captured: PublicationSpool | undefined;
  t.mock.method(PublicationSpool, 'create', async (signal?: AbortSignal) => {
    captured = await create.call(PublicationSpool, signal);
    const handle = (captured as unknown as { handle: FileHandle }).handle;
    const write = handle.write.bind(handle);
    t.mock.method(handle, 'write', async (...args: Parameters<typeof write>) => {
      await gate;
      return write(...args);
    });
    return captured;
  });
  try {
    const outcome = await execute({
      key: 'test', collect: async () => ({ publications: [] }),
      collectIncremental: async (_context, emit) => { await emit(item); return { publications: [] }; },
    }, 20);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, 'PUBLICATION_SPOOL_CLEANUP_TIMEOUT');
      assert.equal(outcome.retryable, false);
    }
  } finally {
    release();
    await captured?.dispose();
  }
});

test('DOU spool replay exactly matches array collection including hashes, presentation and receipts', async () => {
  const connector = new DouConnector({
    credentials: () => ({ email: 'test@example.invalid', password: 'fixture' }),
    now: () => new Date('2026-09-21T12:00:00Z'), dates: ['2026-09-18'], fetch: await fixtureFetch(),
  });
  const direct = await connector.collect({ sourceId: 'source', runId: 'run', attemptId: 'attempt', signal: new AbortController().signal });
  const outcome = await execute(connector);
  assert.ok(outcome.ok);
  try {
    const replayed: ConnectorPublication[] = [];
    for await (const publication of outcome.result.publicationStream!) replayed.push(publication);
    assert.deepEqual(replayed, direct.publications);
    assert.deepEqual(outcome.result.metadata, direct.metadata);
    assert.deepEqual(outcome.result.partialFailures, direct.partialFailures);
    assert.deepEqual(replayed.map(publication => normalizePublication({ sourceId: 'source', publication })),
      direct.publications.map(publication => normalizePublication({ sourceId: 'source', publication })));
  } finally { await outcome.result.publicationStream?.dispose(); }
});

test('memory telemetry is shape-only with fixed process counters', () => {
  let sample: Record<string, unknown> = {};
  const probe = createCollectionMemoryProbe(value => { sample = { ...value }; });
  probe('archive_parsed', { publications: 4, xmlEntries: 8 });
  assert.deepEqual(Object.keys(sample).sort(), ['phase', 'publications', 'xmlEntries', 'rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].sort());
  assert.equal(sample.phase, 'archive_parsed');
  for (const [key, value] of Object.entries(sample)) if (key !== 'phase') assert.ok(typeof value === 'number' && Number.isFinite(value));
});
