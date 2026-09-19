import assert from 'node:assert/strict';
import test from 'node:test';

import {
  floorToUtcMinute,
  isCronDue,
} from '../src/modules/collection/cron.js';

test('cron matcher handles exact time in source timezone', () => {
  const instant = new Date(
    '2026-09-19T11:00:00Z',
  );

  assert.equal(
    isCronDue(
      '0 8 * * *',
      instant,
      'America/Sao_Paulo',
    ),
    true,
  );

  assert.equal(
    isCronDue(
      '0 9 * * *',
      instant,
      'America/Sao_Paulo',
    ),
    false,
  );
});

test('cron matcher supports steps, lists and ranges', () => {
  const instant = new Date(
    '2026-09-19T11:10:00Z',
  );

  assert.equal(
    isCronDue(
      '*/5 8 1-31 1,9,12 *',
      instant,
      'America/Sao_Paulo',
    ),
    true,
  );
});

test('cron matcher accepts Sunday as 0 or 7', () => {
  const sunday = new Date(
    '2026-09-20T11:00:00Z',
  );

  assert.equal(
    isCronDue(
      '0 8 * * 0',
      sunday,
      'America/Sao_Paulo',
    ),
    true,
  );

  assert.equal(
    isCronDue(
      '0 8 * * 7',
      sunday,
      'America/Sao_Paulo',
    ),
    true,
  );
});

test('cron matcher uses standard DOM/DOW OR semantics', () => {
  const saturday19 = new Date(
    '2026-09-19T11:00:00Z',
  );

  assert.equal(
    isCronDue(
      '0 8 1 * 6',
      saturday19,
      'America/Sao_Paulo',
    ),
    true,
  );
});

test('invalid cron expressions fail explicitly', () => {
  assert.throws(
    () =>
      isCronDue(
        '61 * * * *',
        new Date(),
        'UTC',
      ),
    /out of range/,
  );

  assert.throws(
    () =>
      isCronDue(
        '* * *',
        new Date(),
        'UTC',
      ),
    /5 fields/,
  );
});

test('floorToUtcMinute removes seconds and milliseconds', () => {
  assert.equal(
    floorToUtcMinute(
      new Date('2026-09-19T12:34:56.789Z'),
    ).toISOString(),
    '2026-09-19T12:34:00.000Z',
  );
});
