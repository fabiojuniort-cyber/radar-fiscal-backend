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
  getSourceOperationalSnapshot,
} from '../src/modules/collection/collection-monitoring.repository.js';

test(
  'source operational snapshot distinguishes not consulted and successful collection metrics',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for monitoring integration tests.',
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
          code: `monitoring-source-${sourceId}`,
          name: 'Monitoring Source',
          jurisdiction_level: 'FEDERAL',
          base_url:
            'https://monitoring.example.test',
          connector_key:
            `monitoring-connector-${sourceId}`,
        })
        .execute();

      const before =
        await getSourceOperationalSnapshot(
          db,
          sourceId,
        );

      assert.equal(
        before.operationalState,
        'NOT_YET_CONSULTED',
      );
      assert.equal(before.latestRunId, null);
      assert.equal(before.foundItems, 0);

      await db
        .insertInto('collection_runs')
        .values({
          id: runId,
          source_id: sourceId,
          scheduled_for: new Date(
            '2026-09-19T12:00:00Z',
          ),
          trigger_type: 'MANUAL',
          status: 'SUCCESS',
          started_at: new Date(
            '2026-09-19T12:00:00Z',
          ),
          finished_at: new Date(
            '2026-09-19T12:00:01Z',
          ),
          source_consulted_at: new Date(
            '2026-09-19T12:00:01Z',
          ),
        })
        .execute();

      await db
        .insertInto('collection_attempts')
        .values({
          id: attemptId,
          collection_run_id: runId,
          attempt_no: 1,
          status: 'SUCCESS',
          started_at: new Date(
            '2026-09-19T12:00:00Z',
          ),
          finished_at: new Date(
            '2026-09-19T12:00:01Z',
          ),
          response_time_ms: 1000,
        })
        .execute();

      await db
        .insertInto('collection_items')
        .values([
          {
            collection_run_id: runId,
            first_attempt_id: attemptId,
            source_item_key: 'new-item',
            status: 'PROCESSED_NEW',
          },
          {
            collection_run_id: runId,
            first_attempt_id: attemptId,
            source_item_key: 'existing-item',
            status: 'PROCESSED_EXISTING',
          },
          {
            collection_run_id: runId,
            first_attempt_id: attemptId,
            source_item_key: 'failed-item',
            status: 'FAILED',
            error_code: 'TEST_ERROR',
            error_message: 'Test failure',
          },
        ])
        .execute();

      const after =
        await getSourceOperationalSnapshot(
          db,
          sourceId,
        );

      assert.equal(
        after.operationalState,
        'OPERATIONAL',
      );
      assert.equal(after.latestRunId, runId);
      assert.equal(after.foundItems, 3);
      assert.equal(after.processedItems, 2);
      assert.equal(after.newPublications, 1);
      assert.equal(
        after.existingPublications,
        1,
      );
      assert.equal(after.itemErrors, 1);
      assert.equal(after.attemptCount, 1);
      assert.equal(after.retryCount, 0);
      assert.equal(after.lastDurationMs, 1000);
      assert.ok(after.lastSuccessAt);
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
