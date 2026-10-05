import assert from 'node:assert/strict';
import test from 'node:test';

import { DOU_BACKFILL_SECTIONS, douBackfillBatches, isDouBackfillCoverageComplete, planDouBackfillDates } from '../src/modules/collection/dou-backfill.js';
import { DOU_XML_SECTIONS } from '../src/modules/collection/dou.connector.js';

test('plan walks back one day at a time, skipping covered dates and the monitoring window', () => {
  const dates = planDouBackfillDates({
    from: '2026-09-10',
    to: '2026-10-04',
    today: '2026-10-04',
    covered: new Set(['2026-09-30', '2026-09-29', '2026-09-15', '2026-09-11']),
  });
  assert.equal(dates[0], '2026-10-01', 'today, today-1 and today-2 belong to monitoring');
  assert.deepEqual(dates.slice(0, 4), ['2026-10-01', '2026-09-28', '2026-09-27', '2026-09-26']);
  assert.equal(dates.includes('2026-09-15'), false);
  assert.equal(dates.at(-1), '2026-09-10');
  assert.equal(dates.length, 22 - 4);
});

test('plan is empty when everything is covered or the range is inside the monitoring window', () => {
  assert.deepEqual(planDouBackfillDates({ from: '2026-10-02', to: '2026-10-04', today: '2026-10-04', covered: new Set() }), []);
  assert.deepEqual(planDouBackfillDates({ from: '2026-09-30', to: '2026-10-01', today: '2026-10-04', covered: new Set(['2026-09-30', '2026-10-01']) }), []);
  assert.throws(() => planDouBackfillDates({ from: '2026-02-30', to: '2026-10-01', today: '2026-10-04', covered: new Set() }), RangeError);
});

test('batches never exceed the connector limit of four dates', () => {
  const dates = ['2026-09-09', '2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05', '2026-09-04'];
  assert.deepEqual(douBackfillBatches(dates), [dates.slice(0, 4), dates.slice(4)]);
  assert.throws(() => douBackfillBatches(dates, 5), RangeError);
});


test('backfill coverage uses exactly the same four-section policy as collection', () => {
  assert.strictEqual(DOU_BACKFILL_SECTIONS, DOU_XML_SECTIONS);
  assert.deepEqual(DOU_BACKFILL_SECTIONS, ['DO1', 'DO1E', 'DO3', 'DO3E']);
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO3', 'DO3E'])), true);
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO3'])), false, 'a real enabled-section gap stays incomplete');
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO2', 'DO2E'])), false, 'historical excluded sections never prove coverage');
  assert.equal(isDouBackfillCoverageComplete(new Set(['DO1', 'DO1E', 'DO2', 'DO2E', 'DO3', 'DO3E'])), true, 'six-section historical evidence stays compatible');
});

test('anti-loop planning does not requeue a date once the four enabled sections are proven', () => {
  const date = '2026-09-18';
  const consulted = new Set<string>(['DO1', 'DO1E', 'DO3', 'DO3E']);
  const covered = isDouBackfillCoverageComplete(consulted) ? new Set([date]) : new Set<string>();
  for (let pass = 0; pass < 3; pass += 1) {
    assert.deepEqual(planDouBackfillDates({ from: date, to: date, today: '2026-10-04', covered }), []);
  }
});
