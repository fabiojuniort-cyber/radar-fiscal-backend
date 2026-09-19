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
  acquireNextCollectionRun,
  finishCollectionAttempt,
  finishCollectionRun,
  startCollectionAttempt,
} from '../src/modules/collection/collection-run.repository.js';

test(
  'stale worker heartbeat is recovered without losing attempt history',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for stale recovery integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const sourceId = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();

    try {
      await db
        .insertInto('sources')
        .values({
          id: sourceId,
          code: `stale-source-${sourceId}`,
          name: 'Stale Recovery Source',
          jurisdiction_level: 'FEDERAL',
          base_url: 'https://stale.example.test',
          connector_key:
            `stale-connector-${sourceId}`,
          max_attempts: 3,
        })
        .execute();

      await db
        .insertInto('collection_runs')
        .values({
          id: runId,
          source_id: sourceId,
          scheduled_for: new Date(
            Date.now() - 60_000,
          ),
          trigger_type: 'MANUAL',
          status: 'RUNNING',
          started_at: new Date(
            Date.now() - 120_000,
          ),
          worker_id: 'dead-worker',
          locked_at: new Date(
            Date.now() - 120_000,
          ),
          heartbeat_at: new Date(
            Date.now() - 120_000,
          ),
        })
        .execute();

      await db
        .insertInto('collection_attempts')
        .values({
          id: attemptId,
          collection_run_id: runId,
          attempt_no: 1,
          status: 'RUNNING',
          started_at: new Date(
            Date.now() - 120_000,
          ),
        })
        .execute();

      const recovered =
        await acquireNextCollectionRun(
          db,
          'recovery-worker',
          {
            staleAfterMs: 1_000,
          },
        );

      assert.ok(recovered);
      assert.equal(recovered.id, runId);
      assert.equal(
        recovered.workerId,
        'recovery-worker',
      );

      const staleAttempt = await db
        .selectFrom('collection_attempts')
        .select([
          'status',
          'error_code',
          'retryable',
          'finished_at',
        ])
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();

      assert.equal(
        staleAttempt.status,
        'CANCELLED',
      );
      assert.equal(
        staleAttempt.error_code,
        'STALE_WORKER_HEARTBEAT',
      );
      assert.equal(
        staleAttempt.retryable,
        true,
      );
      assert.ok(staleAttempt.finished_at);

      const secondAttempt =
        await startCollectionAttempt(
          db,
          runId,
          'recovery-worker',
        );

      assert.equal(secondAttempt.attemptNo, 2);

      await finishCollectionAttempt(db, {
        attemptId: secondAttempt.id,
        outcome: {
          ok: true,
          status: 'SUCCESS',
          durationMs: 1,
          result: {
            publications: [],
          },
        },
      });

      await finishCollectionRun(db, {
        runId,
        workerId: 'recovery-worker',
        status: 'SUCCESS_NO_RESULTS',
      });

      const attempts = await db
        .selectFrom('collection_attempts')
        .select([
          'attempt_no',
          'status',
        ])
        .where('collection_run_id', '=', runId)
        .orderBy('attempt_no')
        .execute();

      assert.deepEqual(attempts, [
        {
          attempt_no: 1,
          status: 'CANCELLED',
        },
        {
          attempt_no: 2,
          status: 'SUCCESS',
        },
      ]);
    } finally {
      await db
        .deleteFrom('collection_runs')
        .where('id', '=', runId)
        .execute();

      await db
        .deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();

      await db.destroy();
    }
  },
);
