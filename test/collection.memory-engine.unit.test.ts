import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type QueryResult,
} from 'kysely';

import type { DB } from '../src/infrastructure/database/database.types.js';
import type { AcquiredCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import type { CollectionConnector, ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { PublicationSpool } from '../src/modules/collection/publication-spool.js';

const run: AcquiredCollectionRun = {
  id: 'memory-run', sourceId: 'memory-source', connectorKey: 'dou', maxAttempts: 1,
  correlationId: 'memory-correlation', workerId: 'memory-worker',
};
const publication: ConnectorPublication = {
  title: 'Portaria de teste', sphere: 'FEDERAL', officialUrl: 'https://example.invalid/act/1',
  externalId: 'fixture-1', content: 'Complete fixture publication content.',
};
const receipts = { '2026-09-18-DO1.zip': 'a'.repeat(64) };
const engineOptions = { timeoutMs: 10_000, heartbeatIntervalMs: 0 };

interface QueryStep {
  name: string;
  sql: RegExp;
  rows?: unknown[];
  inspect?: (query: CompiledQuery) => void;
  error?: Error;
}

function scriptedDatabase(t: TestContext, steps: QueryStep[], events: string[]) {
  const remaining = [...steps];
  const queries: CompiledQuery[] = [];
  const driver = new DummyDriver();
  driver.acquireConnection = async () => ({
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      if (/^select "id", "code", "connector_key" from "sources"/.test(query.sql)) {
        return {
          rows: [{
            id: String(query.parameters[0] ?? 'fixture-source'),
            code: 'dou',
            connector_key: 'dou',
          }] as R[],
        };
      }
      if (/FROM collection_filter_policies p/.test(query.sql)) {
        return { rows: [] as R[] };
      }
      const step = remaining.shift();
      assert.ok(step, `Unexpected query: ${query.sql}`);
      assert.match(query.sql, step.sql);
      events.push(`db:${step.name}`);
      step.inspect?.(query);
      if (step.error) throw step.error;
      return { rows: (step.rows ?? []) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
  });
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: database => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  t.after(() => db.destroy());
  return { db, queries, assertDone: () => assert.equal(remaining.length, 0, 'all expected queries executed') };
}

function updateValue(query: CompiledQuery, column: string): unknown {
  const match = query.sql.match(new RegExp(`"${column}" = \\$(\\d+)`));
  assert.ok(match, `Missing ${column} update in ${query.sql}`);
  return query.parameters[Number(match[1]) - 1];
}

function attemptMetadata(query: CompiledQuery): Record<string, unknown> {
  const value = updateValue(query, 'metadata');
  assert.ok(value !== null && typeof value === 'object');
  return value as Record<string, unknown>;
}

function startAttempt(): QueryStep[] {
  return [
    { name: 'owned-run', sql: /^select .* from "collection_runs" .*for update$/, rows: [{ id: run.id, status: 'RUNNING', worker_id: run.workerId }] },
    { name: 'last-attempt', sql: /^select "attempt_no" from "collection_attempts"/, rows: [] },
    { name: 'start-attempt', sql: /^insert into "collection_attempts"/, rows: [{ id: 'memory-attempt', collection_run_id: run.id, attempt_no: 1 }] },
  ];
}

function lockRunForAttemptFinish(owned = true): QueryStep {
  return {
    name: 'finish-owned-run', sql: /^select "id" from "collection_runs" .*for update$/,
    rows: owned ? [{ id: run.id }] : [],
    inspect(query) {
      assert.match(query.sql, /"id" = \$\d+/);
      assert.match(query.sql, /"status" = \$\d+/);
      assert.match(query.sql, /"worker_id" = \$\d+/);
      assert.ok(query.parameters.includes(run.id));
      assert.ok(query.parameters.includes('RUNNING'));
      assert.ok(query.parameters.includes(run.workerId));
    },
  };
}

function lockAttemptForFinish(running = true): QueryStep {
  return {
    name: 'owned-attempt', sql: /^select "id" from "collection_attempts" .*for update$/,
    rows: running ? [{ id: 'memory-attempt' }] : [],
    inspect(query) {
      assert.match(query.sql, /"id" = \$\d+/);
      assert.match(query.sql, /"status" = \$\d+/);
      assert.match(query.sql, /"collection_run_id" = \$\d+/);
      assert.ok(query.parameters.includes('memory-attempt'));
      assert.ok(query.parameters.includes('RUNNING'));
      assert.ok(query.parameters.includes(run.id));
    },
  };
}

function finishSuccessfulAttempt(count: number): QueryStep[] {
  return [
    lockRunForAttemptFinish(),
    lockAttemptForFinish(),
    {
      name: 'finish-attempt', sql: /^update "collection_attempts" set /, rows: [{ id: 'memory-attempt' }],
      inspect(query) {
        assert.match(query.sql, /returning "id"$/);
        assert.equal(updateValue(query, 'status'), 'SUCCESS');
        const metadata = attemptMetadata(query);
        assert.equal(metadata.publicationCount, count);
        assert.deepEqual(metadata.douArchives, receipts);
        assert.equal(Object.hasOwn(metadata, 'publicationStream'), false, 'runtime spool is not serialized into history');
      },
    },
  ];
}

function finishRun(status: string, inspect?: (query: CompiledQuery) => void): QueryStep {
  return {
    name: 'finish-run', sql: /^update "collection_runs" set /, rows: [{ id: run.id }],
    inspect(query) {
      assert.equal(updateValue(query, 'status'), status);
      inspect?.(query);
    },
  };
}

function registry(collectIncremental: NonNullable<CollectionConnector['collectIncremental']>): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register({
    key: run.connectorKey, version: 'memory-test', collectIncremental,
    async collect() { throw new Error('Incremental connector must not use the buffered path.'); },
  });
  return registry;
}

function observeSpools(t: TestContext, events: string[]) {
  const create = PublicationSpool.create;
  const seal = PublicationSpool.prototype.seal;
  const dispose = PublicationSpool.prototype.dispose;
  const spools: PublicationSpool[] = [];
  const disposed = new Set<PublicationSpool>();
  t.mock.method(PublicationSpool, 'create', async (signal?: AbortSignal) => {
    const spool = await create(signal);
    spools.push(spool);
    return spool;
  });
  t.mock.method(PublicationSpool.prototype, 'seal', async function (this: PublicationSpool) {
    await seal.call(this);
    events.push('sealed');
  });
  t.mock.method(PublicationSpool.prototype, 'dispose', async function (this: PublicationSpool) {
    // Real cleanup completes before it is counted, so these assertions do
    // not mistake an attempted or mocked no-op disposal for successful I/O.
    await dispose.call(this);
    disposed.add(this);
    events.push('disposed');
  });
  // Safety cleanup also runs when an assertion fails before the engine can
  // release a spool; it does not contribute to the disposal assertions.
  t.after(async () => {
    for (const spool of spools) await dispose.call(spool);
  });
  return {
    spools,
    assertDisposed() {
      assert.equal(spools.length, 1);
      assert.equal(disposed.has(spools[0]!), true, 'the engine/executor disposed its real spool');
    },
  };
}

function assertNoPublicationPersistence(queries: CompiledQuery[], allowItemFailure = false): void {
  assert.equal(queries.some(query => /"(?:publications|publication_[^"]*|collection_checkpoints)"/.test(query.sql)), false);
  if (!allowItemFailure) assert.equal(queries.some(query => /"collection_items"/.test(query.sql)), false);
}

test('late collection failure discards staged publications without persisting items or eligible receipts', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const database = scriptedDatabase(t, [
    ...startAttempt(),
    lockRunForAttemptFinish(),
    lockAttemptForFinish(),
    {
      name: 'finish-failed-attempt', sql: /^update "collection_attempts" set /, rows: [{ id: 'memory-attempt' }],
      inspect(query) {
        assert.match(query.sql, /returning "id"$/);
        assert.equal(updateValue(query, 'status'), 'PROCESSING_ERROR');
        assert.equal(updateValue(query, 'error_code'), 'FIXTURE_LATE_COLLECTION_FAILURE');
        assert.deepEqual(attemptMetadata(query), {}, 'failed collection must not publish successful archive receipts');
      },
    },
    finishRun('PROCESSING_FAILED'),
  ], events);
  const result = await processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
    await emit(publication);
    assert.equal(database.queries.length, 3, 'only attempt acquisition happened before collect completed');
    throw new ConnectorError('A later archive failed.', {
      code: 'FIXTURE_LATE_COLLECTION_FAILURE', kind: 'PROCESSING_ERROR', retryable: false,
    });
  }), run, engineOptions);

  assert.equal(result.status, 'PROCESSING_FAILED');
  assert.equal(result.state, 'TERMINAL');
  assert.equal(result.metrics.found, 0);
  assert.equal(result.metrics.processed, 0);
  assert.equal(events.includes('sealed'), false);
  assert.ok(events.indexOf('disposed') < events.indexOf('db:finish-failed-attempt'));
  assertNoPublicationPersistence(database.queries);
  spool.assertDisposed();
  database.assertDone();
});

test('successful empty spool counts zero and is disposed before SUCCESS_NO_RESULTS is committed', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const database = scriptedDatabase(t, [
    ...startAttempt(), ...finishSuccessfulAttempt(0),
    finishRun('SUCCESS_NO_RESULTS', () => {
      spool.assertDisposed();
      assert.ok(events.indexOf('sealed') < events.indexOf('db:finish-attempt'));
      assert.ok(events.indexOf('db:finish-attempt') < events.indexOf('disposed'));
      assert.ok(events.indexOf('disposed') < events.indexOf('db:finish-run'));
    }),
  ], events);
  const result = await processAcquiredCollectionRun(database.db, registry(async () => ({
    publications: [], metadata: { douArchives: receipts },
  })), run, engineOptions);

  assert.equal(result.status, 'SUCCESS_NO_RESULTS');
  assert.deepEqual(result.metrics, {
    found: 0, processed: 0, newPublications: 0, existingPublications: 0,
    newVersions: 0, itemErrors: 0, connectorPartialFailures: 0,
  });
  assert.equal(spool.spools[0]!.count, 0);
  assertNoPublicationPersistence(database.queries);
  database.assertDone();
});

for (const code of ['PUBLICATION_SPOOL_READ_FAILED', 'PUBLICATION_SPOOL_CORRUPT']) {
  test(`${code} after successful collect closes the run as PROCESSING_FAILED and disposes`, async t => {
    const events: string[] = [];
    const spool = observeSpools(t, events);
    const database = scriptedDatabase(t, [
      ...startAttempt(), ...finishSuccessfulAttempt(1),
      finishRun('PROCESSING_FAILED', query => assert.equal(updateValue(query, 'error_summary'), code)),
    ], events);
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(PublicationSpool.prototype, Symbol.asyncIterator)!;
    const iterator = t.mock.fn(async function* () {
      assert.ok(events.includes('db:finish-attempt'), 'replay happens only after collect and attempt completion');
      throw new ConnectorError('Injected spool replay failure.', { code, kind: 'PROCESSING_ERROR', retryable: false });
    });
    // Node 24.19's mock.method restoration mishandles symbol-keyed methods;
    // restore the descriptor ourselves while still tracking the fake call.
    Object.defineProperty(PublicationSpool.prototype, Symbol.asyncIterator, { ...iteratorDescriptor, value: iterator });
    t.after(() => Object.defineProperty(PublicationSpool.prototype, Symbol.asyncIterator, iteratorDescriptor));
    const result = await processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
      await emit(publication);
      return { publications: [], metadata: { douArchives: receipts } };
    }), run, engineOptions);

    assert.equal(result.state, 'TERMINAL');
    assert.equal(result.status, 'PROCESSING_FAILED', 'successful attempt receipts remain ineligible without a successful run');
    assert.equal(result.metrics.found, 1);
    assert.equal(result.metrics.processed, 0);
    assert.equal(result.metrics.itemErrors, 0, 'spool corruption is a run-level failure, not a publication error');
    assert.equal(iterator.mock.callCount(), 1);
    spool.assertDisposed();
    assertNoPublicationPersistence(database.queries);
    database.assertDone();
  });
}

test('attempt-finish database error propagates while the sealed spool is disposed', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const failure = new Error('Injected attempt update failure.');
  const attemptFinish = finishSuccessfulAttempt(1);
  attemptFinish.find(step => step.name === 'finish-attempt')!.error = failure;
  const database = scriptedDatabase(t, [...startAttempt(), ...attemptFinish], events);
  await assert.rejects(processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
    await emit(publication);
    return { publications: [], metadata: { douArchives: receipts } };
  }), run, engineOptions), error => error === failure);

  assert.ok(events.indexOf('sealed') < events.indexOf('db:finish-attempt'));
  assert.ok(events.indexOf('db:finish-attempt') < events.indexOf('disposed'));
  assert.equal(events.includes('db:finish-run'), false, 'an uncommitted attempt is never promoted to a successful run');
  spool.assertDisposed();
  assertNoPublicationPersistence(database.queries);
  database.assertDone();
});

for (const ownership of ['run transferred', 'attempt recovered'] as const) {
  test(`buffered legacy publications are not persisted or checkpointed when ${ownership}`, async t => {
    const events: string[] = [];
    const database = scriptedDatabase(t, [
      ...startAttempt(),
      lockRunForAttemptFinish(ownership !== 'run transferred'),
      ...(ownership === 'attempt recovered' ? [lockAttemptForFinish(false)] : []),
    ], events);
    const buffered = [publication];
    const iterator = t.mock.fn(function* () { assert.fail('lost ownership must prevent buffered publication processing'); });
    Object.defineProperty(buffered, Symbol.iterator, { value: iterator });
    const createSpool = t.mock.method(PublicationSpool, 'create', async () => {
      assert.fail('legacy collection must remain on its buffered path');
    });
    const collect = t.mock.fn(async () => ({
      publications: buffered,
      metadata: { douArchives: receipts },
      checkpoint: { version: 1, state: { completedDate: '2026-09-18', archives: receipts } },
    }));
    const legacyRegistry = new ConnectorRegistry();
    legacyRegistry.register({ key: run.connectorKey, version: 'legacy-memory-test', collect });

    await assert.rejects(processAcquiredCollectionRun(database.db, legacyRegistry, run, engineOptions), error => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'COLLECTION_RUN_OWNERSHIP_LOST');
      assert.equal(error.kind, 'CANCELLED');
      return true;
    });

    assert.equal(collect.mock.callCount(), 1);
    assert.equal(createSpool.mock.callCount(), 0);
    assert.equal(iterator.mock.callCount(), 0);
    assert.equal(database.queries.some(query => /^update /.test(query.sql)), false, 'no attempt/run mutation after loss');
    assertNoPublicationPersistence(database.queries);
    database.assertDone();
  });

  test(`sealed spool is discarded without replay or checkpoint promotion when ${ownership}`, async t => {
    const events: string[] = [];
    const spool = observeSpools(t, events);
    const database = scriptedDatabase(t, [
      ...startAttempt(),
      lockRunForAttemptFinish(ownership !== 'run transferred'),
      ...(ownership === 'attempt recovered' ? [lockAttemptForFinish(false)] : []),
    ], events);
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(PublicationSpool.prototype, Symbol.asyncIterator)!;
    const iterator = t.mock.fn(async function* () { assert.fail('lost ownership must prevent replay'); });
    Object.defineProperty(PublicationSpool.prototype, Symbol.asyncIterator, { ...iteratorDescriptor, value: iterator });
    t.after(() => Object.defineProperty(PublicationSpool.prototype, Symbol.asyncIterator, iteratorDescriptor));

    await assert.rejects(processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
      await emit(publication);
      return {
        publications: [], metadata: { douArchives: receipts },
        checkpoint: { version: 1, state: { completedDate: '2026-09-18', archives: receipts } },
      };
    }), run, engineOptions), error => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'COLLECTION_RUN_OWNERSHIP_LOST');
      assert.equal(error.kind, 'CANCELLED');
      return true;
    });

    assert.equal(spool.spools[0]!.count, 1);
    assert.ok(events.indexOf('sealed') < events.indexOf('db:finish-owned-run'));
    assert.ok(events.indexOf('db:finish-owned-run') < events.indexOf('disposed'));
    assert.equal(iterator.mock.callCount(), 0);
    assert.equal(database.queries.some(query => /^update /.test(query.sql)), false, 'no attempt/run mutation after loss');
    assertNoPublicationPersistence(database.queries);
    spool.assertDisposed();
    database.assertDone();
  });
}

for (const retryable of [false, true]) {
  test(`failed collection cannot ${retryable ? 'reschedule' : 'finish'} a run after ownership was lost`, async t => {
    const events: string[] = [];
    const spool = observeSpools(t, events);
    const database = scriptedDatabase(t, [
      ...startAttempt(), lockRunForAttemptFinish(false),
    ], events);
    await assert.rejects(processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
      await emit(publication);
      throw new ConnectorError('Fixture collection failure.', {
        code: 'FIXTURE_COLLECTION_FAILURE', kind: 'PROCESSING_ERROR', retryable,
      });
    }), run, engineOptions), error => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'COLLECTION_RUN_OWNERSHIP_LOST');
      assert.equal(error.kind, 'CANCELLED');
      return true;
    });

    assert.equal(events.includes('sealed'), false);
    assert.ok(events.indexOf('disposed') < events.indexOf('db:finish-owned-run'));
    assert.equal(database.queries.some(query => /^update /.test(query.sql)), false, 'no attempt completion, retry scheduling or run finalization');
    assertNoPublicationPersistence(database.queries);
    spool.assertDisposed();
    database.assertDone();
  });
}

test('invalid replayed publication retains item-error accounting and PROCESSING_FAILED terminal status', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const database = scriptedDatabase(t, [
    ...startAttempt(), ...finishSuccessfulAttempt(1),
    {
      name: 'item-failure', sql: /^insert into "collection_items" /,
      inspect(query) {
        assert.ok(query.parameters.includes('fixture-1'));
        assert.ok(query.parameters.includes('FAILED'));
        assert.ok(query.parameters.includes('PUBLICATION_PROCESSING_ERROR'));
      },
    },
    finishRun('PROCESSING_FAILED', () => spool.assertDisposed()),
  ], events);
  const result = await processAcquiredCollectionRun(database.db, registry(async (_context, emit) => {
    // Structurally serializable but rejected by the publication normalizer.
    await emit({ ...publication, title: '   ' });
    return { publications: [], metadata: { douArchives: receipts } };
  }), run, engineOptions);

  assert.equal(result.status, 'PROCESSING_FAILED');
  assert.equal(result.metrics.found, 1);
  assert.equal(result.metrics.processed, 0);
  assert.equal(result.metrics.itemErrors, 1);
  assert.equal(result.metrics.connectorPartialFailures, 0);
  assert.ok(events.indexOf('db:finish-attempt') < events.indexOf('db:item-failure'));
  assert.ok(events.indexOf('db:item-failure') < events.indexOf('disposed'));
  assertNoPublicationPersistence(database.queries, true);
  database.assertDone();
});
