import type {
  CollectionConnector,
  ConnectorResult,
  ConnectorTimeBudget,
} from './connector.contract.js';
import {
  isConnectorError,
  type ConnectorErrorKind,
} from './connector.error.js';

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

function createCancellationPromise(
  signal: AbortSignal,
): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new ConnectorCancelledError());
      return;
    }

    signal.addEventListener(
      'abort',
      () => {
        reject(new ConnectorCancelledError());
      },
      { once: true },
    );
  });
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

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ConnectorTimeoutError());
      timeoutController.abort();
    }, input.timeoutMs);

    timeoutHandle.unref();
  });

  const executions: Array<
    Promise<ConnectorResult>
  > = [
    input.connector.collect({
      sourceId: input.sourceId,
      runId: input.runId,
      attemptId: input.attemptId,
      signal: connectorSignal,
      budget,
    }),
    timeoutPromise,
  ];

  if (input.signal) {
    executions.push(createCancellationPromise(input.signal));
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

    if (error instanceof ConnectorCancelledError) {
      return {
        ok: false,
        status: 'CANCELLED',
        durationMs,
        code: 'CONNECTOR_CANCELLED',
        message: error.message,
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
  }
}
