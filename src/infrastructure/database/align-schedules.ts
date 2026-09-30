import 'dotenv/config';

import { Pool } from 'pg';

import {
  D056_SCHEDULES,
  D056_TIMEZONE,
} from '../../modules/collection/schedule-policy.js';

/**
 * Aligns the schedules of finalized engines with D-056 (06h/10h/14h/18h BRT).
 *
 * Dry-run by default: prints current and target schedules and changes nothing.
 *   --apply             write the D-056 schedules
 *   --restore-previous  rollback: write the schedules in use before D-056
 * Idempotent; only rows whose schedule differs are updated, inside one
 * transaction. Inactive sources and sources without a schedule are reported
 * and left untouched (activation is each source's own gate).
 */
const apply = process.argv.includes('--apply');
const restore = process.argv.includes('--restore-previous');
if (apply && restore) {
  console.error('Use either --apply or --restore-previous, not both.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to align schedules.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const current = await client.query<{
    code: string;
    schedule_cron: string | null;
    schedule_timezone: string;
    is_active: boolean;
  }>(
    `SELECT code, schedule_cron, schedule_timezone, is_active
       FROM sources
      WHERE code = ANY($1::text[])
      ORDER BY code
      FOR UPDATE`,
    [D056_SCHEDULES.map((entry) => entry.code)],
  );
  const byCode = new Map(current.rows.map((row) => [row.code, row]));

  const plan = D056_SCHEDULES.map((entry) => {
    const row = byCode.get(entry.code);
    const target = restore ? entry.previousCron : entry.cron;
    if (!row) return { code: entry.code, action: 'MISSING', current: null, target };
    const eligible = row.is_active && row.schedule_cron !== null;
    const aligned = row.schedule_cron === target && row.schedule_timezone === D056_TIMEZONE;
    return {
      code: entry.code,
      action: !eligible ? 'SKIPPED_NOT_SCHEDULED' : aligned ? 'UNCHANGED' : 'UPDATE',
      current: { cron: row.schedule_cron, timezone: row.schedule_timezone, active: row.is_active },
      target,
    };
  });

  const writing = apply || restore;
  if (writing) {
    for (const item of plan.filter((entry) => entry.action === 'UPDATE')) {
      await client.query(
        `UPDATE sources
            SET schedule_cron = $2, schedule_timezone = $3, updated_at = now()
          WHERE code = $1 AND is_active = TRUE AND schedule_cron IS NOT NULL`,
        [item.code, item.target, D056_TIMEZONE],
      );
    }
    await client.query('COMMIT');
  } else {
    await client.query('ROLLBACK');
  }

  console.log(`SCHEDULE_ALIGNMENT=${JSON.stringify({
    mode: restore ? 'RESTORE_PREVIOUS' : apply ? 'APPLY' : 'DRY_RUN',
    decision: 'D-056',
    timezone: D056_TIMEZONE,
    plan,
    updated: writing ? plan.filter((entry) => entry.action === 'UPDATE').map((entry) => entry.code) : [],
  })}`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
