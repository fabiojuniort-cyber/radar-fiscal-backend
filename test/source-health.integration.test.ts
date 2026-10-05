import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import {
  evaluateSourceHealth,
  readSourceHealthRows,
} from '../src/modules/operations/source-health.js';

test('source health reads real run history and flags stuck, stale and persistent-partial sources', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for source health integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const created: string[] = [];

  async function source(code: string, active = true, cron: string | null = '0 * * * *'): Promise<string> {
    const row = await db.insertInto('sources').values({
      code: `${code}-${suffix}`,
      name: code,
      jurisdiction_level: 'FEDERAL',
      base_url: 'https://health.example.test',
      connector_key: `health-${code}-${suffix}`,
      schedule_cron: cron,
      is_active: active,
      created_at: hoursAgo(24 * 30),
    }).returning('id').executeTakeFirstOrThrow();
    created.push(row.id);
    return row.id;
  }

  async function finishedRun(
    sourceId: string,
    status: string,
    finishedHoursAgo: number,
    error: string | null = null,
    triggerType: 'SCHEDULED' | 'BACKFILL' = 'SCHEDULED',
  ) {
    await db.insertInto('collection_runs').values({
      source_id: sourceId,
      scheduled_for: hoursAgo(finishedHoursAgo + 0.1),
      started_at: hoursAgo(finishedHoursAgo + 0.05),
      finished_at: hoursAgo(finishedHoursAgo),
      status,
      trigger_type: triggerType,
      error_summary: error,
    }).execute();
  }

  try {
    const healthy = await source('healthy');
    await finishedRun(healthy, 'SUCCESS', 1);

    const stuck = await source('stuck');
    await finishedRun(stuck, 'SUCCESS_NO_RESULTS', 80);
    const openRun = await db.insertInto('collection_runs').values({
      source_id: stuck,
      scheduled_for: hoursAgo(70),
      started_at: hoursAgo(70),
      status: 'RUNNING',
      trigger_type: 'SCHEDULED',
      error_summary: 'INLABS_INVALID_DOWNLOAD: INLABS_INVALID_DOWNLOAD',
    }).returning('id').executeTakeFirstOrThrow();
    for (const attemptNo of [1, 2, 25]) {
      await db.insertInto('collection_attempts').values({
        collection_run_id: openRun.id,
        attempt_no: attemptNo,
        status: 'FETCH_ERROR',
      }).execute();
    }

    const partial = await source('partial');
    for (let i = 1; i <= 6; i += 1) {
      await finishedRun(partial, 'PARTIAL_SUCCESS', i, 'Partial processing: 1 item errors');
      // Administrative backfill runs in between must not mask the pattern.
      await finishedRun(partial, 'SUCCESS', i - 0.5, null, 'BACKFILL');
    }

    // A source consulted only by backfill runs is still stale for monitoring.
    const backfillOnly = await source('backfill-only');
    await finishedRun(backfillOnly, 'SUCCESS_NO_RESULTS', 30);
    await finishedRun(backfillOnly, 'SUCCESS', 0.5, null, 'BACKFILL');

    const inactive = await source('inactive', false);
    await finishedRun(inactive, 'SOURCE_UNAVAILABLE', 200);
    const unscheduled = await source('unscheduled', true, null);
    await finishedRun(unscheduled, 'SOURCE_UNAVAILABLE', 200);

    const rows = (await readSourceHealthRows(db)).filter((row) => row.sourceCode.endsWith(suffix));
    assert.deepEqual(
      rows.map((row) => row.sourceCode).sort(),
      [`backfill-only-${suffix}`, `healthy-${suffix}`, `partial-${suffix}`, `stuck-${suffix}`],
    );

    const stuckRow = rows.find((row) => row.sourceCode === `stuck-${suffix}`)!;
    assert.equal(stuckRow.openRunId, openRun.id);
    assert.equal(stuckRow.openRunAttempts, 25);
    assert.equal(stuckRow.lastFinishedStatus, 'SUCCESS_NO_RESULTS');

    const partialRow = rows.find((row) => row.sourceCode === `partial-${suffix}`)!;
    assert.deepEqual(partialRow.recentFinishedStatuses, Array(6).fill('PARTIAL_SUCCESS'));
    assert.ok(partialRow.lastConsultedAt, 'PARTIAL_SUCCESS still counts as a real consultation');

    const alerts = evaluateSourceHealth(rows, now).alerts
      .map((alert) => `${alert.sourceCode.replace(`-${suffix}`, '')}:${alert.kind}`)
      .sort();
    assert.deepEqual(alerts, [
      'backfill-only:STALE_SOURCE',
      'partial:PERSISTENT_PARTIAL',
      'stuck:STALE_SOURCE',
      'stuck:STUCK_RUN',
    ]);
  } finally {
    if (created.length) {
      await db.deleteFrom('collection_runs').where('source_id', 'in', created).execute();
      await db.deleteFrom('sources').where('id', 'in', created).execute();
    }
    await db.destroy();
  }
});
