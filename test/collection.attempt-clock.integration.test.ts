import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { finishCollectionAttempt } from '../src/modules/collection/collection-run.repository.js';

// Clock skew between the app (finished_at = new Date(), millisecond precision) and the database (started_at = now(),
// microsecond precision) must never violate chk_attempt_dates (finished_at >= started_at). Deterministic: the attempt
// is started 5 s AHEAD of the app clock, the worst case of the race seen in CI (…:51.776 < …:51.776008).
test('finishing an attempt whose started_at is ahead of the app clock keeps finished_at >= started_at (no chk_attempt_dates violation)', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for this integration test.');
  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID(); const runId = randomUUID();
  try {
    await db.insertInto('sources').values({ id: sourceId, code: `clock-source-${sourceId}`, name: 'Clock Source', jurisdiction_level: 'FEDERAL',
      base_url: 'https://clock.example.test', connector_key: `clock-connector-${sourceId}`, max_attempts: 3 }).execute();
    await db.insertInto('collection_runs').values({ id: runId, source_id: sourceId, scheduled_for: new Date(), trigger_type: 'MANUAL', status: 'RUNNING',
      started_at: new Date(), worker_id: 'clock-worker', locked_at: new Date(), heartbeat_at: new Date() }).execute();
    for (const [n, outcome] of [
      [1, { ok: false, status: 'FETCH_ERROR', durationMs: 0, code: 'SIMULATED_TRANSIENT_ERROR', message: 'transient', retryable: true }],
      [2, { ok: false, status: 'FETCH_ERROR', durationMs: 0, code: 'SIMULATED_PERMANENT_ERROR', message: 'permanent', retryable: false }],
    ] as const) {
      const attempt = await db.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: n, status: 'RUNNING',
        started_at: sql<Date>`now() + interval '5 seconds'` }).returning('id').executeTakeFirstOrThrow();
      const finished = await finishCollectionAttempt(db, { attemptId: attempt.id, outcome: outcome as never });
      assert.equal(finished, true);
      const row = await db.selectFrom('collection_attempts').select(['started_at', 'finished_at', 'status']).where('id', '=', attempt.id).executeTakeFirstOrThrow();
      assert.equal(row.status, 'FETCH_ERROR');
      assert.ok(row.finished_at && row.finished_at.getTime() >= row.started_at.getTime(), 'finished_at never precedes started_at');
    }
  } finally {
    await db.deleteFrom('collection_attempts').where('collection_run_id', '=', runId).execute();
    await db.deleteFrom('collection_runs').where('id', '=', runId).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
