import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler,
  type CompiledQuery, type QueryResult,
} from 'kysely';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, type AcquiredCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun, type CollectionEngineMetrics } from '../src/modules/collection/collection.engine.js';
import type { CollectionConnector, ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { PublicationSpool } from '../src/modules/collection/publication-spool.js';

const run: AcquiredCollectionRun = {
  id: 'policy-run', sourceId: 'policy-source', sourceCode: 'dou', connectorKey: 'dou',
  maxAttempts: 1, correlationId: 'policy-correlation', workerId: 'policy-worker',
};
const attemptId = 'policy-attempt';
const administrativeNotice: ConnectorPublication = {
  title: 'AVISO DE DISPENSA DE LICITAÇÃO',
  sphere: 'FEDERAL',
  actType: 'AVISO DE DISPENSA DE LICITAÇÃO',
  officialUrl: 'https://example.invalid/policy/administrative-notice',
  externalId: 'policy-administrative-notice',
  content: 'Objeto: aquisição de papel A4. Modalidade: dispensa de licitação. Processo: 123. Valor: R$ 100.',
  metadata: { dou: { section: 'DO3', sourceActType: 'AVISO DE DISPENSA DE LICITAÇÃO',
    parts: [{ attributes: { artType: 'AVISO DE DISPENSA DE LICITAÇÃO', pubName: 'DO3' } }],
    scopeStructureIncomplete: false, abstract: '', continuationTitles: [], continuationAbstracts: [] } },
};
const retainedPublication: ConnectorPublication = {
  title: 'Portaria sobre crédito de ICMS',
  sphere: 'FEDERAL',
  actType: 'PORTARIA',
  officialUrl: 'https://example.invalid/policy/retained-act',
  externalId: 'policy-retained-act',
  content: 'Disciplina a apuração de crédito tributário de ICMS.',
};
const receipts = { '2026-09-18-DO3.zip': 'b'.repeat(64) };
const options = { timeoutMs: 10_000, heartbeatIntervalMs: 0 };

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
      const step = remaining.shift();
      assert.ok(step, `Unexpected query: ${query.sql}`);
      assert.match(query.sql, step.sql, `Expected ${step.name}`);
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

function ownedRun(name: string, owned = true): QueryStep {
  return {
    name, sql: /^select .* from "collection_runs" .*for update$/,
    rows: owned ? [{ id: run.id, status: 'RUNNING', worker_id: run.workerId }] : [],
    inspect(query) {
      assert.ok(query.parameters.includes(run.id));
      if (name !== 'start-owned-run') assert.ok(query.parameters.includes(run.workerId));
    },
  };
}

function startAttempt(): QueryStep[] {
  return [
    ownedRun('start-owned-run'),
    { name: 'last-attempt', sql: /^select "attempt_no" from "collection_attempts"/, rows: [] },
    { name: 'start-attempt', sql: /^insert into "collection_attempts"/, rows: [{ id: attemptId, collection_run_id: run.id, attempt_no: 1 }] },
  ];
}

function finishAttempt(count: number, status = 'SUCCESS'): QueryStep[] {
  return [
    ownedRun('finish-owned-run'),
    { name: 'owned-attempt', sql: /^select "id" from "collection_attempts" .*for update$/, rows: [{ id: attemptId }] },
    {
      name: 'finish-attempt', sql: /^update "collection_attempts" set /, rows: [{ id: attemptId }],
      inspect(query) {
        assert.equal(updateValue(query, 'status'), status);
        if (status !== 'SUCCESS') return;
        const metadata = updateValue(query, 'metadata') as Record<string, unknown>;
        assert.equal(metadata.publicationCount, count, 'attempt retains the raw connector count');
        assert.deepEqual(metadata.douArchives, receipts);
        assert.equal(Object.hasOwn(metadata, 'publicationStream'), false);
      },
    },
  ];
}

interface PolicyAudit {
  policyKey: string;
  policyVersion: string;
  skippedByPolicy: number;
  policyExclusions: CollectionEngineMetrics['policyExclusions'];
}

function recordPolicy(count: number, onAudit: (audit: PolicyAudit) => void, before?: () => void): QueryStep[] {
  return [
    { ...ownedRun('policy-owned-run'), inspect(query) {
      before?.();
      assert.ok(query.parameters.includes(run.id));
      assert.ok(query.parameters.includes('RUNNING'));
      assert.ok(query.parameters.includes(run.workerId));
    } },
    {
      name: 'policy-audit', sql: /^update "collection_attempts" set /, rows: [{ id: attemptId }],
      inspect(query) {
        assert.match(query.sql, /coalesce\(metadata, '\{\}'::jsonb\) \|\|/);
        assert.ok(query.parameters.includes(attemptId));
        assert.ok(query.parameters.includes(run.id));
        assert.ok(query.parameters.includes('SUCCESS'));
        const payload = query.parameters.find(value => typeof value === 'string' && value.includes('"publicationExclusionPolicy"'));
        assert.equal(typeof payload, 'string');
        const { publicationExclusionPolicy: audit } = JSON.parse(payload as string) as { publicationExclusionPolicy: PolicyAudit };
        assert.equal(audit.skippedByPolicy, count);
        assert.ok(audit.policyKey.length > 0);
        assert.ok(audit.policyVersion.length > 0);
        assert.equal(audit.policyExclusions.reduce((total, entry) => total + entry.count, 0), count);
        assert.equal(audit.policyExclusions.length, 1, 'same rule/type is aggregated, not one entry per item');
        const entry = audit.policyExclusions[0]!;
        assert.equal(entry.sourceCode, 'dou');
        assert.ok(entry.normalizedActType.length > 0);
        assert.ok(entry.ruleId);
        assert.equal(entry.policyKey, audit.policyKey);
        assert.equal(entry.policyVersion, audit.policyVersion);
        assert.equal(JSON.stringify(audit).includes(administrativeNotice.content!), false, 'audit must not copy full publication content');
        onAudit(audit);
      },
    },
  ];
}

function finishRun(status: string, inspect?: () => void): QueryStep {
  return {
    name: 'finish-run', sql: /^update "collection_runs" set /, rows: [{ id: run.id }],
    inspect(query) { assert.equal(updateValue(query, 'status'), status); inspect?.(); },
  };
}

function registry(publications: ConnectorPublication[], mode: 'buffered' | 'spool', partial = false): ConnectorRegistry {
  const result = () => ({
    publications: [], metadata: { douArchives: receipts },
    ...(partial ? { partialFailures: [{ code: 'FIXTURE_PARTIAL', message: 'One source page failed' }] } : {}),
  });
  const connector: CollectionConnector = {
    key: run.connectorKey, version: 'policy-test',
    async collect() {
      assert.equal(mode, 'buffered', 'incremental connector must not use array fallback');
      return { ...result(), publications };
    },
    ...(mode === 'spool' ? {
      async collectIncremental(_context, emit) {
        for (const publication of publications) await emit(publication);
        return result();
      },
    } satisfies Pick<CollectionConnector, 'collectIncremental'> : {}),
  };
  const connectors = new ConnectorRegistry();
  connectors.register(connector);
  return connectors;
}

function observeSpools(t: TestContext, events: string[]) {
  const create = PublicationSpool.create;
  const dispose = PublicationSpool.prototype.dispose;
  const spools: PublicationSpool[] = [];
  const disposed = new Set<PublicationSpool>();
  t.mock.method(PublicationSpool, 'create', async (signal?: AbortSignal) => {
    const spool = await create(signal);
    spools.push(spool);
    return spool;
  });
  t.mock.method(PublicationSpool.prototype, 'dispose', async function (this: PublicationSpool) {
    await dispose.call(this);
    disposed.add(this);
    events.push('disposed');
  });
  t.after(async () => { for (const spool of spools) await dispose.call(spool); });
  return {
    spools,
    assertDisposed() {
      assert.equal(spools.length, 1);
      assert.ok(disposed.has(spools[0]!), 'real spool disposal completes before audit and terminal success');
    },
  };
}

function assertNoCanonicalOrItemQueries(queries: CompiledQuery[]): void {
  // Deliberately separate canonical/item persistence from checkpoint/run bookkeeping.
  const forbidden = /"(?:publications|publication_[^"]*|collection_items|collection_run_publications)"/;
  assert.deepEqual(queries.filter(query => forbidden.test(query.sql)).map(query => query.sql), []);
}

function assertSkippedMetrics(metrics: CollectionEngineMetrics, count: number): void {
  assert.equal(metrics.found, count);
  assert.equal(metrics.processed, 0);
  assert.equal(metrics.skippedByPolicy, count);
  assert.equal(metrics.newPublications, 0);
  assert.equal(metrics.existingPublications, 0);
  assert.equal(metrics.newVersions, 0);
  assert.equal(metrics.itemErrors, 0);
}

function newPublicationPersistence(publication: ConnectorPublication): QueryStep[] {
  return [
    { name: 'discover-retained-item', sql: /^insert into "collection_items" /, inspect(query) {
      assert.ok(query.parameters.includes(publication.externalId!));
      assert.ok(query.parameters.includes('DISCOVERED'));
      assert.equal(query.parameters.includes(administrativeNotice.externalId), publication.externalId === administrativeNotice.externalId);
    } },
    { name: 'new-publication', sql: /^insert into "publications" /, rows: [{ id: 'retained-publication' }] },
    { name: 'external-origin', sql: /^select .* from "publication_origins" /, rows: [] },
    { name: 'url-origin', sql: /^select .* from "publication_origins" /, rows: [] },
    { name: 'new-origin', sql: /^insert into "publication_origins" / },
    { name: 'current-version', sql: /^select .* from "publication_versions" /, rows: [] },
    { name: 'matching-version', sql: /^select .* from "publication_versions" /, rows: [] },
    { name: 'latest-version', sql: /^select "version_no" from "publication_versions" /, rows: [] },
    { name: 'unset-current', sql: /^update "publication_versions" set / },
    { name: 'new-version', sql: /^insert into "publication_versions" /, rows: [{ id: 'retained-version' }] },
    { name: 'canonical-presentation', sql: /^update "publications" set / },
    { name: 'run-publication-link', sql: /^insert into "collection_run_publications" / },
    { name: 'complete-retained-item', sql: /^update "collection_items" set / },
  ];
}

for (const mode of ['buffered', 'spool'] as const) {
  test(`exclusion gate: all skipped ${mode} publications write only the bounded policy audit`, async t => {
    const events: string[] = [];
    const spool = mode === 'spool' ? observeSpools(t, events) : undefined;
    let audit: PolicyAudit | undefined;
    const notices = [administrativeNotice, { ...administrativeNotice, actType: '  AVISO   DE DISPENSA   DE LICITAÇÃO  ' }];
    const database = scriptedDatabase(t, [
      ...startAttempt(), ...finishAttempt(notices.length),
      ...recordPolicy(notices.length, value => { audit = value; }, () => spool?.assertDisposed()),
      finishRun('SUCCESS', () => {
        spool?.assertDisposed();
        assert.ok(events.indexOf('db:policy-audit') < events.indexOf('db:finish-run'));
      }),
    ], events);
    const logs: Record<string, unknown>[] = [];
    const result = await processAcquiredCollectionRun(database.db, registry(notices, mode), run, {
      ...options, logger: { info: data => { logs.push(data); }, warn() {}, error() {} },
    });
    assert.equal(result.status, 'SUCCESS', 'found-but-excluded is not source-empty or a processing failure');
    assertSkippedMetrics(result.metrics, notices.length);
    assert.ok(audit);
    assert.deepEqual(result.metrics.policyExclusions, audit.policyExclusions);
    assert.ok(logs.some(log => log.skippedByPolicy === notices.length));
    if (spool) assert.equal(spool.spools[0]!.count, notices.length);
    assertNoCanonicalOrItemQueries(database.queries);
    database.assertDone();
  });
}

test('exclusion gate: mixed spool persists only the retained publication and accounts for one normalization error', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const malformed = { ...administrativeNotice, externalId: 'malformed-policy-item', title: '   ' };
  const database = scriptedDatabase(t, [
    ...startAttempt(), ...finishAttempt(3), ...newPublicationPersistence(retainedPublication),
    { name: 'normalization-error', sql: /^insert into "collection_items" /, inspect(query) {
      assert.ok(query.parameters.includes(malformed.externalId));
      assert.ok(query.parameters.includes('FAILED'));
      assert.ok(query.parameters.includes('PUBLICATION_PROCESSING_ERROR'));
    } },
    ...recordPolicy(1, () => undefined, () => spool.assertDisposed()),
    finishRun('PARTIAL_SUCCESS'),
  ], events);
  const result = await processAcquiredCollectionRun(database.db,
    registry([administrativeNotice, retainedPublication, malformed], 'spool'), run, options);
  assert.equal(result.status, 'PARTIAL_SUCCESS');
  assert.equal(result.metrics.found, 3);
  assert.equal(result.metrics.processed, 1);
  assert.equal(result.metrics.newPublications, 1);
  assert.equal(result.metrics.skippedByPolicy, 1);
  assert.equal(result.metrics.itemErrors, 1, 'normalization runs before the policy, even for a blocked-looking type');
  assert.equal(database.queries.filter(query => /^insert into "publications" /.test(query.sql)).length, 1);
  assert.equal(database.queries.filter(query => /^insert into "collection_run_publications" /.test(query.sql)).length, 1);
  spool.assertDisposed();
  database.assertDone();
});

for (const sourceCode of ['confaz', 'alias-dou', 'unrecognized-source', undefined] as const) {
  test(`exclusion gate: source ${sourceCode ?? '(absent)'} fails open despite the DOU connector key and act type`, async t => {
    const events: string[] = [];
    const { sourceCode: _sourceCode, ...withoutSourceCode } = run;
    const differentRun: AcquiredCollectionRun = sourceCode === undefined
      ? withoutSourceCode : { ...withoutSourceCode, sourceCode };
    const database = scriptedDatabase(t, [
      ...startAttempt(), ...finishAttempt(1), ...newPublicationPersistence(administrativeNotice), finishRun('SUCCESS'),
    ], events);
    const result = await processAcquiredCollectionRun(database.db,
      registry([administrativeNotice], 'buffered'), differentRun, options);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.metrics.processed, 1);
    assert.equal(result.metrics.newPublications, 1);
    assert.equal(result.metrics.skippedByPolicy, 0);
    assert.deepEqual(result.metrics.policyExclusions, []);
    assert.equal(events.includes('db:policy-audit'), false);
    database.assertDone();
  });
}

test('exclusion gate: acquisition projects source code independently of the connector key', async t => {
  const events: string[] = [];
  const database = scriptedDatabase(t, [
    {
      name: 'acquire-source', sql: /^\s*SELECT/,
      rows: [{
        id: run.id, source_id: run.sourceId, source_code: 'alias-dou', connector_key: 'dou',
        max_attempts: 1, correlation_id: run.correlationId, was_stale: false,
      }],
      inspect(query) {
        assert.match(query.sql, /s\.code AS source_code/);
        assert.match(query.sql, /s\.connector_key/);
      },
    },
    {
      name: 'acquire-run', sql: /^update "collection_runs" set /,
      rows: [{ id: run.id, source_id: run.sourceId, correlation_id: run.correlationId, worker_id: run.workerId }],
    },
  ], events);
  const acquired = await acquireNextCollectionRun(database.db, run.workerId);
  assert.ok(acquired);
  assert.equal(acquired.sourceCode, 'alias-dou');
  assert.equal(acquired.connectorKey, 'dou');
  assertNoCanonicalOrItemQueries(database.queries);
  database.assertDone();
});

test('exclusion gate: repeated collection of excluded notices has no canonical/item side effects or accumulated counters', async t => {
  const events: string[] = [];
  const oneExecution = () => [
    ...startAttempt(), ...finishAttempt(1), ...recordPolicy(1, () => undefined), finishRun('SUCCESS'),
  ];
  const database = scriptedDatabase(t, [...oneExecution(), ...oneExecution()], events);
  for (let index = 0; index < 2; index += 1) {
    const result = await processAcquiredCollectionRun(database.db, registry([administrativeNotice], 'buffered'), run, options);
    assertSkippedMetrics(result.metrics, 1);
  }
  assert.equal(events.filter(event => event === 'db:policy-audit').length, 2);
  assertNoCanonicalOrItemQueries(database.queries);
  database.assertDone();
});

test('exclusion gate: all excluded with a connector partial failure remains PARTIAL_SUCCESS', async t => {
  const events: string[] = [];
  const database = scriptedDatabase(t, [
    ...startAttempt(), ...finishAttempt(1), ...recordPolicy(1, () => undefined), finishRun('PARTIAL_SUCCESS'),
  ], events);
  const result = await processAcquiredCollectionRun(database.db,
    registry([administrativeNotice], 'buffered', true), run, options);
  assert.equal(result.status, 'PARTIAL_SUCCESS');
  assertSkippedMetrics(result.metrics, 1);
  assert.equal(result.metrics.connectorPartialFailures, 1);
  assertNoCanonicalOrItemQueries(database.queries);
  database.assertDone();
});

test('exclusion gate: retryable collection failure does not replay, audit or persist a staged excluded notice', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const database = scriptedDatabase(t, [
    ...startAttempt(), ...finishAttempt(0, 'SOURCE_UNAVAILABLE'),
    { name: 'schedule-retry', sql: /^update "collection_runs" set /, rows: [{ id: run.id }], inspect(query) {
      assert.equal(updateValue(query, 'status'), 'RUNNING');
      assert.equal(updateValue(query, 'worker_id'), null);
      assert.ok(updateValue(query, 'next_attempt_at') instanceof Date);
    } },
  ], events);
  const connectors = new ConnectorRegistry();
  connectors.register({
    key: run.connectorKey, version: 'policy-retry-test',
    async collect() { throw new Error('must use incremental collection'); },
    async collectIncremental(_context, emit) {
      await emit(administrativeNotice);
      throw new ConnectorError('Temporary source failure', { code: 'POLICY_FIXTURE_RETRY', kind: 'SOURCE_UNAVAILABLE', retryable: true });
    },
  });
  const result = await processAcquiredCollectionRun(database.db, connectors, run, options);
  assert.equal(result.state, 'RETRY_SCHEDULED');
  assert.equal(result.metrics.skippedByPolicy, 0, 'staged, uncommitted connector output is not evaluated');
  assert.deepEqual(result.metrics.policyExclusions, []);
  assertNoCanonicalOrItemQueries(database.queries);
  spool.assertDisposed();
  database.assertDone();
});

test('exclusion gate: policy audit failure never commits a successful run and still disposes the spool', async t => {
  const events: string[] = [];
  const spool = observeSpools(t, events);
  const auditFailure = new Error('Injected policy audit write failure');
  const auditSteps = recordPolicy(1, () => undefined, () => spool.assertDisposed());
  auditSteps[1]!.error = auditFailure;
  const database = scriptedDatabase(t, [...startAttempt(), ...finishAttempt(1), ...auditSteps], events);
  await assert.rejects(
    processAcquiredCollectionRun(database.db, registry([administrativeNotice], 'spool'), run, options),
    error => error === auditFailure,
  );
  assert.equal(events.includes('db:finish-run'), false);
  assertNoCanonicalOrItemQueries(database.queries);
  spool.assertDisposed();
  database.assertDone();
});

for (const lostOwnership of ['run', 'attempt'] as const) {
  test(`exclusion gate: lost ${lostOwnership} ownership at policy audit never finalizes SUCCESS`, async t => {
    const events: string[] = [];
    const spool = observeSpools(t, events);
    const auditSteps = lostOwnership === 'run'
      ? [{ ...ownedRun('policy-owned-run', false), inspect: () => spool.assertDisposed() }]
      : recordPolicy(1, () => undefined, () => spool.assertDisposed());
    if (lostOwnership === 'attempt') auditSteps[1]!.rows = [];
    const database = scriptedDatabase(t, [...startAttempt(), ...finishAttempt(1), ...auditSteps], events);
    await assert.rejects(
      processAcquiredCollectionRun(database.db, registry([administrativeNotice], 'spool'), run, options),
      error => error instanceof ConnectorError && error.code === 'COLLECTION_RUN_OWNERSHIP_LOST',
    );
    assert.equal(events.includes('db:finish-run'), false);
    if (lostOwnership === 'run') assert.equal(events.includes('db:policy-audit'), false);
    assertNoCanonicalOrItemQueries(database.queries);
    spool.assertDisposed();
    database.assertDone();
  });
}
