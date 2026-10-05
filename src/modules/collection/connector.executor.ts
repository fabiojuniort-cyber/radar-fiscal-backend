import type {
  CollectionConnector,
  ConnectorResult,
  ConnectorTimeBudget,
} from './connector.contract.js';
import {
  isConnectorError,
  ConnectorError,
  type ConnectorErrorKind,
} from './connector.error.js';
import type { CollectionMemoryProbe } from './collection.memory.js';
import { PublicationSpool, disposePublicationSpool } from './publication-spool.js';

export type ConnectorAttemptStatus =
  | 'SUCCESS'
  | ConnectorErrorKind
  | 'TIMEOUT';

export interface ConnectorExecutionSuccess {
  ok: true;
  status: 'SUCCESS';
  durationMs: number;
  result: ConnectorResult;
}

export interface ConnectorExecutionFailure {
  ok: false;
  status: Exclude<ConnectorAttemptStatus, 'SUCCESS'>;
  durationMs: number;
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterSeconds?: number;
  metadata?: Record<string, unknown>;
}

export type ConnectorExecutionOutcome =
  | ConnectorExecutionSuccess
  | ConnectorExecutionFailure;

export interface ExecuteConnectorInput {
  connector: CollectionConnector;
  sourceId: string;
  runId: string;
  attemptId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Time reserved between the soft deadline and the hard timeout for a
   * graceful stop (emit resolved items, build checkpoint). Default:
   * max(120s, 15% of timeoutMs), capped at 50% of timeoutMs.
   */
  budgetGraceMs?: number;
  now?: () => number;
  memory?: CollectionMemoryProbe;
}

export const DEFAULT_MIN_BUDGET_GRACE_MS = 120_000;

export function defaultBudgetGraceMs(timeoutMs: number): number {
  return Math.min(
    Math.max(DEFAULT_MIN_BUDGET_GRACE_MS, Math.round(timeoutMs * 0.15)),
    Math.floor(timeoutMs * 0.5),
  );
}

export function createTimeBudget(
  startedAt: number,
  timeoutMs: number,
  graceMs: number,
  now: () => number = Date.now,
): ConnectorTimeBudget {
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs >= timeoutMs) {
    throw new RangeError('budget grace must be >= 0 and smaller than timeoutMs');
  }
  const deadline = startedAt + timeoutMs;
  const softDeadline = deadline - graceMs;
  return {
    deadlineAt: new Date(deadline),
    softDeadlineAt: new Date(softDeadline),
    remainingMs: () => Math.max(0, deadline - now()),
    shouldYield: () => now() >= softDeadline,
  };
}

class ConnectorTimeoutError extends Error {
  constructor() {
    super('Connector execution timed out');
    this.name = 'ConnectorTimeoutError';
  }
}

class ConnectorCancelledError extends Error {
  constructor() {
    super('Connector execution cancelled');
    this.name = 'ConnectorCancelledError';
  }
}

export async function executeConnector(
  input: ExecuteConnectorInput,
): Promise<ConnectorExecutionOutcome> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  const now = input.now ?? Date.now;
  const startedAt = now();
  const budget = createTimeBudget(
    startedAt,
    input.timeoutMs,
    input.budgetGraceMs ?? defaultBudgetGraceMs(input.timeoutMs),
    now,
  );
  const timeoutController = new AbortController();

  const connectorSignal = input.signal
    ? AbortSignal.any([
        input.signal,
        timeoutController.signal,
      ])
    : timeoutController.signal;

  let timeoutHandle: NodeJS.Timeout | undefined;
  let spool: PublicationSpool | undefined;
  let cancel: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ConnectorTimeoutError());
      timeoutController.abort();
    }, input.timeoutMs);

    timeoutHandle.unref();
  });

  const collection = async (): Promise<ConnectorResult> => {
    const context = {
      sourceId: input.sourceId,
      runId: input.runId,
      attemptId: input.attemptId,
      signal: connectorSignal,
      budget,
      ...(input.memory ? { memory: input.memory } : {}),
    };
    connectorSignal.throwIfAborted();
    input.memory?.('collect_start');
    if (!input.connector.collectIncremental) return input.connector.collect(context);
    try {
      spool = await PublicationSpool.create(connectorSignal);
      connectorSignal.throwIfAborted();
      const result = await input.connector.collectIncremental(context, publication => spool!.append(publication));
      connectorSignal.throwIfAborted();
      if (result.publications.length || result.publicationStream) {
        throw new ConnectorError('INCREMENTAL_CONNECTOR_INVALID_RESULT', {
          code: 'INCREMENTAL_CONNECTOR_INVALID_RESULT', kind: 'PROCESSING_ERROR', retryable: false,
        });
      }
      await spool.seal();
      connectorSignal.throwIfAborted();
      input.memory?.('collect_complete', { publications: spool.count, spoolBytes: spool.bytes });
      return { ...result, publicationStream: spool };
    } catch (error) {
      await disposePublicationSpool(spool);
      throw error;
    }
  };

  const executions: Array<
    Promise<ConnectorResult>
  > = [
    collection(),
    timeoutPromise,
  ];

  if (input.signal) {
    executions.push(new Promise<never>((_, reject) => {
      cancel = () => reject(new ConnectorCancelledError());
      if (input.signal!.aborted) cancel();
      else input.signal!.addEventListener('abort', cancel, { once: true });
    }));
  }

  try {
    const result = await Promise.race(executions);

    return {
      ok: true,
      status: 'SUCCESS',
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (error) {
    timeoutController.abort();
    let cleanupFailed = false;
    try { await disposePublicationSpool(spool); }
    catch (cleanupError) { error = cleanupError; cleanupFailed = true; }
    const durationMs = Date.now() - startedAt;

    if (error instanceof ConnectorTimeoutError) {
      return {
        ok: false,
        status: 'TIMEOUT',
        durationMs,
        code: 'CONNECTOR_TIMEOUT',
        message: error.message,
        retryable: true,
      };
    }

    if (!cleanupFailed && (error instanceof ConnectorCancelledError || input.signal?.aborted)) {
      return {
        ok: false,
        status: 'CANCELLED',
        durationMs,
        code: 'CONNECTOR_CANCELLED',
        message: 'Connector execution cancelled',
        retryable: false,
      };
    }

    if (isConnectorError(error)) {
      const failure: ConnectorExecutionFailure = {
        ok: false,
        status: error.kind,
        durationMs,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      };

      if (error.httpStatus !== undefined) {
        failure.httpStatus = error.httpStatus;
      }

      if (error.retryAfterSeconds !== undefined) {
        failure.retryAfterSeconds = error.retryAfterSeconds;
      }

      if (error.metadata !== undefined) {
        failure.metadata = error.metadata;
      }

      return failure;
    }

    return {
      ok: false,
      status: 'PROCESSING_ERROR',
      durationMs,
      code: 'UNHANDLED_CONNECTOR_ERROR',
      message:
        error instanceof Error
          ? error.message
          : 'Unknown connector error',
      retryable: false,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (cancel) input.signal?.removeEventListener('abort', cancel);
  }
}
