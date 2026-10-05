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
import { isCronDue } from './modules/collection/cron.js';
import { runDouBackfillTick } from './modules/collection/dou-backfill.js';
import {
  processPublicationNcmEnrichmentBatch,
} from './modules/taxonomy/ncm/publication-ncm.detector.js';
import {
  processPublicationTaxonomyBatch,
} from './modules/taxonomy/classification/classification.worker.js';
import {
  assertStandaloneDatabaseConnection,
  assertWorkerRuntimeConnection,
  createStandaloneDatabase,
} from './infrastructure/database/standalone-client.js';
import { processLogger } from './infrastructure/logging/process-logger.js';

let stopping = false;

const NCM_IDLE_BATCH_SIZE = 10;
const NCM_AFTER_COLLECTION_BATCH_SIZE = 5;
// TAX-11: classification runs only while the curator keeps it enabled.
const TAXONOMY_IDLE_BATCH_SIZE = 20;
const TAXONOMY_AFTER_COLLECTION_BATCH_SIZE = 10;

// DOU administrative backfill (D-056): evaluated while idle, at most every
// few minutes; the database throttle keeps it to one run per interval across
// all Worker replicas.
const DOU_BACKFILL_CHECK_MS = 5 * 60_000;
let douBackfillComplete = false;
let douBackfillNextCheckAt = 0;

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

async function backfillDou(
  db: ReturnType<typeof createStandaloneDatabase>,
): Promise<void> {
  if (!env.DOU_BACKFILL_FROM || douBackfillComplete) return;
  if (
    process.env.DOU_CONNECTOR_ENABLED !== 'true' ||
    !process.env.INLABS_EMAIL ||
    !process.env.INLABS_PASSWORD
  ) return;
  if (Date.now() < douBackfillNextCheckAt) return;
  douBackfillNextCheckAt = Date.now() + DOU_BACKFILL_CHECK_MS;

  try {
    const result = await runDouBackfillTick(db, {
      from: env.DOU_BACKFILL_FROM,
      datesPerRun: env.DOU_BACKFILL_DATES_PER_RUN,
      minIntervalMs: env.DOU_BACKFILL_INTERVAL_MS,
      workerId: env.COLLECTION_WORKER_ID,
      credentials: () => ({
        email: process.env.INLABS_EMAIL!,
        password: process.env.INLABS_PASSWORD!,
      }),
      timeoutMs: env.COLLECTION_TIMEOUT_MS,
      ...(env.COLLECTION_BUDGET_GRACE_MS !== undefined
        ? { budgetGraceMs: env.COLLECTION_BUDGET_GRACE_MS }
        : {}),
      heartbeatIntervalMs: env.COLLECTION_HEARTBEAT_INTERVAL_MS,
      logger: processLogger,
      isCronDue,
    });
    if (result.state === 'COMPLETE') {
      douBackfillComplete = true;
      processLogger.info(
        { from: env.DOU_BACKFILL_FROM },
        'DOU backfill complete; DOU_BACKFILL_FROM can be removed',
      );
    } else if (result.state === 'RAN') {
      processLogger.info(
        {
          runId: result.batch.runId,
          dates: result.batch.dates,
          attempts: result.batch.attempts,
          status: result.batch.retryLimitReached
            ? 'SOURCE_UNAVAILABLE'
            : result.batch.result.status,
          metrics: result.batch.result.metrics,
          remainingDates: result.remainingDates,
        },
        'DOU backfill batch completed',
      );
    }
  } catch (error) {
    processLogger.warn(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown DOU backfill error',
      },
      'DOU backfill tick failed',
    );
  }
}

async function enrichPublicationNcms(
  db: ReturnType<typeof createStandaloneDatabase>,
  limit: number,
): Promise<void> {
  try {
    const result = await processPublicationNcmEnrichmentBatch(
      db,
      { limit },
    );

    if (result.selected > 0) {
      processLogger.info(
        {
          selected: result.selected,
          succeeded: result.succeeded,
          failed: result.failed,
          candidates: result.candidates,
          matches: result.matches,
        },
        'Publication NCM enrichment batch completed',
      );
    }
  } catch (error) {
    processLogger.warn(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown NCM enrichment error',
      },
      'Publication NCM enrichment batch failed',
    );
  }
}

async function classifyPublications(
  db: ReturnType<typeof createStandaloneDatabase>,
  limit: number,
): Promise<void> {
  try {
    const result = await processPublicationTaxonomyBatch(db, {
      limit,
      codeGitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    });

    if (result.selected > 0) {
      processLogger.info(
        {
          releaseId: result.releaseId,
          selected: result.selected,
          succeeded: result.succeeded,
          failed: result.failed,
          assertions: result.assertions,
        },
        'Publication taxonomy classification batch completed',
      );
    }
  } catch (error) {
    processLogger.warn(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown taxonomy classification error',
      },
      'Publication taxonomy classification batch failed',
    );
  }
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
    await assertWorkerRuntimeConnection(db);

    const registry = buildConnectorRegistry({
      includeSimulated:
        env.COLLECTION_ENABLE_SIMULATED_CONNECTORS,
      db,
    });

    processLogger.info(
      {
        workerId: env.COLLECTION_WORKER_ID,
        pollIntervalMs:
          env.COLLECTION_POLL_INTERVAL_MS,
        collectionTimeoutMs:
          env.COLLECTION_TIMEOUT_MS,
        budgetGraceMs:
          env.COLLECTION_BUDGET_GRACE_MS ?? null,
        staleAfterMs:
          env.COLLECTION_STALE_AFTER_MS,
        simulatedConnectors:
          env.COLLECTION_ENABLE_SIMULATED_CONNECTORS,
        ncmIdleBatchSize: NCM_IDLE_BATCH_SIZE,
        ncmAfterCollectionBatchSize:
          NCM_AFTER_COLLECTION_BATCH_SIZE,
        taxonomyIdleBatchSize: TAXONOMY_IDLE_BATCH_SIZE,
        taxonomyAfterCollectionBatchSize:
          TAXONOMY_AFTER_COLLECTION_BATCH_SIZE,
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
          await backfillDou(db);
          await enrichPublicationNcms(
            db,
            NCM_IDLE_BATCH_SIZE,
          );
          await classifyPublications(
            db,
            TAXONOMY_IDLE_BATCH_SIZE,
          );
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
            ...(env.COLLECTION_BUDGET_GRACE_MS !== undefined
              ? { budgetGraceMs: env.COLLECTION_BUDGET_GRACE_MS }
              : {}),
            heartbeatIntervalMs:
              env.COLLECTION_HEARTBEAT_INTERVAL_MS,
            logger: processLogger,
          },
        );

        await enrichPublicationNcms(
          db,
          NCM_AFTER_COLLECTION_BATCH_SIZE,
        );
        await classifyPublications(
          db,
          TAXONOMY_AFTER_COLLECTION_BATCH_SIZE,
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
