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
  createCollectionRun,
  finishCollectionAttempt,
  finishCollectionRun,
  heartbeatCollectionRun,
  scheduleCollectionRetry,
  startCollectionAttempt,
} from '../src/modules/collection/collection-run.repository.js';

test(
  'collection run lifecycle is idempotent, retryable and concurrency-safe',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for collection lifecycle integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 4,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const sourceId = randomUUID();
    const scheduledFor = new Date(
      '2026-09-19T09:00:00Z',
    );

    let runId: string | undefined;

    try {
      await db
        .insertInto('sources')
        .values({
          id: sourceId,
          code: `lifecycle-source-${sourceId}`,
          name: 'Collection Lifecycle Source',
          jurisdiction_level: 'FEDERAL',
          base_url:
            'https://lifecycle.example.test',
          connector_key:
            `lifecycle-connector-${sourceId}`,
          max_attempts: 3,
        })
        .execute();

      const created = await createCollectionRun(db, {
        sourceId,
        scheduledFor,
        triggerType: 'SCHEDULED',
      });

      const repeated = await createCollectionRun(db, {
        sourceId,
        scheduledFor,
        triggerType: 'SCHEDULED',
      });

      runId = created;

      assert.equal(repeated, created);

      const runCount = await db
        .selectFrom('collection_runs')
        .select(({ fn }) =>
          fn.countAll<number>().as('count'),
        )
        .where('source_id', '=', sourceId)
        .executeTakeFirstOrThrow();

      assert.equal(Number(runCount.count), 1);

      const [workerA, workerB] = await Promise.all([
        acquireNextCollectionRun(db, 'worker-a'),
        acquireNextCollectionRun(db, 'worker-b'),
      ]);

      const acquisitions = [workerA, workerB].filter(
        (value) => value !== null,
      );

      assert.equal(acquisitions.length, 1);

      const acquired = acquisitions[0]!;

      assert.equal(acquired.id, runId);
      assert.equal(acquired.maxAttempts, 3);

      const otherWorker =
        acquired.workerId === 'worker-a'
          ? 'worker-b'
          : 'worker-a';

      const noSecondOwner =
        await acquireNextCollectionRun(
          db,
          otherWorker,
        );

      assert.equal(noSecondOwner, null);

      assert.equal(
        await heartbeatCollectionRun(
          db,
          runId,
          acquired.workerId,
        ),
        true,
      );

      assert.equal(
        await heartbeatCollectionRun(
          db,
          runId,
          otherWorker,
        ),
        false,
      );

      const firstAttempt =
        await startCollectionAttempt(
          db,
          runId,
          acquired.workerId,
          'test-v1',
        );

      assert.equal(firstAttempt.attemptNo, 1);

      await assert.rejects(
        () =>
          startCollectionAttempt(
            db,
            runId!,
            otherWorker,
          ),
        /not owned by this worker/,
      );

      await finishCollectionAttempt(db, {
        attemptId: firstAttempt.id,
        outcome: {
          ok: false,
          status: 'TIMEOUT',
          durationMs: 123,
          code: 'CONNECTOR_TIMEOUT',
          message: 'Connector execution timed out',
          retryable: true,
        },
      });

      await scheduleCollectionRetry(db, {
        runId,
        workerId: acquired.workerId,
        nextAttemptAt: new Date(
          Date.now() - 1_000,
        ),
        errorSummary:
          'Attempt 1 timed out; retry scheduled.',
      });

      const reacquired =
        await acquireNextCollectionRun(
          db,
          otherWorker,
        );

      assert.ok(reacquired);
      assert.equal(reacquired.id, runId);
      assert.equal(
        reacquired.workerId,
        otherWorker,
      );

      const secondAttempt =
        await startCollectionAttempt(
          db,
          runId,
          otherWorker,
          'test-v1',
        );

      assert.equal(secondAttempt.attemptNo, 2);

      await finishCollectionAttempt(db, {
        attemptId: secondAttempt.id,
        outcome: {
          ok: true,
          status: 'SUCCESS',
          durationMs: 45,
          result: {
            publications: [],
          },
        },
      });

      await assert.rejects(
        () =>
          finishCollectionRun(db, {
            runId: runId!,
            workerId: acquired.workerId,
            status: 'SUCCESS_NO_RESULTS',
          }),
        /not owned by this worker/,
      );

      await finishCollectionRun(db, {
        runId,
        workerId: otherWorker,
        status: 'SUCCESS_NO_RESULTS',
      });

      const closedRun = await db
        .selectFrom('collection_runs')
        .select([
          'status',
          'worker_id',
          'locked_at',
          'heartbeat_at',
          'next_attempt_at',
          'finished_at',
          'source_consulted_at',
        ])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();

      assert.equal(
        closedRun.status,
        'SUCCESS_NO_RESULTS',
      );
      assert.equal(closedRun.worker_id, null);
      assert.equal(closedRun.locked_at, null);
      assert.equal(closedRun.heartbeat_at, null);
      assert.equal(closedRun.next_attempt_at, null);
      assert.ok(closedRun.finished_at);
      assert.ok(closedRun.source_consulted_at);

      const attempts = await db
        .selectFrom('collection_attempts')
        .select([
          'attempt_no',
          'status',
          'retryable',
          'error_code',
        ])
        .where('collection_run_id', '=', runId)
        .orderBy('attempt_no')
        .execute();

      assert.deepEqual(attempts, [
        {
          attempt_no: 1,
          status: 'TIMEOUT',
          retryable: true,
          error_code: 'CONNECTOR_TIMEOUT',
        },
        {
          attempt_no: 2,
          status: 'SUCCESS',
          retryable: false,
          error_code: null,
        },
      ]);

      const noClosedRun =
        await acquireNextCollectionRun(
          db,
          'worker-c',
        );

      assert.equal(noClosedRun, null);
    } finally {
      if (runId) {
        await db
          .deleteFrom('collection_runs')
          .where('id', '=', runId)
          .execute();
      }

      await db
        .deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();

      await db.destroy();
    }
  },
);


test(
  'DOE-SP persists only allowlisted bounded HTTP diagnostics on partial success',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for collection lifecycle integration tests.',
    );

    const pool = new Pool({
      connectionString: adminUrl,
      max: 2,
    });

    const db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
    });

    const sourceId = randomUUID();
    let runId: string | undefined;

    try {
      await db
        .insertInto('sources')
        .values({
          id: sourceId,
          code: `doe-sp-diagnostics-${sourceId}`,
          name: 'DOE-SP safe diagnostics fixture',
          jurisdiction_level: 'STATE',
          uf: 'SP',
          base_url: 'https://doe.sp.gov.br/',
          connector_key: 'doe-sp',
          max_attempts: 1,
        })
        .execute();

      runId = await createCollectionRun(db, {
        sourceId,
        scheduledFor: new Date(Date.now() - 60_000),
        triggerType: 'MANUAL',
      });

      const acquired =
        await acquireNextCollectionRun(
          db,
          `doe-sp-diagnostics-worker-${sourceId}`,
        );

      assert.ok(acquired);
      assert.equal(acquired.id, runId);

      const attempt =
        await startCollectionAttempt(
          db,
          runId,
          acquired.workerId,
          'test-v1',
        );

      const itemIds = Array.from(
        { length: 7 },
        () => randomUUID(),
      );

      const sensitiveSample =
        'password=TOP_SECRET token=' +
        'A'.repeat(120) +
        ' visible=' +
        'Z'.repeat(320);

      const httpFailures = itemIds.map(
        (itemId, index) => ({
          code: 'DOE_SP_HTTP_ERROR',
          message:
            index === 0
              ? 'DROP_ME [status=403; endpoint=/v2/authentication/download/{authCode}; contentType=application/problem+json; responseSample=' +
                JSON.stringify(sensitiveSample) +
                ']'
              : `HTTP error [status=403; endpoint=/v2/authentication/download/{authCode}; contentType=application/problem+json; responseSample=${JSON.stringify(`safe-${index}`)}]`,
          itemReference:
            `2025-07-29#${itemId}`,
        }),
      );

      await finishCollectionAttempt(db, {
        attemptId: attempt.id,
        connectorKey: 'doe-sp',
        outcome: {
          ok: true,
          status: 'SUCCESS',
          durationMs: 25,
          result: {
            publications: [],
            partialFailures: [
              ...httpFailures,
              {
                code: 'DOE_SP_HTTP_ERROR',
                message:
                  'HTTP error [status=403; endpoint=/not-allowed; contentType=text/plain; responseSample="SHOULD_NOT_PERSIST"]',
                itemReference:
                  `2025-07-29#${randomUUID()}`,
              },
              {
                code: 'OTHER_CONNECTOR_FAILURE',
                message:
                  'password=OTHER_SECRET token=OTHER_TOKEN',
                itemReference: 'untrusted value',
              },
            ],
          },
        },
      });

      const row = await db
        .selectFrom('collection_attempts')
        .select(['status', 'metadata'])
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();

      assert.equal(row.status, 'SUCCESS');

      const metadata =
        row.metadata as Record<string, unknown>;
      const diagnostics =
        metadata.doeSpHttpDiagnostics as
          | Array<Record<string, unknown>>
          | undefined;

      assert.ok(diagnostics);
      assert.equal(diagnostics.length, 5);

      const first = diagnostics[0]!;
      assert.deepEqual(
        Object.keys(first).sort(),
        [
          'contentType',
          'endpoint',
          'httpStatus',
          'itemReference',
          'responseSample',
        ].sort(),
      );
      assert.equal(first.httpStatus, 403);
      assert.equal(
        first.endpoint,
        '/v2/authentication/download/{authCode}',
      );
      assert.equal(
        first.contentType,
        'application/problem+json',
      );
      assert.match(
        String(first.itemReference),
        /^2025-07-29#[0-9a-f-]{36}$/,
      );

      const sample = String(first.responseSample);
      assert.ok(sample.length <= 240);
      assert.ok(!sample.includes('TOP_SECRET'));
      assert.ok(!sample.includes('A'.repeat(80)));

      const serialized = JSON.stringify(metadata);
      assert.ok(!serialized.includes('DROP_ME'));
      assert.ok(
        !serialized.includes('SHOULD_NOT_PERSIST'),
      );
      assert.ok(!serialized.includes('OTHER_SECRET'));
      assert.ok(!serialized.includes('OTHER_TOKEN'));
      assert.equal(
        metadata.partialFailureCount,
        httpFailures.length + 2,
      );
    } finally {
      if (runId) {
        await db
          .deleteFrom('collection_runs')
          .where('id', '=', runId)
          .execute();
      }

      await db
        .deleteFrom('sources')
        .where('id', '=', sourceId)
        .execute();

      await db.destroy();
    }
  },
);
