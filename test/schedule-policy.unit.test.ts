import assert from 'node:assert/strict';
import test from 'node:test';

import { isCronDue } from '../src/modules/collection/cron.js';
import {
  D056_SCHEDULES,
  D056_TIMEZONE,
  d056Cron,
  d056ScheduleFor,
} from '../src/modules/collection/schedule-policy.js';

test('every D-056 source runs exactly in the 06h, 10h, 14h and 18h Brasília cycles', () => {
  for (const entry of D056_SCHEDULES) {
    const dueHours = new Set<number>();
    // One full São Paulo day (UTC-3): 03:00Z .. next day 02:59Z.
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const instant = new Date(Date.UTC(2026, 9, 1, 3, minute));
      if (isCronDue(entry.cron, instant, D056_TIMEZONE)) {
        dueHours.add(Number(new Intl.DateTimeFormat('en-US', {
          hour: 'numeric', hourCycle: 'h23', timeZone: D056_TIMEZONE,
        }).format(instant)));
      }
    }
    assert.deepEqual([...dueHours].sort((a, b) => a - b), [6, 10, 14, 18], entry.code);
  }
});

test('D-056 covers the finalized engines, staggers them and leaves DOE-SP to its own front', () => {
  const codes = D056_SCHEDULES.map((entry) => entry.code);
  assert.deepEqual([...codes].sort(), ['cgibs', 'confaz', 'dou', 'nfe-encat', 'rfb-normas', 'sped']);
  assert.equal(codes.some((code) => code.startsWith('doe-sp')), false);
  assert.equal(new Set(D056_SCHEDULES.map((entry) => entry.cron)).size, D056_SCHEDULES.length, 'distinct minutes');
  assert.equal(d056ScheduleFor('sped'), '5 6,10,14,18 * * *');
  assert.throws(() => d056ScheduleFor('doe-sp'), /not governed by D-056/);
  assert.throws(() => d056Cron(60));
});
