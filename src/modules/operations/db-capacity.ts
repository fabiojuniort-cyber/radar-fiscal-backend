import { sql, type Kysely } from 'kysely';
import type { Pool } from 'pg';

import type { DB } from '../../infrastructure/database/database.types.js';

/**
 * PostgreSQL-side storage telemetry.
 *
 * This is an ESTIMATE of what PostgreSQL occupies (database + WAL). The
 * authoritative "volume is N% full" figure is the platform volume metric;
 * platform_volume_used_bytes is reserved for it and stays NULL until an
 * integration exists.
 *
 * WAL can only be listed with pg_monitor (pg_ls_waldir). That privilege is
 * never granted to the runtime roles: WAL is measured only through an optional
 * dedicated monitoring connection. Without it wal_bytes is NULL and the
 * estimate uses max_wal_size as a conservative WAL allowance.
 */
export const CAPACITY_WARNING_RATIO = 0.7;
export const CAPACITY_CRITICAL_RATIO = 0.85;
const TOP_TABLES = 10;
/** estimated_used_ratio is NUMERIC(8,4). */
const MAX_STORED_RATIO = 9999.9999;
const SNAPSHOT_LOCK_KEY = 'tribusca:db_capacity_snapshot';

export type CapacityAlertLevel = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type WalEstimateBasis = 'MEASURED' | 'MAX_WAL_SIZE';

export interface CapacityTable {
  table: string;
  totalBytes: number;
  estimatedRows: number;
}

export interface CapacityMeasurement {
  takenAt: Date;
  dbBytes: number;
  walBytes: number | null;
  walEstimateBasis: WalEstimateBasis;
  maxWalSizeBytes: number;
  estimatedPgBytes: number;
  capacityBytes: number | null;
  estimatedUsedRatio: number | null;
  alertLevel: CapacityAlertLevel;
  topTables: CapacityTable[];
  attemptsRows: number;
  publicationsRows: number;
}

export interface CapacityLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export function capacityAlertLevel(ratio: number | null): CapacityAlertLevel {
  if (ratio === null || !Number.isFinite(ratio)) return 'UNKNOWN';
  if (ratio >= CAPACITY_CRITICAL_RATIO) return 'CRITICAL';
  if (ratio >= CAPACITY_WARNING_RATIO) return 'WARNING';
  return 'OK';
}

/** WAL size through the dedicated monitoring connection, or null. */
export async function measureWalBytes(monitor: Pool | undefined): Promise<number | null> {
  if (!monitor) return null;
  try {
    const result = await monitor.query<{ bytes: string }>(
      'SELECT COALESCE(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()',
    );
    return Number(result.rows[0]?.bytes ?? 0);
  } catch {
    // Missing privilege or unreachable monitor: WAL unknown, never fatal.
    return null;
  }
}

export async function measureCapacity(
  db: Kysely<DB>,
  options: { capacityBytes?: number; monitor?: Pool; now?: Date } = {},
): Promise<CapacityMeasurement> {
  const takenAt = options.now ?? new Date();

  const base = await sql<{ db_bytes: string; max_wal_size_bytes: string }>`
    SELECT
      pg_database_size(current_database())::bigint AS db_bytes,
      pg_size_bytes(current_setting('max_wal_size'))::bigint AS max_wal_size_bytes
  `.execute(db);

  const tables = await sql<{ table_name: string; total_bytes: string; estimated_rows: string }>`
    SELECT
      c.relname AS table_name,
      pg_total_relation_size(c.oid)::bigint AS total_bytes,
      GREATEST(c.reltuples, 0)::bigint AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT ${TOP_TABLES}
  `.execute(db);

  const counts = await sql<{ attempts_rows: string; publications_rows: string }>`
    SELECT
      (SELECT count(*) FROM collection_attempts)::bigint AS attempts_rows,
      (SELECT count(*) FROM publications)::bigint AS publications_rows
  `.execute(db);

  const dbBytes = Number(base.rows[0]!.db_bytes);
  const maxWalSizeBytes = Number(base.rows[0]!.max_wal_size_bytes);
  const walBytes = await measureWalBytes(options.monitor);
  const walEstimateBasis: WalEstimateBasis = walBytes === null ? 'MAX_WAL_SIZE' : 'MEASURED';
  const estimatedPgBytes = dbBytes + (walBytes ?? maxWalSizeBytes);
  const capacityBytes = options.capacityBytes ?? null;
  const estimatedUsedRatio = capacityBytes
    ? Math.min(MAX_STORED_RATIO, Math.round((estimatedPgBytes / capacityBytes) * 10_000) / 10_000)
    : null;

  return {
    takenAt,
    dbBytes,
    walBytes,
    walEstimateBasis,
    maxWalSizeBytes,
    estimatedPgBytes,
    capacityBytes,
    estimatedUsedRatio,
    alertLevel: capacityAlertLevel(estimatedUsedRatio),
    topTables: tables.rows.map((row) => ({
      table: row.table_name,
      totalBytes: Number(row.total_bytes),
      estimatedRows: Number(row.estimated_rows),
    })),
    attemptsRows: Number(counts.rows[0]!.attempts_rows),
    publicationsRows: Number(counts.rows[0]!.publications_rows),
  };
}

export async function insertCapacitySnapshot(
  db: Kysely<DB>,
  measurement: CapacityMeasurement,
): Promise<string> {
  const row = await db
    .insertInto('db_capacity_snapshots')
    .values({
      taken_at: measurement.takenAt,
      db_bytes: measurement.dbBytes,
      wal_bytes: measurement.walBytes,
      wal_estimate_basis: measurement.walEstimateBasis,
      estimated_pg_bytes: measurement.estimatedPgBytes,
      capacity_bytes: measurement.capacityBytes,
      estimated_used_ratio: measurement.estimatedUsedRatio,
      platform_volume_used_bytes: null,
      top_tables: JSON.stringify(measurement.topTables),
      attempts_rows: measurement.attemptsRows,
      publications_rows: measurement.publicationsRows,
      alert_level: measurement.alertLevel,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export function logCapacity(
  logger: CapacityLogger,
  measurement: CapacityMeasurement,
  snapshotId?: string,
): void {
  const bindings = {
    event: 'db_capacity_snapshot',
    snapshotId: snapshotId ?? null,
    alertLevel: measurement.alertLevel,
    alertCode: measurement.alertLevel === 'CRITICAL'
      ? 'DB_CAPACITY_CRITICAL'
      : measurement.alertLevel === 'WARNING'
        ? 'DB_CAPACITY_WARNING'
        : null,
    dbBytes: measurement.dbBytes,
    walBytes: measurement.walBytes,
    walEstimateBasis: measurement.walEstimateBasis,
    estimatedPgBytes: measurement.estimatedPgBytes,
    capacityBytes: measurement.capacityBytes,
    estimatedUsedRatio: measurement.estimatedUsedRatio,
    attemptsRows: measurement.attemptsRows,
    publicationsRows: measurement.publicationsRows,
    topTables: measurement.topTables.slice(0, 5),
  };
  if (measurement.alertLevel === 'CRITICAL') {
    logger.error(bindings, 'Database capacity CRITICAL (estimated PostgreSQL usage)');
  } else if (measurement.alertLevel === 'WARNING') {
    logger.warn(bindings, 'Database capacity WARNING (estimated PostgreSQL usage)');
  } else {
    logger.info(bindings, 'Database capacity snapshot');
  }
}

export interface CapacitySnapshotOptions {
  intervalMs: number;
  capacityBytes?: number;
  monitor?: Pool;
  logger: CapacityLogger;
  now?: Date;
}

/**
 * Takes a snapshot when the last one is older than intervalMs. Safe with more
 * than one scheduler: the decision runs under a transaction-scoped advisory
 * lock (a concurrent caller simply skips).
 */
export async function runCapacitySnapshotIfDue(
  db: Kysely<DB>,
  options: CapacitySnapshotOptions,
): Promise<{ taken: boolean; snapshotId?: string; alertLevel?: CapacityAlertLevel }> {
  const now = options.now ?? new Date();
  return db.transaction().execute(async (trx) => {
    const lock = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${SNAPSHOT_LOCK_KEY}, 0)) AS locked
    `.execute(trx);
    if (!lock.rows[0]?.locked) return { taken: false };

    const last = await trx
      .selectFrom('db_capacity_snapshots')
      .select(sql<Date | null>`max(taken_at)`.as('taken_at'))
      .executeTakeFirst();
    const lastAt = last?.taken_at ? new Date(last.taken_at).getTime() : undefined;
    if (lastAt !== undefined && now.getTime() - lastAt < options.intervalMs) {
      return { taken: false };
    }

    const measurement = await measureCapacity(trx, {
      now,
      ...(options.capacityBytes !== undefined ? { capacityBytes: options.capacityBytes } : {}),
      ...(options.monitor ? { monitor: options.monitor } : {}),
    });
    const snapshotId = await insertCapacitySnapshot(trx, measurement);
    logCapacity(options.logger, measurement, snapshotId);
    return { taken: true, snapshotId, alertLevel: measurement.alertLevel };
  });
}
