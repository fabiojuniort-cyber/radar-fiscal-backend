import { collectionRuntimeEnv as env } from './config/collection-runtime-env.js';
import {
  assertStandaloneDatabaseConnection,
  assertWorkerRuntimeConnection,
  createStandaloneDatabase,
} from './infrastructure/database/standalone-client.js';
import { processLogger } from './infrastructure/logging/process-logger.js';
import {
  floorToUtcMinute,
} from './modules/collection/cron.js';
import {
  runSchedulerTick,
} from './modules/collection/scheduler.service.js';

let stopping = false;

function requestShutdown(signal: string): void {
  stopping = true;

  processLogger.info(
    { signal },
    'Collection scheduler shutdown requested',
  );
}

process.once('SIGINT', () =>
  requestShutdown('SIGINT'),
);
process.once('SIGTERM', () =>
  requestShutdown('SIGTERM'),
);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function run(): Promise<void> {
  const db = createStandaloneDatabase({
    connectionString: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMs:
      env.DB_CONNECTION_TIMEOUT_MS,
    onPoolError: (error) => {
      processLogger.error(
        { error: error.message },
        'Collection scheduler PostgreSQL pool error',
      );
    },
  });

  let lastEvaluatedMinute: string | undefined;

  try {
    await assertStandaloneDatabaseConnection(db);
    await assertWorkerRuntimeConnection(db);

    processLogger.info(
      {
        pollIntervalMs:
          env.SCHEDULER_POLL_INTERVAL_MS,
      },
      'Collection scheduler started',
    );

    while (!stopping) {
      const now = new Date();
      const minute = floorToUtcMinute(
        now,
      ).toISOString();

      if (minute !== lastEvaluatedMinute) {
        try {
          const result = await runSchedulerTick(
            db,
            now,
            processLogger,
          );

          lastEvaluatedMinute = minute;

          processLogger.info(
            {
              minute,
              ...result,
            },
            'Collection scheduler tick completed',
          );
        } catch (error) {
          processLogger.error(
            {
              minute,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unknown scheduler error',
            },
            'Collection scheduler tick failed',
          );
        }
      }

      if (!stopping) {
        await sleep(
          env.SCHEDULER_POLL_INTERVAL_MS,
        );
      }
    }
  } finally {
    await db.destroy();

    processLogger.info(
      {},
      'Collection scheduler stopped',
    );
  }
}

run().catch((error: unknown) => {
  processLogger.fatal(
    {
      error:
        error instanceof Error
          ? error.message
          : 'Unknown scheduler startup error',
    },
    'Collection scheduler failed',
  );
  process.exit(1);
});
