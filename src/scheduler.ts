import { collectionRuntimeEnv as env } from './config/collection-runtime-env.js';
import {
  assertStandaloneDatabaseConnection,
  assertWorkerRuntimeConnection,
  createStandaloneDatabase,
} from './infrastructure/database/standalone-client.js';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { pruneCollectionItems } from './modules/operations/collection-items-retention.js';
import { runL17ExcludeAlways } from './modules/collection/l17-daily-always.js';

import { processLogger } from './infrastructure/logging/process-logger.js';
import { runCapacitySnapshotIfDue } from './modules/operations/db-capacity.js';
import { SourceHealthWatchdog } from './modules/operations/source-health.js';
import {
  floorToUtcMinute,
  isCronDue,
} from './modules/collection/cron.js';
import {
  runSchedulerTick,
} from './modules/collection/scheduler.service.js';

const RETENTION_CRON = '30 3 * * *';
const RETENTION_ZONE = 'America/Sao_Paulo';
const RETENTION_BATCH_SIZE = 100;
const RETENTION_MAX_BATCHES = 1000;
const RETENTION_MAX_ELAPSED_MS = 120_000;
const retentionEnabled = process.env.COLLECTION_ITEMS_RETENTION_ENABLED === 'true';

// L-10: the first dry-run is read-only and emits the exact current backlog.
// The activation flag stays false until this number is reviewed in production.
async function logRetentionDryRun(db: ReturnType<typeof createStandaloneDatabase>): Promise<void> {
  const dry = await pruneCollectionItems(db, { batchSize: 100, maxBatches: 1 });
  processLogger.info({
    mode: 'DRY_RUN', olderThanDays: 7,
    eligibleItems: dry.remainingEligible,
    sampleBatchCandidates: dry.candidateItems, cutoff: dry.cutoff,
    enabled: retentionEnabled,
  }, 'L10 collection_items retention initial dry-run');
}

async function runRetentionIfDue(
  db: ReturnType<typeof createStandaloneDatabase>, now: Date,
): Promise<void> {
  if (!retentionEnabled || !isCronDue(RETENTION_CRON, now, RETENTION_ZONE)) return;

  // Durable daily claim enforces once per local calendar date across restarts
  // and prevents multiple scheduler replicas from pruning simultaneously.
  const claim = await sql<{ claimed: boolean }>`
    SELECT public.l10_claim_retention_day() AS claimed
  `.execute(db);
  if (!claim.rows[0]?.claimed) return;

  let deletedItems = 0, batches = 0, remainingEligible = 0;
  const started = Date.now();
  try {
    while (batches < RETENTION_MAX_BATCHES &&
           Date.now() - started < RETENTION_MAX_ELAPSED_MS) {
      const result = await sql<{ deleted: number }>`
        SELECT public.l10_prune_collection_items_batch(${RETENTION_BATCH_SIZE}) AS deleted
      `.execute(db);
      const deleted = Number(result.rows[0]?.deleted ?? 0);
      if (deleted < 0 || deleted > RETENTION_BATCH_SIZE) throw new Error('l10_invalid_deleted_count');
      if (deleted === 0) break;
      deletedItems += deleted;
      batches++;
    }
    const count = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM public.collection_items
      WHERE created_at < now() - INTERVAL '7 days'
    `.execute(db);
    remainingEligible = Number(count.rows[0]?.count ?? 0);
    await sql`SELECT public.l10_finish_retention_day(
      ${deletedItems},${remainingEligible}::bigint,true
    )`.execute(db);
    processLogger.info({
      retentionLocalTime: '03:30 America/Sao_Paulo',
      olderThanDays: 7, deletedItems, remainingEligible, batches,
      maxBatches: RETENTION_MAX_BATCHES,
      stoppedByBudget: remainingEligible > 0, elapsedMs: Date.now() - started,
    }, 'L10 collection_items daily retention completed');
  } catch (error) {
    await sql`SELECT public.l10_finish_retention_day(
      ${deletedItems},${remainingEligible}::bigint,false
    )`.execute(db).catch(() => {});
    processLogger.error({
      deletedItems,batches,
      error: error instanceof Error ? error.message : 'unknown',
    }, 'L10 collection_items retention failed');
  }
}

// F3: legacy hidden cleanup is also preview-only; physical deletion requires
// the existing administrator preview/confirmation flow.
async function runHiddenIfDue(db: ReturnType<typeof createStandaloneDatabase>,now:Date):Promise<void> {
  if(!retentionEnabled||!isCronDue(RETENTION_CRON,now,RETENTION_ZONE))return;
  const result=await sql<{publication_id:string}>`SELECT publication_id FROM public.l17_cleanup_candidates(NULL,20)`.execute(db);
  processLogger.info({sampled:result.rows.length,deletedPublications:0,confirmationRequired:true},
    'L17 legacy hidden preview only');
}

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

  const sourceHealth = env.SOURCE_HEALTH_ENABLED
    ? new SourceHealthWatchdog({
        intervalMs: env.SOURCE_HEALTH_INTERVAL_MS,
        realertAfterMs: env.SOURCE_HEALTH_REALERT_MS,
        logger: processLogger,
      })
    : undefined;

  // Optional dedicated monitoring connection, used only to measure WAL.
  const monitor = env.CAPACITY_SNAPSHOTS_ENABLED && env.DATABASE_MONITOR_URL
    ? new Pool({ connectionString: env.DATABASE_MONITOR_URL, max: 1 })
    : undefined;
  monitor?.on('error', (error) => {
    processLogger.error(
      { error: error.message },
      'Capacity monitor PostgreSQL pool error',
    );
  });

  try {
    await assertStandaloneDatabaseConnection(db);
    await assertWorkerRuntimeConnection(db);

    await logRetentionDryRun(db);

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

        try {
          if(retentionEnabled && isCronDue(RETENTION_CRON,now,RETENTION_ZONE)) {
            await runL17ExcludeAlways(db,processLogger);
          }
          await runHiddenIfDue(db, now);
          await runRetentionIfDue(db, now);
        } catch (error) {
          processLogger.error({
            error: error instanceof Error ? error.message : 'unknown',
          }, 'L10 retention scheduler gate failed');
        }

        // Source health: read-only and isolated from run creation.
        if (sourceHealth) {
          try {
            await sourceHealth.runIfDue(db, now);
          } catch (error) {
            processLogger.error(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unknown source health error',
              },
              'Source health check failed',
            );
          }
        }

        // Storage telemetry: isolated from collection scheduling (a failure
        // here never affects run creation).
        if (env.CAPACITY_SNAPSHOTS_ENABLED) {
          try {
            await runCapacitySnapshotIfDue(db, {
              now,
              intervalMs: env.CAPACITY_SNAPSHOT_INTERVAL_MS,
              ...(env.DB_VOLUME_CAPACITY_BYTES !== undefined
                ? { capacityBytes: env.DB_VOLUME_CAPACITY_BYTES }
                : {}),
              ...(monitor ? { monitor } : {}),
              logger: processLogger,
            });
          } catch (error) {
            processLogger.error(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unknown capacity snapshot error',
              },
              'Database capacity snapshot failed',
            );
          }
        }
      }

      if (!stopping) {
        await sleep(
          env.SCHEDULER_POLL_INTERVAL_MS,
        );
      }
    }
  } finally {
    await monitor?.end();
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
