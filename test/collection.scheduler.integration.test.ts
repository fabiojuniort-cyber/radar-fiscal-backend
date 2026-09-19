import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  Kysely,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import {
  runSchedulerTick,
} from '../src/modules/collection/scheduler.service.js';

test(
  'scheduler creates due runs idempotently and isolates invalid schedules',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for scheduler integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const dueSourceId = randomUUID();
    const invalidSourceId = randomUUID();

    try {
      await db
        .insertInto('sources')
        .values([
          {
            id: dueSourceId,
            code: `scheduler-due-${dueSourceId}`,
            name: 'Scheduler Due Source',
            jurisdiction_level: 'FEDERAL',
            base_url: 'https://scheduler.example.test/due',
            connector_key:
              `scheduler-due-${dueSourceId}`,
            schedule_cron: '0 8 * * *',
            schedule_timezone:
              'America/Sao_Paulo',
          },
          {
            id: invalidSourceId,
            code:
              `scheduler-invalid-${invalidSourceId}`,
            name: 'Scheduler Invalid Source',
            jurisdiction_level: 'FEDERAL',
            base_url:
              'https://scheduler.example.test/invalid',
            connector_key:
              `scheduler-invalid-${invalidSourceId}`,
            schedule_cron: '99 99 * * *',
            schedule_timezone:
              'America/Sao_Paulo',
          },
        ])
        .execute();

      const now = new Date(
        '2026-09-19T11:00:22Z',
      );

      const first = await runSchedulerTick(
        db,
        now,
      );

      const second = await runSchedulerTick(
        db,
        now,
      );

      assert.equal(first.dueSources, 1);
      assert.equal(first.invalidSchedules, 1);
      assert.equal(second.dueSources, 1);
      assert.equal(second.invalidSchedules, 1);

      const runs = await db
        .selectFrom('collection_runs')
        .select([
          'source_id',
          'scheduled_for',
          'trigger_type',
          'status',
        ])
        .where('source_id', '=', dueSourceId)
        .execute();

      assert.equal(runs.length, 1);
      assert.equal(
        runs[0]?.trigger_type,
        'SCHEDULED',
      );
      assert.equal(runs[0]?.status, 'PENDING');
      assert.equal(
        runs[0]?.scheduled_for.toISOString(),
        '2026-09-19T11:00:00.000Z',
      );
    } finally {
      await db
        .deleteFrom('collection_runs')
        .where('source_id', 'in', [
          dueSourceId,
          invalidSourceId,
        ])
        .execute();

      await db
        .deleteFrom('sources')
        .where('id', 'in', [
          dueSourceId,
          invalidSourceId,
        ])
        .execute();

      await db.destroy();
    }
  },
);
