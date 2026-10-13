import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateRetryDelayMs,
  decideRetry,
} from '../src/modules/collection/retry.policy.js';

test('calculateRetryDelayMs applies exponential backoff', () => {
  assert.equal(
    calculateRetryDelayMs({ attemptNo: 1 }),
    1_000,
  );
  assert.equal(
    calculateRetryDelayMs({ attemptNo: 2 }),
    2_000,
  );
  assert.equal(
    calculateRetryDelayMs({ attemptNo: 3 }),
    4_000,
  );
});

test('calculateRetryDelayMs caps exponential backoff', () => {
  assert.equal(
    calculateRetryDelayMs(
      { attemptNo: 10 },
      {
        baseDelayMs: 1_000,
        maxBackoffMs: 5_000,
      },
    ),
    5_000,
  );
});

test('calculateRetryDelayMs respects retryAfterSeconds when larger', () => {
  assert.equal(
    calculateRetryDelayMs({
      attemptNo: 2,
      retryAfterSeconds: 30,
    }),
    30_000,
  );
});

test('decideRetry schedules the next attempt when retryable', () => {
  assert.deepEqual(
    decideRetry({
      attemptNo: 1,
      maxAttempts: 3,
      retryable: true,
    }),
    {
      shouldRetry: true,
      delayMs: 1_000,
      nextAttemptNo: 2,
      reason: 'RETRY_SCHEDULED',
    },
  );
});

test('decideRetry stops immediately for non-retryable failures', () => {
  assert.deepEqual(
    decideRetry({
      attemptNo: 1,
      maxAttempts: 3,
      retryable: false,
    }),
    {
      shouldRetry: false,
      delayMs: null,
      nextAttemptNo: null,
      reason: 'NOT_RETRYABLE',
    },
  );
});

test('decideRetry stops after maxAttempts is reached', () => {
  assert.deepEqual(
    decideRetry({
      attemptNo: 3,
      maxAttempts: 3,
      retryable: true,
    }),
    {
      shouldRetry: false,
      delayMs: null,
      nextAttemptNo: null,
      reason: 'MAX_ATTEMPTS_REACHED',
    },
  );
});

test('retry policy rejects invalid attempt configuration', () => {
  assert.throws(
    () =>
      decideRetry({
        attemptNo: 0,
        maxAttempts: 3,
        retryable: true,
      }),
    RangeError,
  );

  assert.throws(
    () =>
      decideRetry({
        attemptNo: 1,
        maxAttempts: 0,
        retryable: true,
      }),
    RangeError,
  );
});
