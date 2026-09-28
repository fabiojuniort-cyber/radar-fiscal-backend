import {
  sql,
  type Kysely,
} from 'kysely';

import type {
  DB,
  Json,
} from '../../infrastructure/database/database.types.js';
import type {
  ConnectorExecutionFailure,
  ConnectorExecutionOutcome,
} from './connector.executor.js';
import { writeCheckpoint } from './checkpoint.repository.js';
import type { CollectionRunTerminalStatus } from './run-status.js';

export interface AcquiredCollectionRun {
  id: string;
  sourceId: string;
  connectorKey: string;
  maxAttempts: number;
  correlationId: string;
  workerId: string;
}

export interface CollectionAttemptRecord {
  id: string;
  runId: string;
  attemptNo: number;
}

export interface CreateCollectionRunInput {
  sourceId: string;
  scheduledFor: Date;
  triggerType: 'SCHEDULED' | 'MANUAL' | 'BACKFILL';
}

export interface AcquireCollectionRunOptions {
  staleAfterMs?: number;
}

export interface ScheduleRetryInput {
  runId: string;
  workerId: string;
  nextAttemptAt: Date;
  errorSummary?: string;
}

export interface FinishRunInput {
  runId: string;
  workerId: string;
  status: CollectionRunTerminalStatus;
  errorSummary?: string;
}

export interface FinishAttemptInput {
  attemptId: string;
  outcome: ConnectorExecutionOutcome;
  /** Required when the outcome carries a checkpoint. */
  runId?: string;
  sourceId?: string;
  connectorKey?: string;
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export async function createCollectionRun(
  db: Kysely<DB>,
  input: CreateCollectionRunInput,
): Promise<string> {
  const inserted = await db
    .insertInto('collection_runs')
    .values({
      source_id: input.sourceId,
      scheduled_for: input.scheduledFor,
      trigger_type: input.triggerType,
      status: 'PENDING',
    })
    .onConflict((conflict) =>
      conflict
        .columns([
          'source_id',
          'scheduled_for',
          'trigger_type',
        ])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted) {
    return inserted.id;
  }

  const existing = await db
    .selectFrom('collection_runs')
    .select('id')
    .where('source_id', '=', input.sourceId)
    .where('scheduled_for', '=', input.scheduledFor)
    .where('trigger_type', '=', input.triggerType)
    .executeTakeFirstOrThrow();

  return existing.id;
}

/**
 * Scheduler path: creates the run only if the source is still active in the
 * insert's own snapshot. No row lock is taken on `sources`: the Scheduler
 * runs as radar_worker_runtime, which has only SELECT there, and any
 * FOR SHARE/KEY SHARE/UPDATE on it is denied. The pause × Scheduler race is
 * closed on the operator side instead: the pause (ops/doe-sp/sql/25) takes
 * `LOCK TABLE collection_runs IN SHARE MODE` in the same transaction as the
 * UPDATE, so an insert already in flight commits before the pause completes
 * (and is visible to its active-run check), and a later insert waits for the
 * pause and then reads is_active = false. Returns undefined when the source
 * is inactive.
 */
export async function createScheduledCollectionRun(
  db: Kysely<DB>,
  input: CreateCollectionRunInput,
): Promise<string | undefined> {
  const inserted = await sql<{ id: string }>`
    INSERT INTO collection_runs (source_id, scheduled_for, trigger_type, status)
    SELECT s.id, ${input.scheduledFor}, ${input.triggerType}, 'PENDING'
    FROM sources s
    WHERE s.id = ${input.sourceId} AND s.is_active = true
    ON CONFLICT (source_id, scheduled_for, trigger_type) DO NOTHING
    RETURNING id
  `.execute(db);

  if (inserted.rows[0]) {
    return inserted.rows[0].id;
  }

  const existing = await sql<{ id: string }>`
    SELECT cr.id
    FROM collection_runs cr
    JOIN sources s ON s.id = cr.source_id
    WHERE cr.source_id = ${input.sourceId}
      AND cr.scheduled_for = ${input.scheduledFor}
      AND cr.trigger_type = ${input.triggerType}
      AND s.is_active = true
  `.execute(db);

  return existing.rows[0]?.id;
}

export async function acquireNextCollectionRun(
  db: Kysely<DB>,
  workerId: string,
  options: AcquireCollectionRunOptions = {},
): Promise<AcquiredCollectionRun | null> {
  const normalizedWorkerId = workerId.trim();

  if (!normalizedWorkerId) {
    throw new RangeError('workerId must not be blank');
  }

  const staleAfterMs = options.staleAfterMs ?? 120_000;

  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000) {
    throw new RangeError(
      'staleAfterMs must be a finite number >= 1000',
    );
  }

  const staleBefore = new Date(
    Date.now() - staleAfterMs,
  );

  return db.transaction().execute(async (trx) => {
    const candidate = await sql<{
      id: string;
      source_id: string;
      connector_key: string;
      max_attempts: number;
      correlation_id: string;
      was_stale: boolean;
    }>`
      SELECT
        cr.id,
        cr.source_id,
        s.connector_key,
        s.max_attempts,
        cr.correlation_id,
        (
          cr.status = 'RUNNING'
          AND cr.worker_id IS NOT NULL
        ) AS was_stale
      FROM collection_runs cr
      JOIN sources s
        ON s.id = cr.source_id
      WHERE s.is_active = true
        AND cr.scheduled_for <= now()
        AND (
          cr.status = 'PENDING'
          OR (
            cr.status = 'RUNNING'
            AND cr.worker_id IS NULL
            AND cr.next_attempt_at IS NOT NULL
            AND cr.next_attempt_at <= now()
          )
          OR (
            cr.status = 'RUNNING'
            AND cr.worker_id IS NOT NULL
            AND coalesce(
              cr.heartbeat_at,
              cr.locked_at,
              cr.started_at,
              cr.created_at
            ) < ${staleBefore}
          )
        )
      ORDER BY
        coalesce(cr.next_attempt_at, cr.scheduled_for),
        cr.created_at,
        cr.id
      FOR UPDATE OF cr SKIP LOCKED
      LIMIT 1
    `.execute(trx);

    const row = candidate.rows[0];

    if (!row) {
      return null;
    }

    const now = new Date();

    if (row.was_stale) {
      await trx
        .updateTable('collection_attempts')
        .set({
          status: 'CANCELLED',
          finished_at: now,
          error_code: 'STALE_WORKER_HEARTBEAT',
          error_message:
            'Previous worker heartbeat became stale; run was recovered by another worker.',
          retryable: true,
        })
        .where('collection_run_id', '=', row.id)
        .where('status', '=', 'RUNNING')
        .execute();
    }

    const updated = await trx
      .updateTable('collection_runs')
      .set({
        status: 'RUNNING',
        started_at: sql`coalesce(started_at, now())`,
        worker_id: normalizedWorkerId,
        locked_at: now,
        heartbeat_at: now,
        next_attempt_at: null,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .returning([
        'id',
        'source_id',
        'correlation_id',
        'worker_id',
      ])
      .executeTakeFirstOrThrow();

    return {
      id: updated.id,
      sourceId: updated.source_id,
      connectorKey: row.connector_key,
      maxAttempts: row.max_attempts,
      correlationId: updated.correlation_id,
      workerId: updated.worker_id!,
    };
  });
}

export async function startCollectionAttempt(
  db: Kysely<DB>,
  runId: string,
  workerId: string,
  connectorVersion?: string,
): Promise<CollectionAttemptRecord> {
  return db.transaction().execute(async (trx) => {
    const run = await trx
      .selectFrom('collection_runs')
      .select(['id', 'worker_id', 'status'])
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (
      run.status !== 'RUNNING' ||
      run.worker_id !== workerId
    ) {
      throw new Error(
        'Collection run is not owned by this worker.',
      );
    }

    const lastAttempt = await trx
      .selectFrom('collection_attempts')
      .select('attempt_no')
      .where('collection_run_id', '=', runId)
      .orderBy('attempt_no', 'desc')
      .executeTakeFirst();

    const attemptNo =
      (lastAttempt?.attempt_no ?? 0) + 1;

    const values = {
      collection_run_id: runId,
      attempt_no: attemptNo,
      status: 'RUNNING',
      ...(connectorVersion !== undefined
        ? { connector_version: connectorVersion }
        : {}),
    };

    const attempt = await trx
      .insertInto('collection_attempts')
      .values(values)
      .returning([
        'id',
        'collection_run_id',
        'attempt_no',
      ])
      .executeTakeFirstOrThrow();

    return {
      id: attempt.id,
      runId: attempt.collection_run_id,
      attemptNo: attempt.attempt_no,
    };
  });
}

const DOE_SP_HTTP_DIAGNOSTIC_MAX_ENTRIES = 5;
const DOE_SP_HTTP_DIAGNOSTIC_MAX_ITEM_REFERENCE_CHARS = 96;
const DOE_SP_HTTP_DIAGNOSTIC_MAX_CONTENT_TYPE_CHARS = 160;
const DOE_SP_HTTP_DIAGNOSTIC_MAX_RESPONSE_SAMPLE_CHARS = 240;
const DOE_SP_AUTH_PDF_DIAGNOSTIC_ENDPOINT =
  '/v2/authentication/download/{authCode}';

interface DoeSpHttpDiagnostic {
  itemReference?: string;
  httpStatus?: number;
  endpoint: string;
  contentType?: string;
  responseSample?: string;
}

function cleanBoundedText(
  value: string,
  maxChars: number,
): string | undefined {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return undefined;
  return cleaned.slice(0, maxChars);
}

function sanitizeDoeSpItemReference(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;

  const trimmed = value
    .trim()
    .slice(0, DOE_SP_HTTP_DIAGNOSTIC_MAX_ITEM_REFERENCE_CHARS);

  return /^\d{4}-\d{2}-\d{2}#[0-9a-fA-F-]{36}$/.test(
    trimmed,
  )
    ? trimmed
    : undefined;
}

function sanitizeDoeSpResponseSample(
  value: string,
): string | undefined {
  let sample = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sample) return undefined;

  sample = sample
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Bearer [REDACTED]',
    )
    .replace(
      /(["']?(?:authorization|cookie|set-cookie|password|token|access_token|refresh_token|api[_-]?key)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b\d{4}(?:\.\d+){5,}\b/g,
      '[REDACTED_AUTH_CODE]',
    )
    .replace(
      /[A-Za-z0-9+/]{80,}={0,2}/g,
      '[REDACTED_LONG_TOKEN]',
    );

  if (
    sample.length >
    DOE_SP_HTTP_DIAGNOSTIC_MAX_RESPONSE_SAMPLE_CHARS
  ) {
    sample =
      sample
        .slice(
          0,
          DOE_SP_HTTP_DIAGNOSTIC_MAX_RESPONSE_SAMPLE_CHARS - 1,
        )
        .trimEnd() + '…';
  }

  return sample || undefined;
}

function extractDoeSpHttpDiagnostic(
  message: string,
  itemReference: string | undefined,
): DoeSpHttpDiagnostic | undefined {
  const statusMatch = message.match(
    /(?:\[|;\s*)status=(\d{3})(?:;|\])/,
  );
  const endpointMatch = message.match(
    /(?:\[|;\s*)endpoint=([^;\]]{1,240})(?:;|\])/,
  );

  if (
    !statusMatch ||
    endpointMatch?.[1]?.trim() !==
      DOE_SP_AUTH_PDF_DIAGNOSTIC_ENDPOINT
  ) {
    return undefined;
  }

  const httpStatus = Number(statusMatch[1]);
  if (
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  ) {
    return undefined;
  }

  const contentTypeMatch = message.match(
    /(?:\[|;\s*)contentType=([^;\]]{1,240})(?:;|\])/,
  );

  let responseSample: string | undefined;
  const sampleMarker = '; responseSample=';
  const sampleStart = message.lastIndexOf(sampleMarker);

  if (sampleStart >= 0 && message.endsWith(']')) {
    const encodedSample = message
      .slice(sampleStart + sampleMarker.length, -1)
      .trim();

    try {
      const parsed = JSON.parse(encodedSample) as unknown;
      if (typeof parsed === 'string') {
        responseSample =
          sanitizeDoeSpResponseSample(parsed);
      }
    } catch {
      // Ignore malformed/untrusted diagnostic text.
    }
  }

  const contentType = contentTypeMatch?.[1]
    ? cleanBoundedText(
        contentTypeMatch[1],
        DOE_SP_HTTP_DIAGNOSTIC_MAX_CONTENT_TYPE_CHARS,
      )
    : undefined;

  const sanitizedItemReference =
    sanitizeDoeSpItemReference(itemReference);

  return {
    ...(sanitizedItemReference
      ? { itemReference: sanitizedItemReference }
      : {}),
    httpStatus,
    endpoint: DOE_SP_AUTH_PDF_DIAGNOSTIC_ENDPOINT,
    ...(contentType ? { contentType } : {}),
    ...(responseSample ? { responseSample } : {}),
  };
}

function doeSpHttpDiagnostics(
  connectorKey: string | undefined,
  partialFailures:
    | Array<{
        code: string;
        message: string;
        itemReference?: string;
      }>
    | undefined,
): DoeSpHttpDiagnostic[] | undefined {
  if (
    connectorKey !== 'doe-sp' ||
    !partialFailures?.length
  ) {
    return undefined;
  }

  const diagnostics: DoeSpHttpDiagnostic[] = [];

  for (const failure of partialFailures) {
    if (failure.code !== 'DOE_SP_HTTP_ERROR') continue;

    const diagnostic = extractDoeSpHttpDiagnostic(
      failure.message,
      failure.itemReference,
    );

    if (!diagnostic) continue;

    diagnostics.push(diagnostic);

    if (
      diagnostics.length >=
      DOE_SP_HTTP_DIAGNOSTIC_MAX_ENTRIES
    ) {
      break;
    }
  }

  return diagnostics.length ? diagnostics : undefined;
}

function failureMetadata(
  outcome: ConnectorExecutionFailure,
): Json {
  return asJson(outcome.metadata ?? {});
}

export async function finishCollectionAttempt(
  db: Kysely<DB>,
  input: FinishAttemptInput,
): Promise<void> {
  const finishedAt = new Date();

  if (input.outcome.ok) {
    const outcome = input.outcome;
    const checkpoint = outcome.result.checkpoint;
    const safeDoeSpHttpDiagnostics =
      doeSpHttpDiagnostics(
        input.connectorKey,
        outcome.result.partialFailures,
      );
    if (checkpoint && (!input.runId || !input.sourceId || !input.connectorKey)) {
      throw new Error('runId, sourceId and connectorKey are required to persist a checkpoint');
    }

    await db.transaction().execute(async (trx) => {
      // Only the attempt that still owns its RUNNING row may finish it and
      // publish a checkpoint (a recovered/stale attempt must not).
      const owned = await trx
        .selectFrom('collection_attempts')
        .select('id')
        .where('id', '=', input.attemptId)
        .where('status', '=', 'RUNNING')
        .forUpdate()
        .executeTakeFirst();
      if (!owned) return;

      const checkpointRef = checkpoint
        ? await writeCheckpoint(trx, {
            sourceId: input.sourceId!,
            connectorKey: input.connectorKey!,
            runId: input.runId!,
            attemptId: input.attemptId,
            checkpoint,
          })
        : undefined;

      await trx
        .updateTable('collection_attempts')
        .set({
          status: 'SUCCESS',
          finished_at: finishedAt,
          response_time_ms: outcome.durationMs,
          retryable: false,
          metadata: asJson({
            ...(outcome.result.metadata ?? {}),
            partialFailureCount:
              outcome.result.partialFailures?.length ?? 0,
            ...(safeDoeSpHttpDiagnostics
              ? {
                  doeSpHttpDiagnostics:
                    safeDoeSpHttpDiagnostics,
                }
              : {}),
            publicationCount: outcome.result.publications.length,
            ...(outcome.result.completion ? { completion: outcome.result.completion } : {}),
            ...(checkpointRef ? { checkpointRef } : {}),
          }),
        })
        .where('id', '=', input.attemptId)
        .where('status', '=', 'RUNNING')
        .execute();
    });

    return;
  }

  await db
    .updateTable('collection_attempts')
    .set({
      status: input.outcome.status,
      finished_at: finishedAt,
      response_time_ms: input.outcome.durationMs,
      http_status:
        input.outcome.httpStatus ?? null,
      error_code: input.outcome.code,
      error_message: input.outcome.message,
      retryable: input.outcome.retryable,
      retry_after_seconds:
        input.outcome.retryAfterSeconds ?? null,
      metadata: failureMetadata(input.outcome),
    })
    .where('id', '=', input.attemptId)
    .where('status', '=', 'RUNNING')
    .execute();
}

export async function heartbeatCollectionRun(
  db: Kysely<DB>,
  runId: string,
  workerId: string,
): Promise<boolean> {
  const updated = await db
    .updateTable('collection_runs')
    .set({
      heartbeat_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', runId)
    .where('status', '=', 'RUNNING')
    .where('worker_id', '=', workerId)
    .returning('id')
    .executeTakeFirst();

  return updated !== undefined;
}

export async function scheduleCollectionRetry(
  db: Kysely<DB>,
  input: ScheduleRetryInput,
): Promise<void> {
  const updated = await db
    .updateTable('collection_runs')
    .set({
      status: 'RUNNING',
      next_attempt_at: input.nextAttemptAt,
      worker_id: null,
      locked_at: null,
      heartbeat_at: null,
      error_summary:
        input.errorSummary ?? null,
      updated_at: new Date(),
    })
    .where('id', '=', input.runId)
    .where('status', '=', 'RUNNING')
    .where('worker_id', '=', input.workerId)
    .returning('id')
    .executeTakeFirst();

  if (!updated) {
    throw new Error(
      'Collection run is not owned by this worker.',
    );
  }
}

export async function finishCollectionRun(
  db: Kysely<DB>,
  input: FinishRunInput,
): Promise<void> {
  const now = new Date();

  const updated = await db
    .updateTable('collection_runs')
    .set({
      status: input.status,
      source_consulted_at: now,
      finished_at: now,
      next_attempt_at: null,
      worker_id: null,
      locked_at: null,
      heartbeat_at: null,
      error_summary:
        input.errorSummary ?? null,
      updated_at: now,
    })
    .where('id', '=', input.runId)
    .where('status', '=', 'RUNNING')
    .where('worker_id', '=', input.workerId)
    .returning('id')
    .executeTakeFirst();

  if (!updated) {
    throw new Error(
      'Collection run is not owned by this worker.',
    );
  }
}
