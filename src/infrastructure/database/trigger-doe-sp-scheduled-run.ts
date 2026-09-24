import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query(
      `SELECT id, connector_key, is_active, schedule_cron, schedule_timezone
       FROM sources WHERE code = 'doe-sp' FOR UPDATE`,
    );
    const row = source.rows[0];
    if (!row) throw new Error('DOE-SP source is not provisioned.');
    if (row.connector_key !== 'doe-sp' || row.is_active !== true) {
      throw new Error('DOE-SP source is not active with the expected connector key.');
    }
    if (row.schedule_cron !== '0 * * * *' || row.schedule_timezone !== 'America/Sao_Paulo') {
      throw new Error('DOE-SP hourly schedule is not active.');
    }

    const active = await client.query(
      `SELECT id, status FROM collection_runs
       WHERE source_id = $1 AND status IN ('PENDING', 'RUNNING')
       ORDER BY created_at LIMIT 1`,
      [row.id],
    );
    if (active.rows[0]) {
      throw new Error('DOE-SP already has an active run: ' + active.rows[0].id + ' (' + active.rows[0].status + ').');
    }

    const slot = await client.query(`SELECT date_trunc('hour', now()) AS scheduled_for`);
    const scheduledFor = slot.rows[0].scheduled_for;

    const existing = await client.query(
      `SELECT id, status, scheduled_for
       FROM collection_runs
       WHERE source_id = $1 AND trigger_type = 'SCHEDULED' AND scheduled_for = $2
       ORDER BY created_at DESC LIMIT 1`,
      [row.id, scheduledFor],
    );

    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      console.log('DOE_SP_SCHEDULED_RUN=' + JSON.stringify({
        sourceId: row.id,
        scheduleCron: row.schedule_cron,
        scheduleTimezone: row.schedule_timezone,
        reused: true,
        ...existing.rows[0],
      }));
    } else {
      const run = await client.query(
        `INSERT INTO collection_runs (source_id, scheduled_for, trigger_type, status)
         VALUES ($1, $2, 'SCHEDULED', 'PENDING')
         RETURNING id, scheduled_for, status`,
        [row.id, scheduledFor],
      );
      await client.query('COMMIT');
      console.log('DOE_SP_SCHEDULED_RUN=' + JSON.stringify({
        sourceId: row.id,
        scheduleCron: row.schedule_cron,
        scheduleTimezone: row.schedule_timezone,
        reused: false,
        ...run.rows[0],
      }));
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
