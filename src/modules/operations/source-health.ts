import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';

/**
 * Source health watchdog.
 *
 * The collection engine records every run faithfully, but nothing looked at
 * those records: in September 2026 the DOU run stayed in persistent retry for
 * ~6 days (9.651 attempts) and a SPED item failed every hour without anyone
 * noticing. This module turns the existing run history into explicit alerts.
 * It only reads; it never changes sources, runs or schedules.
 */

export type SourceHealthAlertKind =
  | 'STALE_SOURCE'
  | 'STUCK_RUN'
  | 'PERSISTENT_PARTIAL';

export interface SourceHealthThresholds {
  /** No run that actually consulted the source (SUCCESS, SUCCESS_NO_RESULTS or PARTIAL_SUCCESS) for this long. */
  staleAfterHours: number;
  /** An open run with at least this many attempts. */
  stuckRunAttempts: number;
  /** An open run started at least this long ago. */
  stuckRunHours: number;
  /** This many most recent finished runs are all PARTIAL_SUCCESS. */
  persistentPartialRuns: number;
}

export const DEFAULT_SOURCE_HEALTH_THRESHOLDS: SourceHealthThresholds = {
  staleAfterHours: 24,
  stuckRunAttempts: 20,
  stuckRunHours: 6,
  persistentPartialRuns: 6,
};

export interface SourceHealthRow {
  sourceId: string;
  sourceCode: string;
  sourceCreatedAt: Date;
  lastConsultedAt: Date | null;
  lastFinishedStatus: string | null;
  lastFinishedError: string | null;
  openRunId: string | null;
  openRunStartedAt: Date | null;
  openRunAttempts: number;
  openRunLastError: string | null;
  recentFinishedStatuses: string[];
}

export interface SourceHealthAlert {
  kind: SourceHealthAlertKind;
  sourceId: string;
  sourceCode: string;
  detail: Record<string, unknown>;
}

export interface SourceHealthReport {
  checkedAt: Date;
  checkedSources: number;
  alerts: SourceHealthAlert[];
}

const HOUR_MS = 3_600_000;

function hoursBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / HOUR_MS) * 10) / 10;
}

function truncate(value: string | null, max = 300): string | null {
  return value && value.length > max ? `${value.slice(0, max)}…` : value;
}

export function evaluateSourceHealth(
  rows: readonly SourceHealthRow[],
  now: Date,
  thresholds: SourceHealthThresholds = DEFAULT_SOURCE_HEALTH_THRESHOLDS,
): SourceHealthReport {
  const alerts: SourceHealthAlert[] = [];

  for (const row of rows) {
    // A source created recently is not stale just because it never ran yet.
    const reference = row.lastConsultedAt ?? row.sourceCreatedAt;
    const hoursSinceConsulted = hoursBetween(reference, now);
    if (hoursSinceConsulted >= thresholds.staleAfterHours) {
      alerts.push({
        kind: 'STALE_SOURCE',
        sourceId: row.sourceId,
        sourceCode: row.sourceCode,
        detail: {
          lastConsultedAt: row.lastConsultedAt?.toISOString() ?? null,
          hoursSinceConsulted,
          lastFinishedStatus: row.lastFinishedStatus,
          lastError: truncate(row.lastFinishedError ?? row.openRunLastError),
          thresholdHours: thresholds.staleAfterHours,
        },
      });
    }

    if (row.openRunId && row.openRunStartedAt) {
      const openHours = hoursBetween(row.openRunStartedAt, now);
      if (
        row.openRunAttempts >= thresholds.stuckRunAttempts ||
        openHours >= thresholds.stuckRunHours
      ) {
        alerts.push({
          kind: 'STUCK_RUN',
          sourceId: row.sourceId,
          sourceCode: row.sourceCode,
          detail: {
            runId: row.openRunId,
            startedAt: row.openRunStartedAt.toISOString(),
            openHours,
            attempts: row.openRunAttempts,
            lastError: truncate(row.openRunLastError),
            thresholdAttempts: thresholds.stuckRunAttempts,
            thresholdHours: thresholds.stuckRunHours,
          },
        });
      }
    }

    const recent = row.recentFinishedStatuses.slice(0, thresholds.persistentPartialRuns);
    if (
      thresholds.persistentPartialRuns > 0 &&
      recent.length >= thresholds.persistentPartialRuns &&
      recent.every((status) => status === 'PARTIAL_SUCCESS')
    ) {
      alerts.push({
        kind: 'PERSISTENT_PARTIAL',
        sourceId: row.sourceId,
        sourceCode: row.sourceCode,
        detail: {
          consecutivePartialRuns: recent.length,
          lastError: truncate(row.lastFinishedError),
        },
      });
    }
  }

  return { checkedAt: now, checkedSources: rows.length, alerts };
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Reads the minimal run history needed by the watchdog for every active,
 * scheduled source. Read-only; bounded per source.
 */
export async function readSourceHealthRows(
  db: Kysely<DB>,
  recentRuns: number = DEFAULT_SOURCE_HEALTH_THRESHOLDS.persistentPartialRuns,
): Promise<SourceHealthRow[]> {
  const result = await sql<{
    source_id: string;
    source_code: string;
    source_created_at: Date;
    last_consulted_at: Date | null;
    last_finished_status: string | null;
    last_finished_error: string | null;
    open_run_id: string | null;
    open_run_started_at: Date | null;
    open_run_attempts: number | null;
    open_run_last_error: string | null;
    recent_statuses: string[] | null;
  }>`
    SELECT
      s.id AS source_id,
      s.code AS source_code,
      s.created_at AS source_created_at,
      (
        SELECT MAX(cr.finished_at)
        FROM collection_runs cr
        WHERE cr.source_id = s.id
          AND cr.status IN ('SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS')
      ) AS last_consulted_at,
      last_finished.status AS last_finished_status,
      last_finished.error_summary AS last_finished_error,
      open_run.id AS open_run_id,
      open_run.started_at AS open_run_started_at,
      (
        SELECT MAX(ca.attempt_no)
        FROM collection_attempts ca
        WHERE ca.collection_run_id = open_run.id
      ) AS open_run_attempts,
      open_run.error_summary AS open_run_last_error,
      (
        SELECT ARRAY_AGG(recent.status ORDER BY recent.finished_at DESC)
        FROM (
          SELECT cr.status, cr.finished_at
          FROM collection_runs cr
          WHERE cr.source_id = s.id
            AND cr.finished_at IS NOT NULL
          ORDER BY cr.finished_at DESC
          LIMIT ${recentRuns}
        ) recent
      ) AS recent_statuses
    FROM sources s
    LEFT JOIN LATERAL (
      SELECT cr.status, cr.error_summary
      FROM collection_runs cr
      WHERE cr.source_id = s.id
        AND cr.finished_at IS NOT NULL
      ORDER BY cr.finished_at DESC
      LIMIT 1
    ) last_finished ON TRUE
    LEFT JOIN LATERAL (
      SELECT cr.id, cr.started_at, cr.error_summary
      FROM collection_runs cr
      WHERE cr.source_id = s.id
        AND cr.status IN ('PENDING', 'RUNNING')
        AND cr.started_at IS NOT NULL
      ORDER BY cr.started_at ASC
      LIMIT 1
    ) open_run ON TRUE
    WHERE s.is_active = TRUE
      AND s.schedule_cron IS NOT NULL
    ORDER BY s.code
  `.execute(db);

  return result.rows.map((row) => ({
    sourceId: row.source_id,
    sourceCode: row.source_code,
    sourceCreatedAt: toDate(row.source_created_at) ?? new Date(0),
    lastConsultedAt: toDate(row.last_consulted_at),
    lastFinishedStatus: row.last_finished_status,
    lastFinishedError: row.last_finished_error,
    openRunId: row.open_run_id,
    openRunStartedAt: toDate(row.open_run_started_at),
    openRunAttempts: Number(row.open_run_attempts ?? 0),
    openRunLastError: row.open_run_last_error,
    recentFinishedStatuses: row.recent_statuses ?? [],
  }));
}

export interface SourceHealthLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Scheduler hook: evaluates health at most once per interval and logs each
 * alert at error level, re-alerting the same source+kind only after
 * `realertAfterMs`. State is in-memory: a restart re-emits current alerts,
 * which is the desired behaviour after a deploy.
 */
export class SourceHealthWatchdog {
  private lastCheckAt = 0;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(
    private readonly options: {
      intervalMs: number;
      realertAfterMs: number;
      thresholds?: SourceHealthThresholds;
      logger: SourceHealthLogger;
    },
  ) {}

  protected readRows(db: Kysely<DB>, thresholds: SourceHealthThresholds): Promise<SourceHealthRow[]> {
    return readSourceHealthRows(db, thresholds.persistentPartialRuns);
  }

  async runIfDue(db: Kysely<DB>, now: Date): Promise<SourceHealthReport | undefined> {
    if (now.getTime() - this.lastCheckAt < this.options.intervalMs) {
      return undefined;
    }
    this.lastCheckAt = now.getTime();

    const thresholds = this.options.thresholds ?? DEFAULT_SOURCE_HEALTH_THRESHOLDS;
    const rows = await this.readRows(db, thresholds);
    const report = evaluateSourceHealth(rows, now, thresholds);

    const active = new Set<string>();
    let emitted = 0;
    for (const alert of report.alerts) {
      const key = `${alert.sourceCode}:${alert.kind}`;
      active.add(key);
      const previous = this.lastAlertAt.get(key);
      if (previous !== undefined && now.getTime() - previous < this.options.realertAfterMs) {
        continue;
      }
      this.lastAlertAt.set(key, now.getTime());
      emitted += 1;
      this.options.logger.error(
        {
          alertKind: alert.kind,
          sourceCode: alert.sourceCode,
          sourceId: alert.sourceId,
          ...alert.detail,
        },
        'Source health alert',
      );
    }

    // A resolved condition alerts again immediately if it comes back.
    for (const key of [...this.lastAlertAt.keys()]) {
      if (!active.has(key)) this.lastAlertAt.delete(key);
    }

    this.options.logger.info(
      {
        checkedSources: report.checkedSources,
        activeAlerts: report.alerts.length,
        emittedAlerts: emitted,
        alertSummary: report.alerts.map((alert) => `${alert.sourceCode}:${alert.kind}`),
      },
      'Source health check completed',
    );

    return report;
  }
}
