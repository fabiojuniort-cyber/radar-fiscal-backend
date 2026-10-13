export interface RetryPolicyInput {
  attemptNo: number;
  maxAttempts: number;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export interface RetryPolicyOptions {
  baseDelayMs?: number;
  maxBackoffMs?: number;
}

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number | null;
  nextAttemptNo: number | null;
  reason:
    | 'NOT_RETRYABLE'
    | 'MAX_ATTEMPTS_REACHED'
    | 'RETRY_SCHEDULED';
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

function assertPositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeFinite(
  value: number,
  name: string,
): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative finite number`,
    );
  }
}

export function calculateRetryDelayMs(
  input: Pick<
    RetryPolicyInput,
    'attemptNo' | 'retryAfterSeconds'
  >,
  options: RetryPolicyOptions = {},
): number {
  assertPositiveInteger(input.attemptNo, 'attemptNo');

  const baseDelayMs =
    options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxBackoffMs =
    options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  assertNonNegativeFinite(baseDelayMs, 'baseDelayMs');
  assertNonNegativeFinite(maxBackoffMs, 'maxBackoffMs');

  const exponent = Math.max(0, input.attemptNo - 1);
  const exponentialDelay = Math.min(
    baseDelayMs * 2 ** exponent,
    maxBackoffMs,
  );

  if (input.retryAfterSeconds === undefined) {
    return exponentialDelay;
  }

  assertNonNegativeFinite(
    input.retryAfterSeconds,
    'retryAfterSeconds',
  );

  const retryAfterMs = input.retryAfterSeconds * 1_000;

  return Math.max(exponentialDelay, retryAfterMs);
}

export function decideRetry(
  input: RetryPolicyInput,
  options: RetryPolicyOptions = {},
): RetryDecision {
  assertPositiveInteger(input.attemptNo, 'attemptNo');
  assertPositiveInteger(input.maxAttempts, 'maxAttempts');

  if (!input.retryable) {
    return {
      shouldRetry: false,
      delayMs: null,
      nextAttemptNo: null,
      reason: 'NOT_RETRYABLE',
    };
  }

  if (input.attemptNo >= input.maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: null,
      nextAttemptNo: null,
      reason: 'MAX_ATTEMPTS_REACHED',
    };
  }

  return {
    shouldRetry: true,
    delayMs: calculateRetryDelayMs(
      {
        attemptNo: input.attemptNo,
        ...(input.retryAfterSeconds !== undefined
          ? {
              retryAfterSeconds:
                input.retryAfterSeconds,
            }
          : {}),
      },
      options,
    ),
    nextAttemptNo: input.attemptNo + 1,
    reason: 'RETRY_SCHEDULED',
  };
}
