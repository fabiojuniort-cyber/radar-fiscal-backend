import assert from 'node:assert/strict';
import test from 'node:test';

import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type QueryResult } from 'kysely';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { DOU_BACKFILL_SECTIONS, assertDouBackfillAvailable, douBackfillBatches, isDouBackfillCoverageComplete, planDouBackfillDates, readDouBackfillCoverage, runDouBackfillTick } from '../src/modules/collection/dou-backfill.js';
import { DOU_XML_SECTIONS, DouConnector } from '../src/modules/collection/dou.connector.js';

test('plan walks back one day at a time, skipping covered dates and the monitoring window', () => {
  const dates = planDouBackfillDates({
    from: '2026-09-10',
    to: '2026-10-04',
    today: '2026-10-04',
    covered: new Set(['2026-09-30', '2026-09-29', '2026-09-15', '2026-09-11']),
  });
  assert.equal(dates[0], '2026-10-01', 'today, today-1 and today-2 belong to monitoring');
  assert.deepEqual(dates.slice(0, 4), ['2026-10-01', '2026-09-28', '2026-09-27', '2026-09-26']);
  assert.equal(dates.includes('2026-09-15'), false);
  assert.equal(dates.at(-1), '2026-09-10');
  assert.equal(dates.length, 22 - 4);
});

test('plan is empty when everything is covered or the range is inside the monitoring window', () => {
  assert.deepEqual(planDouBackfillDates({ from: '2026-10-02', to: '2026-10-04', today: '2026-10-04', covered: new Set() }), []);
  assert.deepEqual(planDouBackfillDates({ from: '2026-09-30', to: '2026-10-01', today: '2026-10-04', covered: new Set(['2026-09-30', '2026-10-01']) }), []);
  assert.throws(() => planDouBackfillDates({ from: '2026-02-30', to: '2026-10-01', today: '2026-10-04', covered: new Set() }), RangeError);
});

test('batches never exceed the connector limit of four dates', () => {
  const dates = ['2026-09-09', '2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05', '2026-09-04'];
  assert.deepEqual(douBackfillBatches(dates), [dates.slice(0, 4), dates.slice(4)]);
  assert.throws(() => douBackfillBatches(dates, 5), RangeError);
});


test('backfill coverage uses exactly the same four-section policy as collection', () => {
  assert.strictEqual(DOU_BACKFILL_SECTIONS, DOU_XML_SECTIONS);
  assert.deepEqual(DOU_BACKFILL_SECTIONS, ['DO1', 'DO1E', 'DO3', 'DO3E']);
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO3', 'DO3E'])), true);
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO3'])), false, 'a real enabled-section gap stays incomplete');
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO2', 'DO2E'])), false, 'historical excluded sections never prove coverage');
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO2', 'DO2E', 'DO3', 'DO3E'])), true, 'six-section historical evidence stays compatible');
});

test('anti-loop planning does not requeue a date once the four enabled sections are proven', () => {
  const date = '2026-09-18';
  const consulted = new Set<string>(['DO1', 'DO1E', 'DO3', 'DO3E']);
  const covered = isDouBackfillCoverageComplete(consulted) ? new Set([date]) : new Set<string>();
  for (let pass = 0; pass < 3; pass += 1) {
    assert.deepEqual(planDouBackfillDates({ from: date, to: date, today: '2026-10-04', covered }), []);
  }
});

type QueryStep = { sql: RegExp; rows: unknown[] };

function scriptedDatabase(steps: QueryStep[]) {
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
      return { rows: step.rows as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
  });
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries, assertDone: () => assert.equal(remaining.length, 0, 'all expected queries executed') };
}

const tickSource = {
  id: 'dou-source', is_active: true, connector_key: 'dou', schedule_cron: null,
  schedule_timezone: 'America/Sao_Paulo', max_attempts: 1,
};
const tickOptions = {
  from: '2026-10-01', workerId: 'backfill-precheck-test',
  credentials: () => ({ email: 'test@example.invalid', password: 'fixture' }),
  now: () => new Date('2026-10-04T15:00:00Z'),
  isCronDue: () => false,
};
const sourceQuery = /from "sources"/;
const openRunQuery = /select "id", "status", "trigger_type" from "collection_runs".*limit \$\d+$/;
const lastRunQuery = /select "created_at" from "collection_runs".*order by "created_at" desc limit \$\d+$/;
const coverageQuery = /from "collection_attempts" as "ca"/;
const recentBackfillQuery = /select "status", .*as "has_failed_items" from "collection_runs".*"finished_at" is not null/;

test('busy backfill ticks skip archive history for either open status', async () => {
  for (const status of ['PENDING', 'RUNNING']) {
    const { db, queries, assertDone } = scriptedDatabase([
      { sql: sourceQuery, rows: [tickSource] },
      { sql: openRunQuery, rows: [{ id: 'open-run', status, trigger_type: 'SCHEDULED' }] },
    ]);
    try {
      assert.deepEqual(await runDouBackfillTick(db, tickOptions), { state: 'SKIPPED', reason: 'SOURCE_BUSY' });
      assertDone();
      assert.deepEqual(queries[1]!.parameters, ['dou-source', 'PENDING', 'RUNNING', 1]);
    } finally {
      await db.destroy();
    }
  }
});

test('hourly throttle is checked with a one-row query before archive history', async () => {
  const { db, queries, assertDone } = scriptedDatabase([
    { sql: sourceQuery, rows: [tickSource] },
    { sql: openRunQuery, rows: [] },
    { sql: lastRunQuery, rows: [{ created_at: new Date() }] },
  ]);
  try {
    assert.deepEqual(await runDouBackfillTick(db, tickOptions), { state: 'SKIPPED', reason: 'THROTTLED' });
    assertDone();
    assert.deepEqual(queries[2]!.parameters, ['dou-source', 'BACKFILL', 1]);
  } finally {
    await db.destroy();
  }
});

test('precheck preserves disabled intervals and accepts expired intervals', async () => {
  for (const minIntervalMs of [0, 3_600_000]) {
    const { db, assertDone } = scriptedDatabase([
      { sql: openRunQuery, rows: [] },
      ...(minIntervalMs > 0 ? [{ sql: lastRunQuery, rows: [{ created_at: new Date(Date.now() - 7_200_000) }] }] : []),
    ]);
    try {
      await assertDouBackfillAvailable(db, tickSource.id, minIntervalMs);
      assertDone();
    } finally {
      await db.destroy();
    }
  }
});

test('inactive sources and imminent monitoring retain priority over backfill prechecks', async () => {
  for (const scheduled of [false, true]) {
    const { db, assertDone } = scriptedDatabase([
      { sql: sourceQuery, rows: [{ ...tickSource, is_active: scheduled, schedule_cron: scheduled ? '* * * * *' : null }] },
    ]);
    try {
      assert.deepEqual(await runDouBackfillTick(db, { ...tickOptions, isCronDue: () => true }), {
        state: 'SKIPPED', reason: scheduled ? 'SCHEDULED_CYCLE_DUE' : 'SOURCE_INACTIVE',
      });
      assertDone();
    } finally {
      await db.destroy();
    }
  }
});

test('eligible ticks still load coverage and report completion', async () => {
  const { db, assertDone } = scriptedDatabase([
    { sql: sourceQuery, rows: [tickSource] },
    { sql: openRunQuery, rows: [] },
    { sql: lastRunQuery, rows: [] },
    { sql: coverageQuery, rows: [] },
    { sql: coverageQuery, rows: [{ archives: DOU_BACKFILL_SECTIONS.map((section) => ({ date: '2026-10-01', section, state: 'NOT_AVAILABLE' })) }] },
  ]);
  try {
    assert.deepEqual(await runDouBackfillTick(db, tickOptions), { state: 'COMPLETE' });
    assertDone();
  } finally {
    await db.destroy();
  }
});

test('passing read-only prechecks cannot bypass the locked open-run or interval recheck', async () => {
  for (const busy of [true, false]) {
    const { db, queries, assertDone } = scriptedDatabase([
      { sql: sourceQuery, rows: [tickSource] },
      { sql: openRunQuery, rows: [] },
      { sql: lastRunQuery, rows: [] },
      { sql: coverageQuery, rows: [] },
      { sql: coverageQuery, rows: [] },
      { sql: recentBackfillQuery, rows: [] },
      { sql: /^LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE$/, rows: [] },
      { sql: sourceQuery, rows: [tickSource] },
      { sql: openRunQuery, rows: busy ? [{ id: 'concurrent-run', status: 'RUNNING', trigger_type: 'BACKFILL' }] : [] },
      ...(!busy ? [{ sql: lastRunQuery, rows: [{ created_at: new Date() }] }] : []),
    ]);
    try {
      assert.deepEqual(await runDouBackfillTick(db, tickOptions), {
        state: 'SKIPPED', reason: busy ? 'SOURCE_BUSY' : 'THROTTLED',
      });
      assertDone();
      assert.equal(queries.filter((query) => openRunQuery.test(query.sql)).length, 2);
      assert.equal(queries.some((query) => /insert into/.test(query.sql)), false, 'no run is created after a competing run wins');
    } finally {
      await db.destroy();
    }
  }
});

test('backfill coverage excludes runs with failed publications using persisted item status, not archive metadata', async () => {
  const { db, queries, assertDone } = scriptedDatabase([
    { sql: coverageQuery, rows: [] },
    { sql: coverageQuery, rows: [] },
  ]);
  try {
    const coverage = await readDouBackfillCoverage(db, 'dou-source');
    const backfills = queries[1]!;
    assert.match(backfills.sql, /not exists \(select "ci"\."id" from "collection_items" as "ci" where "ci"\."collection_run_id" = "cr"\."id" and "ci"\."status" = \$\d+\)/);
    assert.deepEqual(backfills.parameters, ['dou-source', 'BACKFILL', 'SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS', 'SUCCESS', 'FAILED']);
    assert.deepEqual(coverage, { receipts: {}, covered: new Set() }, 'excluded runs supply neither coverage nor unchanged-package hashes');
    assertDone();
  } finally {
    await db.destroy();
  }
});

test('parser-partial backfills without failed publication items still cover consulted dates and retain safe parsed receipts', async () => {
  const date = '2026-09-18';
  const hash = 'b'.repeat(64);
  const { db, queries, assertDone } = scriptedDatabase([
    { sql: coverageQuery, rows: [] },
    { sql: coverageQuery, rows: [{ archives: DOU_BACKFILL_SECTIONS.map(section => ({
      date, section, filename: `${date}-${section}.zip`, rawSha256: hash,
      state: section === 'DO1' ? 'PARTIAL' : 'PARSED',
    })) }] },
  ]);
  try {
    const coverage = await readDouBackfillCoverage(db, 'dou-source');
    assert.ok(queries[1]!.parameters.includes('PARTIAL_SUCCESS'), 'parser partial success remains eligible');
    assert.deepEqual(coverage.covered, new Set([date]));
    assert.equal(coverage.receipts[`${date}-DO1.zip`], undefined, 'partial archive hashes still do not skip a replay');
    assert.equal(coverage.receipts[`${date}-DO3.zip`], hash);
    assert.deepEqual(planDouBackfillDates({ from: date, to: date, today: '2026-10-04', covered: coverage.covered }), []);
    assertDone();
  } finally {
    await db.destroy();
  }
});

type RecentBackfillRun = { status: string; has_failed_items: boolean };

function tickPlanningSteps(recentRuns: RecentBackfillRun[]): QueryStep[] {
  return [
    { sql: sourceQuery, rows: [tickSource] },
    { sql: openRunQuery, rows: [] },
    { sql: coverageQuery, rows: [] },
    { sql: coverageQuery, rows: [] },
    { sql: recentBackfillQuery, rows: recentRuns },
  ];
}

function successfulEmptyTickSteps(recentRuns: RecentBackfillRun[]): QueryStep[] {
  return [
    ...tickPlanningSteps(recentRuns),
    { sql: /^LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE$/, rows: [] },
    { sql: sourceQuery, rows: [tickSource] },
    { sql: openRunQuery, rows: [] },
    { sql: /^insert into "collection_runs"/, rows: [{ id: 'tick-run', source_id: tickSource.id, correlation_id: 'tick-correlation' }] },
    { sql: /^select .* from "collection_runs" .*for update$/, rows: [{ id: 'tick-run', status: 'RUNNING', worker_id: tickOptions.workerId }] },
    { sql: /^select "attempt_no" from "collection_attempts"/, rows: [] },
    { sql: /^insert into "collection_attempts"/, rows: [{ id: 'tick-attempt', collection_run_id: 'tick-run', attempt_no: 1 }] },
    { sql: /^select "id" from "collection_runs" .*for update$/, rows: [{ id: 'tick-run' }] },
    { sql: /^select "id" from "collection_attempts" .*for update$/, rows: [{ id: 'tick-attempt' }] },
    { sql: /^update "collection_attempts" set /, rows: [{ id: 'tick-attempt' }] },
    { sql: /^update "collection_runs" set /, rows: [{ id: 'tick-run' }] },
  ];
}

test('partial backfills with failed publications count toward the stall threshold instead of resetting it', async () => {
  const { db, queries, assertDone } = scriptedDatabase(tickPlanningSteps([
    { status: 'PARTIAL_SUCCESS', has_failed_items: true },
    { status: 'PARTIAL_SUCCESS', has_failed_items: true },
    { status: 'SUCCESS_NO_RESULTS', has_failed_items: false },
  ]));
  try {
    assert.deepEqual(await runDouBackfillTick(db, { ...tickOptions, minIntervalMs: 0 }), {
      state: 'STALLED', consecutiveFailures: 2, remainingDates: ['2026-10-01'],
    });
    const recent = queries.at(-1)!;
    assert.match(recent.sql, /exists \(select .* from "collection_items"/);
    assert.match(recent.sql, /"collection_run_id" = "collection_runs"\."id"/);
    assert.ok(recent.parameters.includes('FAILED'), 'failure evidence comes from persisted item status');
    assert.equal(queries.some(query => /insert into/.test(query.sql)), false, 'stalled ticks cannot create another run');
    assertDone();
  } finally {
    await db.destroy();
  }
});

test('one partial persistence failure rotates the next tick to the older missing date', async t => {
  const collector = t.mock.method(DouConnector.prototype, 'collectIncremental', async () => ({ publications: [] }));
  const { db, assertDone } = scriptedDatabase(successfulEmptyTickSteps([
    { status: 'PARTIAL_SUCCESS', has_failed_items: true },
    { status: 'SUCCESS_NO_RESULTS', has_failed_items: false },
  ]));
  try {
    const result = await runDouBackfillTick(db, {
      ...tickOptions, from: '2026-09-30', minIntervalMs: 0, heartbeatIntervalMs: 0,
    });
    assert.equal(result.state, 'RAN');
    assert.ok(result.state === 'RAN');
    assert.deepEqual(result.batch.dates, ['2026-09-30'], 'the failing newest date must not hold older dates hostage');
    assert.equal(result.remainingDates, 1);
    assert.equal(result.batch.result.status, 'SUCCESS_NO_RESULTS');
    assert.equal(collector.mock.callCount(), 1);
    assertDone();
  } finally {
    await db.destroy();
  }
});

test('parser-only partial success resets the streak despite older failures and keeps newest-first planning', async t => {
  const collector = t.mock.method(DouConnector.prototype, 'collectIncremental', async () => ({ publications: [] }));
  const { db, assertDone } = scriptedDatabase(successfulEmptyTickSteps([
    { status: 'PARTIAL_SUCCESS', has_failed_items: false },
    ...Array.from({ length: 4 }, () => ({ status: 'PARTIAL_SUCCESS', has_failed_items: true })),
  ]));
  try {
    const result = await runDouBackfillTick(db, {
      ...tickOptions, from: '2026-09-30', minIntervalMs: 0, heartbeatIntervalMs: 0,
    });
    assert.equal(result.state, 'RAN', 'the four older failed runs must not cause STALLED after a parser-only partial success');
    assert.ok(result.state === 'RAN');
    assert.deepEqual(result.batch.dates, ['2026-10-01'], 'a safe partial consultation resets rotation to the newest missing date');
    assert.equal(result.batch.result.status, 'SUCCESS_NO_RESULTS');
    assert.equal(collector.mock.callCount(), 1);
    assertDone();
  } finally {
    await db.destroy();
  }
});
