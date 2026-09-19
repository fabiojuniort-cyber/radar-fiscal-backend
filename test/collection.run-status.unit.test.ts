import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectorExecutionOutcome } from '../src/modules/collection/connector.executor.js';
import { resolveCollectionRunStatus } from '../src/modules/collection/run-status.js';

function successOutcome(
  publications: number,
  partialFailures = 0,
): ConnectorExecutionOutcome {
  return {
    ok: true,
    status: 'SUCCESS',
    durationMs: 10,
    result: {
      publications: Array.from(
        { length: publications },
        (_, index) => ({
          title: `Publication ${index + 1}`,
          sphere: 'FEDERAL',
          officialUrl: `https://example.gov/${index + 1}`,
        }),
      ),
      ...(partialFailures > 0
        ? {
            partialFailures: Array.from(
              { length: partialFailures },
              (_, index) => ({
                code: `PARTIAL_${index + 1}`,
                message: 'Partial processing failure',
              }),
            ),
          }
        : {}),
    },
  };
}

function failureOutcome(
  status:
    | 'SOURCE_UNAVAILABLE'
    | 'NETWORK_ERROR'
    | 'HTTP_ERROR'
    | 'FETCH_ERROR'
    | 'PROCESSING_ERROR'
    | 'RATE_LIMITED'
    | 'CANCELLED'
    | 'TIMEOUT',
): ConnectorExecutionOutcome {
  return {
    ok: false,
    status,
    durationMs: 10,
    code: 'TEST_FAILURE',
    message: 'Test failure',
    retryable: false,
  };
}

test('run status is SUCCESS when publications are found', () => {
  assert.equal(
    resolveCollectionRunStatus(successOutcome(1)),
    'SUCCESS',
  );
});

test('run status is SUCCESS_NO_RESULTS when source is consulted with no publications', () => {
  assert.equal(
    resolveCollectionRunStatus(successOutcome(0)),
    'SUCCESS_NO_RESULTS',
  );
});

test('run status is PARTIAL_SUCCESS when connector reports partial failures', () => {
  assert.equal(
    resolveCollectionRunStatus(successOutcome(1, 1)),
    'PARTIAL_SUCCESS',
  );
});

test('run status preserves SOURCE_UNAVAILABLE', () => {
  assert.equal(
    resolveCollectionRunStatus(
      failureOutcome('SOURCE_UNAVAILABLE'),
    ),
    'SOURCE_UNAVAILABLE',
  );
});

test('fetch-like failures map to FETCH_FAILED', () => {
  for (const status of [
    'NETWORK_ERROR',
    'HTTP_ERROR',
    'FETCH_ERROR',
    'RATE_LIMITED',
    'TIMEOUT',
  ] as const) {
    assert.equal(
      resolveCollectionRunStatus(failureOutcome(status)),
      'FETCH_FAILED',
    );
  }
});

test('processing failures map to PROCESSING_FAILED', () => {
  assert.equal(
    resolveCollectionRunStatus(
      failureOutcome('PROCESSING_ERROR'),
    ),
    'PROCESSING_FAILED',
  );
});

test('cancelled execution maps to CANCELLED', () => {
  assert.equal(
    resolveCollectionRunStatus(failureOutcome('CANCELLED')),
    'CANCELLED',
  );
});
