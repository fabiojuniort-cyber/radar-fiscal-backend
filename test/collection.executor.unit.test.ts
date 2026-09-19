import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CollectionConnector,
  ConnectorExecutionContext,
} from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { executeConnector } from '../src/modules/collection/connector.executor.js';

const baseInput = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
};

function connector(
  collect: CollectionConnector['collect'],
): CollectionConnector {
  return {
    key: 'test-connector',
    collect,
  };
}

test('executeConnector returns SUCCESS with connector result', async () => {
  let receivedContext: ConnectorExecutionContext | undefined;

  const result = await executeConnector({
    ...baseInput,
    timeoutMs: 1_000,
    connector: connector(async (context) => {
      receivedContext = context;

      return {
        publications: [
          {
            title: 'Test publication',
            sphere: 'FEDERAL',
            officialUrl: 'https://example.gov/test',
          },
        ],
      };
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'SUCCESS');

  if (!result.ok) {
    assert.fail('Expected successful connector execution');
  }

  assert.equal(result.result.publications.length, 1);
  assert.equal(receivedContext?.sourceId, baseInput.sourceId);
  assert.equal(receivedContext?.runId, baseInput.runId);
  assert.equal(receivedContext?.attemptId, baseInput.attemptId);
  assert.equal(receivedContext?.signal.aborted, false);
  assert.ok(result.durationMs >= 0);
});

test('executeConnector maps ConnectorError without losing retry metadata', async () => {
  const result = await executeConnector({
    ...baseInput,
    timeoutMs: 1_000,
    connector: connector(async () => {
      throw new ConnectorError('Source is rate limited', {
        kind: 'RATE_LIMITED',
        code: 'HTTP_429',
        retryable: true,
        httpStatus: 429,
        retryAfterSeconds: 60,
        metadata: {
          endpoint: '/publications',
        },
      });
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'RATE_LIMITED');

  if (result.ok) {
    assert.fail('Expected failed connector execution');
  }

  assert.equal(result.code, 'HTTP_429');
  assert.equal(result.retryable, true);
  assert.equal(result.httpStatus, 429);
  assert.equal(result.retryAfterSeconds, 60);
  assert.deepEqual(result.metadata, {
    endpoint: '/publications',
  });
});

test('executeConnector returns TIMEOUT and aborts the connector signal', async () => {
  let connectorSignal: AbortSignal | undefined;

  const result = await executeConnector({
    ...baseInput,
    timeoutMs: 20,
    connector: connector(
      async (context) =>
        await new Promise((resolve) => {
          connectorSignal = context.signal;

          context.signal.addEventListener(
            'abort',
            () => {
              resolve({
                publications: [],
              });
            },
            { once: true },
          );
        }),
    ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'TIMEOUT');

  if (result.ok) {
    assert.fail('Expected timeout failure');
  }

  assert.equal(result.code, 'CONNECTOR_TIMEOUT');
  assert.equal(result.retryable, true);
  assert.equal(connectorSignal?.aborted, true);
  assert.ok(result.durationMs >= 0);
});

test('executeConnector returns CANCELLED when external signal aborts', async () => {
  const controller = new AbortController();

  const execution = executeConnector({
    ...baseInput,
    timeoutMs: 1_000,
    signal: controller.signal,
    connector: connector(
      async (context) =>
        await new Promise((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              resolve({
                publications: [],
              });
            },
            { once: true },
          );
        }),
    ),
  });

  controller.abort();

  const result = await execution;

  assert.equal(result.ok, false);
  assert.equal(result.status, 'CANCELLED');

  if (result.ok) {
    assert.fail('Expected cancelled connector execution');
  }

  assert.equal(result.code, 'CONNECTOR_CANCELLED');
  assert.equal(result.retryable, false);
});

test('executeConnector maps unexpected errors to PROCESSING_ERROR', async () => {
  const result = await executeConnector({
    ...baseInput,
    timeoutMs: 1_000,
    connector: connector(async () => {
      throw new Error('Parser exploded');
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'PROCESSING_ERROR');

  if (result.ok) {
    assert.fail('Expected processing failure');
  }

  assert.equal(result.code, 'UNHANDLED_CONNECTOR_ERROR');
  assert.equal(result.message, 'Parser exploded');
  assert.equal(result.retryable, false);
});

test('executeConnector rejects invalid timeout configuration', async () => {
  await assert.rejects(
    executeConnector({
      ...baseInput,
      timeoutMs: 0,
      connector: connector(async () => ({
        publications: [],
      })),
    }),
    RangeError,
  );
});
