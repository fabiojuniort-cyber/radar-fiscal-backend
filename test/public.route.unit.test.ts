import assert from 'node:assert/strict';
import test from 'node:test';

import {
  derivePublicSourceStatus,
  withOriginVary,
} from '../src/api/routes/public.route.js';

const NOW = new Date('2026-09-26T15:00:00-03:00');

test('public source status maps terminal and success states', () => {
  assert.equal(
    derivePublicSourceStatus({
      isActive: true,
      lastRunStatus: 'SUCCESS',
      lastSuccessAt: NOW,
      now: NOW,
    }),
    'ONLINE',
  );

  assert.equal(
    derivePublicSourceStatus({
      isActive: true,
      lastRunStatus: 'SUCCESS_NO_RESULTS',
      lastSuccessAt: NOW,
      now: NOW,
    }),
    'ONLINE',
  );

  assert.equal(
    derivePublicSourceStatus({
      isActive: true,
      lastRunStatus: 'PARTIAL_SUCCESS',
      lastSuccessAt: NOW,
      now: NOW,
    }),
    'UNSTABLE',
  );

  for (const status of [
    'SOURCE_UNAVAILABLE',
    'FETCH_FAILED',
    'PROCESSING_FAILED',
    'CANCELLED',
  ]) {
    assert.equal(
      derivePublicSourceStatus({
        isActive: true,
        lastRunStatus: status,
        lastSuccessAt: NOW,
        now: NOW,
      }),
      'UNAVAILABLE',
    );
  }
});

test('public source status treats inactive and never-run sources as not consulted', () => {
  assert.equal(
    derivePublicSourceStatus({
      isActive: false,
      lastRunStatus: 'SUCCESS',
      lastSuccessAt: NOW,
      now: NOW,
    }),
    'NOT_CONSULTED',
  );

  assert.equal(
    derivePublicSourceStatus({
      isActive: true,
      lastRunStatus: null,
      lastSuccessAt: null,
      now: NOW,
    }),
    'NOT_CONSULTED',
  );

  assert.equal(
    derivePublicSourceStatus({
      isActive: true,
      lastRunStatus: 'NOT_CONSULTED',
      lastSuccessAt: null,
      now: NOW,
    }),
    'NOT_CONSULTED',
  );
});

test('running and pending sources use the 48-hour success window', () => {
  const recent = new Date(
    NOW.getTime() - 47 * 60 * 60 * 1000,
  );
  const stale = new Date(
    NOW.getTime() - 48 * 60 * 60 * 1000,
  );

  for (const status of ['RUNNING', 'PENDING']) {
    assert.equal(
      derivePublicSourceStatus({
        isActive: true,
        lastRunStatus: status,
        lastSuccessAt: recent,
        now: NOW,
      }),
      'UNSTABLE',
    );

    assert.equal(
      derivePublicSourceStatus({
        isActive: true,
        lastRunStatus: status,
        lastSuccessAt: stale,
        now: NOW,
      }),
      'UNAVAILABLE',
    );

    assert.equal(
      derivePublicSourceStatus({
        isActive: true,
        lastRunStatus: status,
        lastSuccessAt: null,
        now: NOW,
      }),
      'UNAVAILABLE',
    );
  }
});


test('public CORS preserves other Vary values and avoids duplicate Origin', () => {
  assert.equal(
    withOriginVary(undefined),
    'Origin',
  );
  assert.equal(
    withOriginVary('Accept-Encoding'),
    'Accept-Encoding, Origin',
  );
  assert.equal(
    withOriginVary([
      'Accept-Encoding',
      'Accept-Language',
    ]),
    'Accept-Encoding, Accept-Language, Origin',
  );
  assert.equal(
    withOriginVary('Accept-Encoding, origin'),
    'Accept-Encoding, origin',
  );
  assert.equal(
    withOriginVary('*'),
    '*',
  );
});
