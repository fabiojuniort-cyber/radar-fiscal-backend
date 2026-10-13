import 'dotenv/config';
import { hostname } from 'node:os';

import { z } from 'zod';

const databaseUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('postgres://') ||
      value.startsWith('postgresql://'),
    'Database URL must start with postgres:// or postgresql://',
  );

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: databaseUrlSchema,

  LOG_LEVEL: z
    .enum([
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
      'silent',
    ])
    .default('info'),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5),

  DB_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(10_000),

  DB_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .default(5_000),

  COLLECTION_WORKER_ID: z.string().min(1).optional(),

  COLLECTION_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(1_000),

  COLLECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(30_000),

  // Optional graceful-yield window before the hard timeout. Unset = default
  // (15% of the timeout, at least 2 min, at most half of it).
  COLLECTION_BUDGET_GRACE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .optional(),

  // Optional storage telemetry (Scheduler). Capacity of the PostgreSQL volume
  // as provisioned on the platform; unset = alert level UNKNOWN.
  DB_VOLUME_CAPACITY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .optional(),

  // Optional dedicated monitoring connection (pg_monitor) used ONLY to measure
  // WAL. Never grant pg_monitor to the runtime roles; unset = WAL not measured.
  DATABASE_MONITOR_URL: databaseUrlSchema.optional(),

  CAPACITY_SNAPSHOT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(3_600_000),

  CAPACITY_SNAPSHOTS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  COLLECTION_HEARTBEAT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(15_000),

  COLLECTION_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .default(120_000),

  SCHEDULER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(30_000),

  // Source health watchdog (Scheduler). Logs "Source health alert" at error
  // level for stale sources, stuck runs and persistent partial runs.
  SOURCE_HEALTH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  SOURCE_HEALTH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(3_600_000),

  SOURCE_HEALTH_REALERT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 3_600_000),

  // DOU administrative backfill inside the Worker (D-056: one query per
  // hour, one day back per query). Unset = off. Set to the oldest date to
  // fill (YYYY-MM-DD); the Worker logs "DOU backfill complete" once nothing
  // is missing, after which the variable can be removed.
  // Validated where it is used: an invalid value disables the backfill
  // (logged) instead of stopping the Worker at startup.
  DOU_BACKFILL_FROM: z
    .string()
    .trim()
    .optional(),

  DOU_BACKFILL_DATES_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1),

  DOU_BACKFILL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(600_000)
    .default(3_600_000),

  COLLECTION_ENABLE_SIMULATED_CONNECTORS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Operational kill switch for automatic NCM background scans. Keep enabled
  // by default; R3 deploys may pause it explicitly to avoid an unplanned
  // detector-version rescan while collection and the rest of the Worker stay live.
  PUBLICATION_NCM_ENRICHMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid collection runtime configuration.',
    parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'environment',
      message: issue.message,
    })),
  );
  process.exit(1);
}

if (
  parsed.data.COLLECTION_BUDGET_GRACE_MS !== undefined &&
  parsed.data.COLLECTION_BUDGET_GRACE_MS >= parsed.data.COLLECTION_TIMEOUT_MS
) {
  console.error(
    'Invalid collection runtime configuration.',
    [{ path: 'COLLECTION_BUDGET_GRACE_MS', message: 'must be lower than COLLECTION_TIMEOUT_MS' }],
  );
  process.exit(1);
}

export const collectionRuntimeEnv = {
  ...parsed.data,
  COLLECTION_WORKER_ID:
    parsed.data.COLLECTION_WORKER_ID ??
    `${hostname()}-${process.pid}`,
};
