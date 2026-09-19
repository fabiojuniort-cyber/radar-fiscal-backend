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
    await db
      .updateTable('collection_attempts')
      .set({
        status: 'SUCCESS',
        finished_at: finishedAt,
        response_time_ms:
          input.outcome.durationMs,
        retryable: false,
        metadata: asJson({
          ...(input.outcome.result.metadata ?? {}),
          partialFailureCount:
            input.outcome.result.partialFailures?.length ??
            0,
          publicationCount:
            input.outcome.result.publications.length,
        }),
      })
      .where('id', '=', input.attemptId)
      .where('status', '=', 'RUNNING')
      .execute();

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
