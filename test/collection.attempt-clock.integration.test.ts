import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { finishCollectionAttempt, startCollectionAttempt } from '../src/modules/collection/collection-run.repository.js';

// started_at is written by the DATABASE clock (now(), microseconds) and finished_at by the APP clock (milliseconds).
// chk_attempt_dates (finished_at >= started_at) must hold whatever the truncation or skew, without relaxing the
// constraint or rewriting a finish that is already later than the start. Deterministic: the app clock is injected.
const T = new Date('2026-11-07T15:08:51.776Z'); // the CI case: finish …:51.776 vs start …:51.776008
const failure = (retryable: boolean) => ({ ok: false, status: 'FETCH_ERROR', durationMs: 0, code: retryable ? 'SIMULATED_TRANSIENT_ERROR' : 'SIMULATED_PERMANENT_ERROR',
  message: 'simulated', retryable }) as const;
const success = (checkpoint?: { version: number; state: Record<string, unknown> }) => ({ ok: true, status: 'SUCCESS', durationMs: 0,
  result: { publications: [], ...(checkpoint ? { checkpoint } : {}) } }) as const;

async function withDb(fn: (db: Kysely<DB>, ids: { sourceId: string; runId: string; connectorKey: string }) => Promise<void>) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for this integration test.');
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: adminUrl, max: 2 }) }) });
  const sourceId = randomUUID(); const runId = randomUUID(); const connectorKey = `clock-connector-${sourceId}`;
  try {
    await db.insertInto('sources').values({ id: sourceId, code: `clock-source-${sourceId}`, name: 'Clock Source', jurisdiction_level: 'FEDERAL',
      base_url: 'https://clock.example.test', connector_key: connectorKey, max_attempts: 3 }).execute();
    await db.insertInto('collection_runs').values({ id: runId, source_id: sourceId, scheduled_for: T, trigger_type: 'MANUAL', status: 'RUNNING',
      started_at: T, worker_id: 'clock-worker', locked_at: T, heartbeat_at: T }).execute();
    await fn(db, { sourceId, runId, connectorKey });
  } finally {
    await db.deleteFrom('collection_checkpoints').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('collection_attempts').where('collection_run_id', '=', runId).execute();
    await db.deleteFrom('collection_runs').where('id', '=', runId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
}
const attempt = async (db: Kysely<DB>, runId: string, n: number, startedAt: ReturnType<typeof sql<Date>>) =>
  (await db.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: n, status: 'RUNNING', started_at: startedAt }).returning('id').executeTakeFirstOrThrow()).id;
const row = (db: Kysely<DB>, id: string) => db.selectFrom('collection_attempts').select(['started_at', 'finished_at', 'status', 'retryable']).where('id', '=', id).executeTakeFirstOrThrow();
const micros = async (db: Kysely<DB>, id: string) => (await sql<{ s: string; f: string }>`select to_char(started_at at time zone 'UTC', 'HH24:MI:SS.US') as s, to_char(finished_at at time zone 'UTC', 'HH24:MI:SS.US') as f from collection_attempts where id = ${id}`.execute(db)).rows[0]!;

test('precision: start …:51.776008 (DB, µs) and app finish …:51.776 (ms) — FAILURE and SUCCESS keep finished_at >= started_at', async () => {
  await withDb(async (db, { runId }) => {
    const startAt = sql<Date>`${T}::timestamptz + interval '8 microseconds'`;
    const a1 = await attempt(db, runId, 1, startAt);
    assert.equal(await finishCollectionAttempt(db, { attemptId: a1, outcome: failure(true), now: () => T }), true);
    assert.deepEqual(await micros(db, a1), { s: '15:08:51.776008', f: '15:08:51.776008' }, 'finish clamped to the start, never before it');
    const a2 = await attempt(db, runId, 2, startAt);
    assert.equal(await finishCollectionAttempt(db, { attemptId: a2, outcome: success(), now: () => T }), true);
    assert.deepEqual(await micros(db, a2), { s: '15:08:51.776008', f: '15:08:51.776008' });
    assert.equal((await row(db, a2)).status, 'SUCCESS');
  });
});

test('skew: the database clock 5 s ahead of the app clock — finish is not before start; a later app finish is kept unchanged', async () => {
  await withDb(async (db, { runId }) => {
    const a1 = await attempt(db, runId, 1, sql<Date>`now() + interval '5 seconds'`);
    assert.equal(await finishCollectionAttempt(db, { attemptId: a1, outcome: failure(false) }), true);
    const r1 = await row(db, a1); assert.ok(r1.finished_at!.getTime() >= r1.started_at.getTime());
    // No rewrite when the app finish is already later: finished_at is exactly the app time (timestamps preserved).
    const later = new Date(T.getTime() + 1500);
    const a2 = await attempt(db, runId, 2, sql<Date>`${T}::timestamptz`);
    assert.equal(await finishCollectionAttempt(db, { attemptId: a2, outcome: failure(false), now: () => later }), true);
    assert.equal((await row(db, a2)).finished_at!.toISOString(), later.toISOString());
  });
});

test('ownership, retry and checkpoint paths under the same skew: failure → retry → success with checkpoint; a foreign worker changes nothing', async () => {
  await withDb(async (db, { sourceId, runId, connectorKey }) => {
    // Attempts started by the real runner path (startCollectionAttempt → DB clock), finished with an app clock behind.
    const behind = () => new Date(Date.now() - 5_000);
    const first = await startCollectionAttempt(db, runId, 'clock-worker');
    assert.equal(await finishCollectionAttempt(db, { attemptId: first.id, runId, workerId: 'clock-worker', outcome: failure(true), now: behind }), true);
    const r1 = await row(db, first.id); assert.deepEqual([r1.status, r1.retryable], ['FETCH_ERROR', true]); assert.ok(r1.finished_at!.getTime() >= r1.started_at.getTime());

    const retry = await startCollectionAttempt(db, runId, 'clock-worker');
    assert.equal(await finishCollectionAttempt(db, { attemptId: retry.id, runId, workerId: 'intruder', outcome: success(), now: behind }), false, 'not the owner');
    assert.equal((await row(db, retry.id)).finished_at, null, 'a refused finish leaves the attempt untouched');
    assert.equal(await finishCollectionAttempt(db, { attemptId: retry.id, runId, workerId: 'clock-worker', sourceId, connectorKey,
      outcome: success({ version: 1, state: { cursor: 'c1' } }), now: behind }), true);
    const r2 = await row(db, retry.id); assert.equal(r2.status, 'SUCCESS'); assert.ok(r2.finished_at!.getTime() >= r2.started_at.getTime());
    const cp = await db.selectFrom('collection_checkpoints').selectAll().where('source_id', '=', sourceId).execute();
    assert.equal(cp.length, 1, 'checkpoint persisted on the success path');
  });
});
