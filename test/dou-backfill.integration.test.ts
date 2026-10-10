import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { isCronDue } from '../src/modules/collection/cron.js';
import {
  DOU_BACKFILL_SECTIONS,
  DouBackfillBlockedError,
  DouBackfillThrottledError,
  planDouBackfillDates,
  readDouBackfillCoverage,
  runDouBackfillBatch,
  runDouBackfillTick,
} from '../src/modules/collection/dou-backfill.js';
import { readDouSourceState } from '../src/modules/collection/dou-source-state.repository.js';
import { fixtureFetch } from './dou.fixtures.js';

const credentials = () => ({ email: 'test@example.invalid', password: 'fixture' });
const now = () => new Date('2026-10-04T15:00:00Z');

test('two independent pools serialize DOU backfill creation and enforce the interval after completion', { timeout: 15_000 }, async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  const databases = [0, 1].map(() => new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2, statement_timeout: 5_000 }) }),
  }));
  const [db, replicaDb] = databases as [Kysely<DB>, Kysely<DB>];
  const sourceId = randomUUID();
  const fetch = await fixtureFetch();
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  // A safety deadline makes a broken serialization fail assertions instead
  // of leaving the winning batch and its cleanup waiting indefinitely.
  const deadline = setTimeout(releaseFetch, 5_000);
  const gatedFetch: typeof fetch = async (input, init) => {
    await fetchGate;
    return fetch(input, init);
  };
  const options = { sourceId, credentials, fetch: gatedFetch, now, dates: ['2026-09-20'], timeoutMs: 10_000, minIntervalMs: 3_600_000 };
  try {
    await db.insertInto('sources').values({
      id: sourceId, code: `dou-concurrency-${sourceId}`, name: 'DOU concurrent backfill', jurisdiction_level: 'FEDERAL',
      base_url: 'https://inlabs.in.gov.br', connector_key: 'dou', max_attempts: 1,
    }).execute();

    let arrived = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const launch = (database: Kysely<DB>, workerId: string) => database.connection().execute(async (connection) => {
      if (++arrived === 2) releaseStart();
      await startGate;
      try {
        return await runDouBackfillBatch(connection, { ...options, workerId });
      } catch (error) {
        // The winner remains RUNNING in fetch until its competitor has
        // observed the committed open run and refused to create another.
        releaseFetch();
        throw error;
      }
    });
    const outcomes = await Promise.allSettled([
      launch(db, 'backfill-replica-a'),
      launch(replicaDb, 'backfill-replica-b'),
    ]);
    const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0]!.reason instanceof DouBackfillBlockedError);
    assert.ok(!(failures[0]!.reason instanceof DouBackfillThrottledError), 'the competing batch must see an open run');
    assert.equal(successes[0]!.value.result.status, 'SUCCESS_NO_RESULTS');

    await assert.rejects(
      runDouBackfillBatch(replicaDb, { ...options, fetch, workerId: 'backfill-after-completion' }),
      DouBackfillThrottledError,
    );
    const runs = await db.selectFrom('collection_runs').select(['id', 'status', 'worker_id'])
      .where('source_id', '=', sourceId).execute();
    assert.deepEqual(runs, [{ id: successes[0]!.value.runId, status: 'SUCCESS_NO_RESULTS', worker_id: null }]);
  } finally {
    clearTimeout(deadline);
    releaseFetch();
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await Promise.all(databases.map((database) => database.destroy()));
  }
});

test('backfill retries keep ownership through the deadline grace and abandoned owners remain recoverable', async (t) => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  const databases = [0, 1].map(() => new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 }) }),
  }));
  const [db, replicaDb] = databases as [Kysely<DB>, Kysely<DB>];
  const sourceId = randomUUID();
  const fetch = await fixtureFetch();
  let requests = 0;
  let sleeps = 0;
  let runId: string | undefined;
  let staleHeartbeatMs = 0;
  let observedRenewal = false;
  const transientFetch: typeof fetch = async (input, init) => {
    if (++requests === 1) return new Response(null, { status: 503 });
    if (requests === 2) {
      const resumed = await db.selectFrom('collection_runs').select(['worker_id', 'heartbeat_at'])
        .where('id', '=', runId!).executeTakeFirstOrThrow();
      assert.equal(resumed.worker_id, 'backfill-retry-owner');
      assert.ok(resumed.heartbeat_at && new Date(resumed.heartbeat_at).getTime() > staleHeartbeatMs,
        'the owner renews immediately after sleep, before attempting another request');
      observedRenewal = true;
    }
    return fetch(input, init);
  };
  try {
    await db.insertInto('sources').values({
      id: sourceId, code: `dou-retry-stale-${sourceId}`, name: 'DOU backfill retry stale boundary', jurisdiction_level: 'FEDERAL',
      base_url: 'https://inlabs.in.gov.br', connector_key: 'dou', max_attempts: 1,
    }).execute();

    const result = await runDouBackfillBatch(db, {
      sourceId, credentials, fetch: transientFetch, now, dates: ['2026-09-20'], workerId: 'backfill-retry-owner', maxAttempts: 2,
      // Disable periodic heartbeats only in this fixture: they must not mask
      // a missing synchronous renewal between sleep and the next attempt.
      heartbeatIntervalMs: 0,
      sleep: async (waitMs) => {
        sleeps += 1;
        const staleAfterMs = 1_000;
        assert.ok(waitMs > 5_000 && waitMs <= 20_000, 'the actual INLABS retry exceeds the configured stale threshold');
        const run = await db.selectFrom('collection_runs').select(['id', 'status', 'worker_id', 'next_attempt_at'])
          .where('source_id', '=', sourceId).executeTakeFirstOrThrow();
        runId = run.id;
        assert.equal(run.status, 'RUNNING');
        assert.equal(run.worker_id, 'backfill-retry-owner');
        assert.ok(run.next_attempt_at && new Date(run.next_attempt_at).getTime() > Date.now(),
          'reclaim preserves the not-yet-due retry timestamp');

        // Model five seconds inside the twenty-second retry without a real
        // sleep or changing the global clock. There is no heartbeat between
        // attempts, so this is the persisted state of a live waiting owner.
        staleHeartbeatMs = Date.now() - 5_000;
        await db.updateTable('collection_runs').set({ heartbeat_at: new Date(staleHeartbeatMs) })
          .where('id', '=', run.id).execute();
        assert.equal(await acquireNextCollectionRun(replicaDb, 'default-stale-worker'), null,
          'the default 120-second threshold does not expose this retry gap');
        assert.equal(await acquireNextCollectionRun(replicaDb, 'short-stale-worker', { staleAfterMs }), null,
          'even a one-second stale threshold cannot steal a live retry wait');
        const owner = await db.selectFrom('collection_runs').select('worker_id')
          .where('id', '=', run.id).executeTakeFirstOrThrow();
        assert.equal(owner.worker_id, 'backfill-retry-owner');
        // Fix only the stale cutoff's JS clock. PostgreSQL now() and the
        // owner's new Date() heartbeat still use real time. This makes the
        // post-deadline boundary independent of runner/query latency.
        const afterDeadline = Date.now();
        const clock = t.mock.method(Date, 'now', () => afterDeadline);
        try {
          await db.updateTable('collection_runs').set({ next_attempt_at: new Date(afterDeadline - 100) })
            .where('id', '=', run.id).execute();
          assert.equal(await acquireNextCollectionRun(replicaDb, 'within-deadline-grace', { staleAfterMs }), null,
            '100ms after the deadline is still inside the 1s stale grace, despite the old heartbeat');
        } finally {
          clock.mock.restore();
        }
      },
    });
    assert.equal(sleeps, 1);
    assert.ok(requests > 1, 'the original owner makes the second attempt');
    assert.equal(observedRenewal, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.result.state, 'TERMINAL');
    assert.equal(result.result.status, 'SUCCESS_NO_RESULTS');
    const attempts = await db.selectFrom('collection_attempts').select(['attempt_no', 'status', 'error_code'])
      .where('collection_run_id', '=', runId!).orderBy('attempt_no').execute();
    assert.deepEqual(attempts, [
      { attempt_no: 1, status: 'SOURCE_UNAVAILABLE', error_code: 'INLABS_UNAVAILABLE' },
      { attempt_no: 2, status: 'SUCCESS', error_code: null },
    ]);

    // The grace is not permanent ownership: both the abandoned heartbeat
    // and retry deadline must be older than the full stale window.
    const abandoned = await createCollectionRun(db, {
      sourceId, scheduledFor: new Date(Date.now() - 60_000), triggerType: 'BACKFILL',
    });
    const abandonedNow = Date.now();
    const clock = t.mock.method(Date, 'now', () => abandonedNow);
    try {
      await db.updateTable('collection_runs').set({
        status: 'RUNNING', worker_id: 'abandoned-backfill-owner',
        heartbeat_at: new Date(abandonedNow - 5_000), next_attempt_at: new Date(abandonedNow - 100),
      }).where('id', '=', abandoned).execute();
      assert.equal(await acquireNextCollectionRun(replicaDb, 'abandoned-within-grace', { staleAfterMs: 1_000 }), null);
      await db.updateTable('collection_runs').set({ next_attempt_at: new Date(abandonedNow - 2_000) })
        .where('id', '=', abandoned).execute();
      const recovered = await acquireNextCollectionRun(replicaDb, 'due-retry-recovery', { staleAfterMs: 1_000 });
      assert.equal(recovered?.id, abandoned);
      assert.equal(recovered?.workerId, 'due-retry-recovery');
    } finally {
      clock.mock.restore();
    }
  } finally {
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await Promise.all(databases.map((database) => database.destroy()));
  }
});

test('monitoring coverage remains monotonic when a later run moves its archive window', async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 4 }) }) });
  const sourceId = randomUUID();
  const firstDate = '2026-09-18';
  const secondDate = '2026-09-19';
  const legacyReceipt = '2026-09-17-DO2.zip';
  const receiptOnly = '2026-09-16-DO3.zip';
  const insertMonitoring = async (date: string, status: 'SUCCESS' | 'SUCCESS_NO_RESULTS', hash: string) => {
    const at = new Date(`${date}T18:00:00Z`);
    const run = await db.insertInto('collection_runs').values({
      source_id: sourceId, scheduled_for: at, started_at: at, finished_at: at,
      status, trigger_type: 'SCHEDULED',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('collection_attempts').values({
      collection_run_id: run.id, attempt_no: 1, status: 'SUCCESS',
      metadata: {
        douArchives: { [`${date}-DO1.zip`]: hash, [legacyReceipt]: hash, [receiptOnly]: hash },
        dou: { archives: DOU_BACKFILL_SECTIONS.map((section) => ({
          date, section, filename: `${date}-${section}.zip`,
          state: section === 'DO1' ? (status === 'SUCCESS' ? 'PARSED' : 'UNCHANGED') : 'NOT_AVAILABLE',
          ...(section === 'DO1' ? { rawSha256: hash } : {}),
        })) },
      },
    }).execute();
  };
  try {
    await db.insertInto('sources').values({
      id: sourceId, code: `dou-coverage-${sourceId}`, name: 'DOU coverage history',
      jurisdiction_level: 'FEDERAL', base_url: 'https://inlabs.in.gov.br', connector_key: 'dou',
    }).execute();
    await insertMonitoring(firstDate, 'SUCCESS', 'a'.repeat(64));
    assert.deepEqual((await readDouBackfillCoverage(db, sourceId)).covered, new Set([firstDate]));

    await insertMonitoring(secondDate, 'SUCCESS_NO_RESULTS', 'b'.repeat(64));
    for (let pass = 0; pass < 3; pass += 1) {
      const coverage = await readDouBackfillCoverage(db, sourceId);
      assert.deepEqual(coverage.covered, new Set([firstDate, secondDate]), 'the previous archive window remains covered');
      assert.deepEqual(planDouBackfillDates({ from: firstDate, to: secondDate, today: '2026-10-04', covered: coverage.covered }), []);
      assert.equal(coverage.receipts[`${firstDate}-DO1.zip`], 'a'.repeat(64), 'older parsed archive receipts remain usable');
      assert.equal(coverage.receipts[`${secondDate}-DO1.zip`], 'b'.repeat(64), 'unchanged archive receipts remain usable');
      assert.equal(coverage.receipts[legacyReceipt], 'b'.repeat(64), 'the newest valid historical receipt wins');
      assert.equal(coverage.receipts[receiptOnly], 'b'.repeat(64));
      assert.equal(coverage.covered.has('2026-09-17'), false, 'excluded DO2 receipts cannot prove coverage');
      assert.equal(coverage.covered.has('2026-09-16'), false, 'an enabled-section receipt alone cannot prove coverage');
    }
  } finally {
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});

test('backfill coverage rejects publication persistence failures but keeps parser-only partial consultation', async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 }) }) });
  const sourceId = randomUUID();
  const failedDate = '2026-09-18';
  const parserPartialDate = '2026-09-19';
  const insertBackfill = async (date: string, parserPartial: boolean) => {
    const at = new Date(`${date}T18:00:00Z`);
    const run = await db.insertInto('collection_runs').values({
      source_id: sourceId, scheduled_for: at, started_at: at, finished_at: at,
      status: 'PARTIAL_SUCCESS', trigger_type: 'BACKFILL',
    }).returning('id').executeTakeFirstOrThrow();
    const attempt = await db.insertInto('collection_attempts').values({
      collection_run_id: run.id, attempt_no: 1, status: 'SUCCESS',
      metadata: {
        // Archive consultation metadata is written before publication
        // persistence; PARSED alone must not make a failed item disappear.
        dou: { archives: DOU_BACKFILL_SECTIONS.map(section => ({
          date, section, filename: `${date}-${section}.zip`, rawSha256: 'a'.repeat(64),
          state: parserPartial && section === 'DO1' ? 'PARTIAL' : 'PARSED',
        })) },
      },
    }).returning('id').executeTakeFirstOrThrow();
    return { runId: run.id, attemptId: attempt.id };
  };
  try {
    await db.insertInto('sources').values({
      id: sourceId, code: `dou-failed-coverage-${sourceId}`, name: 'DOU failed publication coverage',
      jurisdiction_level: 'FEDERAL', base_url: 'https://inlabs.in.gov.br', connector_key: 'dou',
    }).execute();
    const failed = await insertBackfill(failedDate, false);
    await db.insertInto('collection_items').values({
      collection_run_id: failed.runId, first_attempt_id: failed.attemptId,
      source_item_key: 'fixture-failed-publication', status: 'FAILED',
      error_code: 'PUBLICATION_PROCESSING_ERROR', error_message: 'Fixture publication persistence failure.',
    }).execute();
    await insertBackfill(parserPartialDate, true);

    const coverage = await readDouBackfillCoverage(db, sourceId);
    assert.deepEqual(coverage.covered, new Set([parserPartialDate]), 'a failed item only excludes its own run; parser omissions remain consulted');
    for (const section of DOU_BACKFILL_SECTIONS) {
      assert.equal(coverage.receipts[`${failedDate}-${section}.zip`], undefined, 'the failed run cannot supply hashes that skip retrying its publications');
    }
    assert.equal(coverage.receipts[`${parserPartialDate}-DO1.zip`], undefined, 'a partial archive is not an unchanged-package receipt');
    assert.equal(coverage.receipts[`${parserPartialDate}-DO3.zip`], 'a'.repeat(64));
    assert.deepEqual(planDouBackfillDates({ from: failedDate, to: parserPartialDate, today: '2026-10-04', covered: coverage.covered }), [failedDate]);
  } finally {
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});

test('administrative DOU backfill runs explicit past dates through the engine without touching monitoring', async (t) => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL worker runtime is required');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 4 }) }) });
  const runtimeDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) }) });
  const sourceId = randomUUID();
  let policyId = randomUUID();
  let borrowedApprovedPolicy = false;
  const fetch = await fixtureFetch();
  const base = { sourceId, credentials, fetch, now, timeoutMs: 10_000, sleep: async () => undefined };
  try {
    const existingApproved = await db
      .selectFrom('collection_filter_policies')
      .select('id')
      .where('status', '=', 'APPROVED')
      .executeTakeFirst();
    if (existingApproved) {
      // Migration 051 provisions a deliberately empty APPROVED policy on fresh
      // installations; test against that real runtime invariant, not its absence.
      const existingRule = await db.selectFrom('collection_filter_type_rules')
        .select('id').where('policy_id', '=', existingApproved.id).executeTakeFirst();
      assert.equal(existingRule, undefined, 'fixture needs an empty approved policy');
      policyId = existingApproved.id;
      borrowedApprovedPolicy = true;
    } else {
      const maxVersion = await db
        .selectFrom('collection_filter_policies')
        .select(({ fn }) => fn.max<number>('version').as('version'))
        .executeTakeFirst();
      await db.insertInto('collection_filter_policies').values({
        id: policyId,
        version: Number(maxVersion?.version ?? 0) + 1,
        revision: 1,
        status: 'APPROVED',
        context_window_words: 12,
        weak_score_threshold: 3,
        title_weight: 3,
        summary_weight: 2,
        body_weight: 1,
        change_notes: 'DOU backfill integration permissive fixture',
        approved_at: new Date(),
      }).execute();
    }

    const fixtureTypes = [
      'RETIFICACAO',
      'SOLUCAO DE CONSULTA',
      'ATO DECLARATORIO',
      'DESPACHO',
      'PORTARIA',
      'INSTRUCAO NORMATIVA',
    ];
    await db.insertInto('collection_filter_type_rules').values(
      ['DO1', 'DO1E'].flatMap((section) =>
        fixtureTypes.map((canonicalType) => ({
          policy_id: policyId,
          source_code: 'dou',
          section,
          canonical_type: canonicalType,
          mode: 'KEEP_ALWAYS' as const,
        })),
      ),
    ).execute();

    await db.insertInto('sources').values({
      // The hourly tick resolves the source by its production code.
      id: sourceId, code: 'dou', name: 'DOU backfill', jurisdiction_level: 'FEDERAL',
      base_url: 'https://inlabs.in.gov.br', connector_key: 'dou', max_attempts: 1,
    }).execute();

    await t.test('a batch persists real matters as a BACKFILL run owned by the script', async () => {
      const result = await runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-09-19', '2026-09-18'], workerId: 'backfill-test' });
      assert.equal(result.result.state, 'TERMINAL');
      assert.equal(result.result.status, 'SUCCESS');
      assert.equal(result.result.metrics.newPublications, 10);
      const run = await db.selectFrom('collection_runs').select(['trigger_type', 'status', 'worker_id']).where('id', '=', result.runId).executeTakeFirstOrThrow();
      assert.deepEqual(run, { trigger_type: 'BACKFILL', status: 'SUCCESS', worker_id: null });
      const origins = await db.selectFrom('publication_origins').select('external_id').where('source_id', '=', sourceId).execute();
      assert.equal(origins.length, 10);
    });

    await t.test('coverage marks fully consulted dates, including a date without edition, and the plan skips them', async () => {
      const coverage = await readDouBackfillCoverage(db, sourceId);
      assert.ok(coverage.covered.has('2026-09-18'));
      assert.ok(coverage.covered.has('2026-09-19'), 'all six packages absent: consulted, not pending');
      assert.ok(coverage.receipts['2026-09-18-DO1.zip']);
      const plan = planDouBackfillDates({ from: '2026-09-17', to: '2026-09-20', today: '2026-10-04', covered: coverage.covered });
      assert.deepEqual(plan, ['2026-09-20', '2026-09-17']);
    });

    await t.test('re-running a covered date is idempotent', async () => {
      const coverage = await readDouBackfillCoverage(db, sourceId);
      const replay = await runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-09-18'], workerId: 'backfill-test', receipts: coverage.receipts });
      assert.equal(replay.result.status, 'SUCCESS_NO_RESULTS', 'unchanged packages are skipped by receipt');
      const again = await runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-09-18'], workerId: 'backfill-test' });
      assert.equal(again.result.metrics.existingPublications, 10, 'without receipts: re-parsed, deduplicated');
      assert.equal(again.result.metrics.newPublications, 0);
      assert.equal(again.result.metrics.newVersions, 0);
    });

    await t.test('a batch made only of dates without edition finishes instead of retrying forever', async () => {
      const empty = await runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-09-20', '2026-09-13'], workerId: 'backfill-test' });
      assert.equal(empty.result.status, 'SUCCESS_NO_RESULTS');
      assert.equal(empty.attempts, 1);
    });

    await t.test('backfill runs never feed the monitoring checkpoint', async () => {
      const monitoring = await createCollectionRun(db, { sourceId, scheduledFor: new Date(Date.now() - 1_000), triggerType: 'MANUAL' });
      const state = await readDouSourceState(db, sourceId, monitoring);
      assert.deepEqual(state.archives, {});
      await db.updateTable('collection_runs').set({ status: 'CANCELLED', finished_at: new Date() }).where('id', '=', monitoring).execute();
    });

    await t.test('an open run blocks the backfill; a backfill run is never acquirable by the worker', async () => {
      const open = await createCollectionRun(db, { sourceId, scheduledFor: new Date(Date.now() + 3_600_000), triggerType: 'MANUAL' });
      await assert.rejects(runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-09-17'], workerId: 'backfill-test' }), DouBackfillBlockedError);
      await db.updateTable('collection_runs').set({ status: 'CANCELLED', finished_at: new Date() }).where('id', '=', open).execute();

      let acquiredByWorker: string | undefined;
      const slowFetch: typeof fetch = async (input, init) => {
        const acquired = await acquireNextCollectionRun(db, 'regular-worker');
        if (acquired && acquired.sourceId === sourceId) acquiredByWorker = acquired.id;
        return fetch(input, init);
      };
      await runDouBackfillBatch(runtimeDb, { ...base, fetch: slowFetch, dates: ['2026-09-17'], workerId: 'backfill-test' });
      assert.equal(acquiredByWorker, undefined);
    });

    await t.test('hourly tick: one date per run, throttled to one run per interval, complete when nothing is missing', async () => {
      const tick = (overrides: Record<string, unknown> = {}) => runDouBackfillTick(runtimeDb, {
        from: '2026-09-15', workerId: 'tick-worker', credentials, fetch, now, timeoutMs: 10_000, isCronDue, ...overrides,
      });
      // Covered so far: 13, 17, 18, 19, 20 (plus the monitoring window). Missing: 01/10 .. 21/09, 16, 15.
      // Earlier subtests just ran backfills: the first tick ignores the interval.
      const first = await tick({ minIntervalMs: 1 });
      assert.equal(first.state, 'RAN');
      assert.deepEqual(first.state === 'RAN' && first.batch.dates, ['2026-10-01'], 'walks back one day per query');
      assert.equal(first.state === 'RAN' && first.batch.result.status, 'SUCCESS_NO_RESULTS');

      const throttled = await tick(); // default: one run per hour
      assert.deepEqual(throttled, { state: 'SKIPPED', reason: 'THROTTLED' });

      const rest = await tick({ minIntervalMs: 1, datesPerRun: 4 });
      assert.equal(rest.state === 'RAN' && rest.batch.dates.length, 4);
      assert.equal(rest.state === 'RAN' && rest.batch.dates[0], '2026-09-30');

      const complete = await runDouBackfillTick(runtimeDb, {
        from: '2026-09-17', workerId: 'tick-worker', credentials, fetch, now, isCronDue, minIntervalMs: 1,
        // Everything from 17/09 is covered once the remaining dates are consulted.
      });
      assert.notEqual(complete.state, 'SKIPPED');
      let state = complete.state;
      for (let guard = 0; state === 'RAN' && guard < 10; guard += 1) {
        state = (await runDouBackfillTick(runtimeDb, { from: '2026-09-17', workerId: 'tick-worker', credentials, fetch, now, isCronDue, minIntervalMs: 1, datesPerRun: 4 })).state;
      }
      assert.equal(state, 'COMPLETE');
    });

    await t.test('a date that keeps failing does not block older dates; repeated failures stall the backfill', async () => {
      const tickArgs = { from: '2026-09-01', workerId: 'tick-worker', credentials, fetch, now, isCronDue, minIntervalMs: 1 };
      let sequence = 0;
      const failedRun = async () => {
        // Distinct scheduled_for: (source, scheduled_for, trigger) is unique.
        const at = new Date(Date.now() + (sequence += 1));
        await db.insertInto('collection_runs').values({
          source_id: sourceId, scheduled_for: at, started_at: at, finished_at: at,
          status: 'SOURCE_UNAVAILABLE', trigger_type: 'BACKFILL', error_summary: 'DOU_BACKFILL_RETRY_LIMIT: 8 attempts',
        }).execute();
      };
      const coverage = await readDouBackfillCoverage(db, sourceId);
      const missing = planDouBackfillDates({ from: '2026-09-01', to: '2026-10-01', today: '2026-10-04', covered: coverage.covered });
      assert.ok(missing.length >= 2);

      await failedRun();
      const rotated = await runDouBackfillTick(runtimeDb, tickArgs);
      assert.deepEqual(rotated.state === 'RAN' && rotated.batch.dates, [missing[1]], 'after one failure the next date is tried');

      const remaining = planDouBackfillDates({ from: '2026-09-01', to: '2026-10-01', today: '2026-10-04', covered: (await readDouBackfillCoverage(db, sourceId)).covered });
      for (let i = 0; i < 2 * remaining.length; i += 1) await failedRun();
      const stalled = await runDouBackfillTick(runtimeDb, tickArgs);
      assert.equal(stalled.state, 'STALLED');
      assert.deepEqual(stalled.state === 'STALLED' && stalled.remainingDates, remaining);
      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).where('status', '=', 'SOURCE_UNAVAILABLE').execute();
    });

    await t.test('hourly tick never starts close to a scheduled DOU cycle', async () => {
      await db.updateTable('sources').set({ schedule_cron: '10 12 * * *', schedule_timezone: 'America/Sao_Paulo' }).where('id', '=', sourceId).execute();
      // now() is 12:00 in São Paulo: the 12:10 cycle is within the 20-minute guard.
      const skipped = await runDouBackfillTick(runtimeDb, { from: '2026-09-15', workerId: 'tick-worker', credentials, fetch, now, isCronDue, minIntervalMs: 1 });
      assert.deepEqual(skipped, { state: 'SKIPPED', reason: 'SCHEDULED_CYCLE_DUE' });
      await db.updateTable('sources').set({ schedule_cron: null }).where('id', '=', sourceId).execute();
    });

    await t.test('dates inside the monitoring window are refused', async () => {
      await assert.rejects(runDouBackfillBatch(runtimeDb, { ...base, dates: ['2026-10-02'], workerId: 'backfill-test' }), RangeError);
    });
  } finally {
    const ids = [...new Set((await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute()).map((row) => row.publication_id))];
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (ids.length) await db.deleteFrom('publications').where('id', 'in', ids).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    if (borrowedApprovedPolicy) {
      await db.deleteFrom('collection_filter_type_rules').where('policy_id', '=', policyId).execute();
    } else {
      await db.deleteFrom('collection_filter_policies').where('id', '=', policyId).execute();
    }
    await Promise.all([runtimeDb.destroy(), db.destroy()]);
  }
});
