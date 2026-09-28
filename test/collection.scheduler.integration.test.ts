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
import { createScheduledCollectionRun } from '../src/modules/collection/collection-run.repository.js';

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

for (const connectorKey of ['dou', 'nfe-encat', 'sped', 'cgibs', 'rfb-normas', 'doe-sp']) {
  test(
    `scheduler does not overlap ${connectorKey} while an active run is pending or retrying`,
    async () => {
      const adminUrl = process.env.DATABASE_ADMIN_URL;
      assert.ok(adminUrl);

      const pool = new Pool({
        connectionString: adminUrl,
        max: 2,
      });
      const db = new Kysely<DB>({
        dialect: new PostgresDialect({ pool }),
      });

      const sourceId = randomUUID();
      const activeRunId = randomUUID();
      const now = new Date('2026-09-19T11:00:22Z');

      try {
        await db
          .insertInto('sources')
          .values({
            id: sourceId,
            code: `scheduler-${connectorKey}-${sourceId}`,
            name: `Scheduler ${connectorKey} Source`,
            jurisdiction_level: connectorKey === 'doe-sp' ? 'STATE' : 'FEDERAL',
            ...(connectorKey === 'doe-sp' ? { uf: 'SP' } : {}),
            base_url:
              connectorKey === 'doe-sp'
                ? 'https://doe.sp.gov.br/'
                : connectorKey === 'dou'
                ? 'https://inlabs.in.gov.br'
                : connectorKey === 'nfe-encat'
                  ? 'https://www.nfe.fazenda.gov.br/portal'
                  : connectorKey === 'sped'
                  ? 'https://sped.rfb.gov.br'
                  : connectorKey === 'cgibs'
                    ? 'https://www.cgibs.gov.br/'
                    : 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action',
            connector_key: connectorKey,
            schedule_cron:
              connectorKey === 'dou'
                ? '0 8,12,16,20 * * *'
                : '0 * * * *',
            schedule_timezone: 'America/Sao_Paulo',
          })
          .execute();

        await db
          .insertInto('collection_runs')
          .values({
            id: activeRunId,
            source_id: sourceId,
            scheduled_for: new Date('2026-09-19T10:00:00Z'),
            trigger_type: 'MANUAL',
            status: 'RUNNING',
            next_attempt_at: new Date('2026-09-19T11:00:10Z'),
          })
          .execute();

        const blocked = await runSchedulerTick(db, now);
        assert.equal(blocked.dueSources, 1);
        assert.deepEqual(blocked.runIds, []);

        await db
          .updateTable('collection_runs')
          .set({
            status: 'SUCCESS',
            finished_at: now,
            source_consulted_at: now,
            next_attempt_at: null,
          })
          .where('id', '=', activeRunId)
          .execute();

        const released = await runSchedulerTick(db, now);
        assert.equal(released.dueSources, 1);
        assert.equal(released.runIds.length, 1);

        const scheduled = await db
          .selectFrom('collection_runs')
          .select(['id', 'trigger_type', 'scheduled_for'])
          .where('source_id', '=', sourceId)
          .where('trigger_type', '=', 'SCHEDULED')
          .execute();

        assert.equal(scheduled.length, 1);
        assert.equal(
          scheduled[0]?.scheduled_for.toISOString(),
          '2026-09-19T11:00:00.000Z',
        );
      } finally {
        await db
          .deleteFrom('collection_runs')
          .where('source_id', '=', sourceId)
          .execute();
        await db
          .deleteFrom('sources')
          .where('id', '=', sourceId)
          .execute();
        await db.destroy();
      }
    },
  );
}

const pending = <T>(promise: Promise<T>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms)),
  ]);

test(
  'DOE-SP-33: a paused source never receives a scheduled run (pause x scheduler race)',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;
    assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for scheduler integration tests.');
    const pool = new Pool({ connectionString: adminUrl, max: 4 });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    const operator = await pool.connect();
    const sourceId = randomUUID();
    const runsOf = async () => Number((await db.selectFrom('collection_runs').select((eb) => eb.fn.countAll().as('n')).where('source_id', '=', sourceId).executeTakeFirstOrThrow()).n);
    const setActive = (active: boolean) => db.updateTable('sources').set({ is_active: active }).where('id', '=', sourceId).execute();

    try {
      await db.insertInto('sources').values({
        id: sourceId,
        code: `scheduler-pause-${sourceId}`,
        name: 'Scheduler Pause Race Source',
        jurisdiction_level: 'FEDERAL',
        base_url: 'https://scheduler.example.test/pause',
        connector_key: `scheduler-pause-${sourceId}`,
        schedule_cron: '* * * * *',
        schedule_timezone: 'America/Sao_Paulo',
      }).execute();

      // A) Pause in flight first: the scheduler insert waits for it and then
      //    re-evaluates is_active=false -> no run.
      await operator.query('BEGIN');
      await operator.query('UPDATE sources SET is_active = false WHERE id = $1', [sourceId]);
      const blockedInsert = createScheduledCollectionRun(db, {
        sourceId, scheduledFor: new Date('2026-09-28T03:00:00Z'), triggerType: 'SCHEDULED',
      });
      assert.equal(await pending(blockedInsert, 400), true, 'scheduler insert must wait for the in-flight pause');
      await operator.query('COMMIT');
      assert.equal(await blockedInsert, undefined);
      assert.equal(await runsOf(), 0, 'no run after the pause committed');

      // B) Scheduler insert in flight first: the pause waits for it, so the run
      //    exists before the pause completes and the pause/30 guards see it.
      await setActive(true);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let insertedInTx: string | undefined;
      let signalInserted!: () => void;
      const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
      const schedulerTx = db.transaction().execute(async (trx) => {
        insertedInTx = await createScheduledCollectionRun(trx, {
          sourceId, scheduledFor: new Date('2026-09-28T03:01:00Z'), triggerType: 'SCHEDULED',
        });
        signalInserted();
        await gate;
      });
      await inserted;
      assert.ok(insertedInTx);
      const pause = operator.query('UPDATE sources SET is_active = false WHERE id = $1', [sourceId]);
      assert.equal(await pending(pause, 400), true, 'pause must wait for the in-flight scheduler insert');
      release();
      await schedulerTx;
      await pause;
      const active = await operator.query(
        "SELECT count(*)::int AS n FROM collection_runs WHERE source_id = $1 AND status IN ('PENDING', 'RUNNING')",
        [sourceId],
      );
      assert.equal(active.rows[0].n, 1, 'the run created before the pause is visible to the active-run guard');

      // C) After the pause, a full scheduler tick creates nothing for the source.
      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
      const tick = await runSchedulerTick(db, new Date('2026-09-28T03:02:00Z'));
      assert.equal(tick.runIds.length, 0);
      assert.equal(
        await createScheduledCollectionRun(db, { sourceId, scheduledFor: new Date('2026-09-28T03:03:00Z'), triggerType: 'SCHEDULED' }),
        undefined,
      );
      assert.equal(await runsOf(), 0, '0 runs created after the pause');
    } finally {
      await operator.query('ROLLBACK').catch(() => undefined);
      operator.release();
      await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
      await db.deleteFrom('sources').where('id', '=', sourceId).execute();
      await db.destroy();
    }
  },
);
