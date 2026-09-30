import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SourceHealthWatchdog,
  evaluateSourceHealth,
  type SourceHealthRow,
} from '../src/modules/operations/source-health.js';

const NOW = new Date('2026-09-29T21:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

function row(overrides: Partial<SourceHealthRow>): SourceHealthRow {
  return {
    sourceId: '11111111-1111-4111-8111-111111111111',
    sourceCode: 'src',
    sourceCreatedAt: hoursAgo(24 * 30),
    lastConsultedAt: hoursAgo(1),
    lastFinishedStatus: 'SUCCESS',
    lastFinishedError: null,
    openRunId: null,
    openRunStartedAt: null,
    openRunAttempts: 0,
    openRunLastError: null,
    recentFinishedStatuses: ['SUCCESS', 'SUCCESS', 'SUCCESS'],
    ...overrides,
  };
}

test('a healthy source raises no alert', () => {
  assert.deepEqual(evaluateSourceHealth([row({})], NOW).alerts, []);
});

test('the September DOU incident is reported as stale and stuck', () => {
  const report = evaluateSourceHealth([
    row({
      sourceCode: 'dou',
      lastConsultedAt: hoursAgo(24 * 3 + 20),
      lastFinishedStatus: 'SUCCESS_NO_RESULTS',
      openRunId: 'run-dou',
      openRunStartedAt: hoursAgo(24 * 3 + 10),
      openRunAttempts: 9_514,
      openRunLastError: 'INLABS_INVALID_DOWNLOAD: INLABS_INVALID_DOWNLOAD',
    }),
  ], NOW);

  assert.deepEqual(report.alerts.map((alert) => alert.kind), ['STALE_SOURCE', 'STUCK_RUN']);
  assert.equal(report.alerts[1]?.detail.attempts, 9_514);
  assert.match(String(report.alerts[0]?.detail.lastError), /INLABS_INVALID_DOWNLOAD/);
});

test('an open run is stuck by attempt count alone', () => {
  const report = evaluateSourceHealth([
    row({ openRunId: 'r', openRunStartedAt: hoursAgo(0.5), openRunAttempts: 20 }),
  ], NOW);
  assert.deepEqual(report.alerts.map((alert) => alert.kind), ['STUCK_RUN']);
});

test('a normal retrying run is not stuck', () => {
  const report = evaluateSourceHealth([
    row({ openRunId: 'r', openRunStartedAt: hoursAgo(0.2), openRunAttempts: 2 }),
  ], NOW);
  assert.deepEqual(report.alerts, []);
});

test('the SPED pattern (every run PARTIAL_SUCCESS) is reported, a single partial is not', () => {
  const persistent = evaluateSourceHealth([
    row({
      sourceCode: 'sped',
      lastFinishedStatus: 'PARTIAL_SUCCESS',
      lastFinishedError: 'Partial processing: 1 item errors, 0 connector partial failures',
      recentFinishedStatuses: Array(6).fill('PARTIAL_SUCCESS'),
    }),
  ], NOW);
  assert.deepEqual(persistent.alerts.map((alert) => alert.kind), ['PERSISTENT_PARTIAL']);

  const once = evaluateSourceHealth([
    row({ recentFinishedStatuses: ['PARTIAL_SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS'] }),
  ], NOW);
  assert.deepEqual(once.alerts, []);
});

test('a source that never succeeds is stale only after the window from its creation', () => {
  const young = evaluateSourceHealth([
    row({ sourceCreatedAt: hoursAgo(2), lastConsultedAt: null, recentFinishedStatuses: [] }),
  ], NOW);
  assert.deepEqual(young.alerts, []);

  const confazLike = evaluateSourceHealth([
    row({
      sourceCode: 'confaz',
      lastConsultedAt: null,
      lastFinishedStatus: 'SOURCE_UNAVAILABLE',
      lastFinishedError: 'CONFAZ_HOST_UNREACHABLE: …',
      recentFinishedStatuses: Array(6).fill('SOURCE_UNAVAILABLE'),
    }),
  ], NOW);
  assert.deepEqual(confazLike.alerts.map((alert) => alert.kind), ['STALE_SOURCE']);
  assert.equal(confazLike.alerts[0]?.detail.lastConsultedAt, null);
});

test('watchdog throttles repeated alerts and re-alerts after resolution', async () => {
  const errors: Array<Record<string, unknown>> = [];
  const logger = { info: () => {}, error: (payload: Record<string, unknown>) => { errors.push(payload); } };
  let rows: SourceHealthRow[] = [row({ sourceCode: 'dou', lastConsultedAt: hoursAgo(30) })];

  class TestWatchdog extends SourceHealthWatchdog {
    protected override readRows(): Promise<SourceHealthRow[]> {
      return Promise.resolve(rows);
    }
  }
  const dog = new TestWatchdog({ intervalMs: 60_000, realertAfterMs: 6 * 3_600_000, logger });
  const db = {} as never;
  const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

  await dog.runIfDue(db, at(0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.alertKind, 'STALE_SOURCE');
  assert.equal(errors[0]?.sourceCode, 'dou');

  // Within the evaluation interval: nothing is read or logged.
  assert.equal(await dog.runIfDue(db, new Date(NOW.getTime() + 30_000)), undefined);

  // Still stale one hour later: throttled.
  await dog.runIfDue(db, at(1));
  assert.equal(errors.length, 1);

  // Resolved, then stale again: alerts immediately.
  rows = [row({ sourceCode: 'dou' })];
  await dog.runIfDue(db, at(2));
  rows = [row({ sourceCode: 'dou', lastConsultedAt: hoursAgo(40) })];
  await dog.runIfDue(db, at(3));
  assert.equal(errors.length, 2);

  // Past the re-alert window: alerts again.
  await dog.runIfDue(db, at(10));
  assert.equal(errors.length, 3);
});

test('time thresholds compare exact elapsed time, not the rounded display value', () => {
  const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

  // 23h57m would display as 24.0 but is still inside the 24h window.
  for (const minutes of [23 * 60 + 57, 23 * 60 + 59]) {
    const report = evaluateSourceHealth([row({ lastConsultedAt: minutesAgo(minutes) })], NOW);
    assert.deepEqual(report.alerts, [], `stale must not fire at ${minutes} min`);
  }
  const atStale = evaluateSourceHealth([row({ lastConsultedAt: minutesAgo(24 * 60) })], NOW);
  assert.deepEqual(atStale.alerts.map((alert) => alert.kind), ['STALE_SOURCE']);
  assert.equal(atStale.alerts[0]?.detail.hoursSinceConsulted, 24);

  // 5h57m / 5h59m would display as 6.0 but the run is not stuck yet.
  for (const minutes of [5 * 60 + 57, 5 * 60 + 59]) {
    const report = evaluateSourceHealth([
      row({ openRunId: 'r', openRunStartedAt: minutesAgo(minutes), openRunAttempts: 3 }),
    ], NOW);
    assert.deepEqual(report.alerts, [], `stuck must not fire at ${minutes} min`);
  }
  const atStuck = evaluateSourceHealth([
    row({ openRunId: 'r', openRunStartedAt: minutesAgo(6 * 60), openRunAttempts: 3 }),
  ], NOW);
  assert.deepEqual(atStuck.alerts.map((alert) => alert.kind), ['STUCK_RUN']);
  assert.equal(atStuck.alerts[0]?.detail.openHours, 6);
});
