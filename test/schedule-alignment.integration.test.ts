import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { Pool } from 'pg';

import { D056_SCHEDULES } from '../src/modules/collection/schedule-policy.js';

// Uses the real source codes: run in its own test process (see package.json).
test('schedule alignment is dry-run by default, idempotent on apply and reversible', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for schedule alignment integration tests.');
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const codes = D056_SCHEDULES.map((entry) => entry.code);
  const snapshot = await pool.query(
    'SELECT code, schedule_cron, schedule_timezone, is_active FROM sources WHERE code = ANY($1::text[])',
    [codes],
  );
  const inserted: string[] = [];

  const run = (...args: string[]) => {
    const output = execFileSync('npx', ['tsx', 'src/infrastructure/database/align-schedules.ts', ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
    });
    const line = output.split('\n').find((value) => value.startsWith('SCHEDULE_ALIGNMENT='));
    assert.ok(line, output);
    return JSON.parse(line.slice('SCHEDULE_ALIGNMENT='.length)) as {
      mode: string; updated: string[]; plan: Array<{ code: string; action: string }>;
    };
  };
  const schedules = async () => Object.fromEntries((await pool.query<{ code: string; schedule_cron: string | null }>(
    'SELECT code, schedule_cron FROM sources WHERE code = ANY($1::text[])', [codes],
  )).rows.map((row) => [row.code, row.schedule_cron]));
  const timezones = async () => Object.fromEntries((await pool.query<{ code: string; schedule_timezone: string }>(
    'SELECT code, schedule_timezone FROM sources WHERE code = ANY($1::text[])', [codes],
  )).rows.map((row) => [row.code, row.schedule_timezone]));

  try {
    for (const entry of D056_SCHEDULES) {
      // Inactive CONFAZ proves inactive sources are never touched.
      const active = entry.code !== 'confaz';
      const result = await pool.query(
        `INSERT INTO sources (code, name, jurisdiction_level, base_url, connector_key, schedule_cron, schedule_timezone, is_active)
         VALUES ($1, $1, 'FEDERAL', 'https://alignment.example.test', $1, $2, 'America/Sao_Paulo', $3)
         ON CONFLICT (code) DO UPDATE SET schedule_cron = EXCLUDED.schedule_cron,
           schedule_timezone = EXCLUDED.schedule_timezone, is_active = EXCLUDED.is_active
         RETURNING (xmax = 0) AS inserted`,
        [entry.code, entry.previousCron, active],
      );
      if (result.rows[0]?.inserted) inserted.push(entry.code);
    }
    const before = await schedules();
    const timezonesBefore = await timezones();

    const dry = run();
    assert.equal(dry.mode, 'DRY_RUN');
    assert.deepEqual(dry.updated, []);
    assert.deepEqual(await schedules(), before, 'dry-run changes nothing');

    const applied = run('--apply');
    assert.deepEqual([...applied.updated].sort(), codes.filter((code) => code !== 'confaz').sort());
    const after = await schedules();
    for (const entry of D056_SCHEDULES) {
      assert.equal(after[entry.code], entry.code === 'confaz' ? entry.previousCron : entry.cron, entry.code);
    }
    assert.equal(applied.plan.find((item) => item.code === 'confaz')?.action, 'SKIPPED_NOT_SCHEDULED');

    assert.deepEqual(run('--apply').updated, [], 'idempotent');

    const restored = run('--restore-previous');
    assert.equal(restored.mode, 'RESTORE_PREVIOUS');
    assert.deepEqual(await schedules(), before, 'rollback restores the previous schedules');
    assert.deepEqual(await timezones(), timezonesBefore, 'rollback restores the previous timezones');
  } finally {
    if (inserted.length) await pool.query('DELETE FROM sources WHERE code = ANY($1::text[])', [inserted]);
    for (const row of snapshot.rows) {
      await pool.query(
        'UPDATE sources SET schedule_cron = $2, schedule_timezone = $3, is_active = $4 WHERE code = $1',
        [row.code, row.schedule_cron, row.schedule_timezone, row.is_active],
      );
    }
    await pool.end();
  }
});
