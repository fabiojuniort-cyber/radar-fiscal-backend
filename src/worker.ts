import { collectionRuntimeEnv as env } from './config/collection-runtime-env.js';
import {
  acquireNextCollectionRun,
} from './modules/collection/collection-run.repository.js';
import {
  processAcquiredCollectionRun,
} from './modules/collection/collection.engine.js';
import {
  buildConnectorRegistry,
} from './modules/collection/connector-registry.factory.js';
import {
  assertStandaloneDatabaseConnection,
  createStandaloneDatabase,
} from './infrastructure/database/standalone-client.js';
import { processLogger } from './infrastructure/logging/process-logger.js';

let stopping = false;

function requestShutdown(signal: string): void {
  stopping = true;

  processLogger.info(
    { signal },
    'Collection worker shutdown requested',
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
        'Collection worker PostgreSQL pool error',
      );
    },
  });

  try {
    await assertStandaloneDatabaseConnection(db);

    const registry = buildConnectorRegistry({
      includeSimulated:
        env.COLLECTION_ENABLE_SIMULATED_CONNECTORS,
    });

    processLogger.info(
      {
        workerId: env.COLLECTION_WORKER_ID,
        pollIntervalMs:
          env.COLLECTION_POLL_INTERVAL_MS,
        collectionTimeoutMs:
          env.COLLECTION_TIMEOUT_MS,
        staleAfterMs:
          env.COLLECTION_STALE_AFTER_MS,
        simulatedConnectors:
          env.COLLECTION_ENABLE_SIMULATED_CONNECTORS,
      },
      'Collection worker started',
    );

    while (!stopping) {
      try {
        const acquired =
          await acquireNextCollectionRun(
            db,
            env.COLLECTION_WORKER_ID,
            {
              staleAfterMs:
                env.COLLECTION_STALE_AFTER_MS,
            },
          );

        if (!acquired) {
          await sleep(
            env.COLLECTION_POLL_INTERVAL_MS,
          );
          continue;
        }

        await processAcquiredCollectionRun(
          db,
          registry,
          acquired,
          {
            timeoutMs:
              env.COLLECTION_TIMEOUT_MS,
            heartbeatIntervalMs:
              env.COLLECTION_HEARTBEAT_INTERVAL_MS,
            logger: processLogger,
          },
        );
      } catch (error) {
        processLogger.error(
          {
            workerId:
              env.COLLECTION_WORKER_ID,
            error:
              error instanceof Error
                ? error.message
                : 'Unknown worker error',
          },
          'Collection worker iteration failed',
        );

        if (!stopping) {
          await sleep(
            env.COLLECTION_POLL_INTERVAL_MS,
          );
        }
      }
    }
  } finally {
    await db.destroy();

    processLogger.info(
      {
        workerId: env.COLLECTION_WORKER_ID,
      },
      'Collection worker stopped',
    );
  }
}

run().catch((error: unknown) => {
  processLogger.fatal(
    {
      error:
        error instanceof Error
          ? error.message
          : 'Unknown worker startup error',
    },
    'Collection worker failed',
  );
  process.exit(1);
});
