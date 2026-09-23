import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to trigger a CGIBS run.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query(
      `SELECT id, connector_key, is_active, schedule_cron FROM sources WHERE code = 'cgibs' FOR UPDATE`,
    );
    const row = source.rows[0];
    if (!row) throw new Error('CGIBS source is not provisioned.');
    if (row.connector_key !== 'cgibs' || row.is_active !== true) {
      throw new Error('CGIBS source is not active with the expected connector key.');
    }

    const active = await client.query(
      `
        SELECT id, status FROM collection_runs
        WHERE source_id = $1 AND status IN ('PENDING', 'RUNNING')
        ORDER BY created_at LIMIT 1
      `,
      [row.id],
    );
    if (active.rows[0]) {
      throw new Error('CGIBS already has an active run: ' + active.rows[0].id + ' (' + active.rows[0].status + ').');
    }

    const run = await client.query(
      `
        INSERT INTO collection_runs (source_id, scheduled_for, trigger_type, status)
        VALUES ($1, now(), 'MANUAL', 'PENDING')
        RETURNING id, scheduled_for, status
      `,
      [row.id],
    );

    await client.query('COMMIT');
    console.log('CGIBS_RUN=' + JSON.stringify({ sourceId: row.id, scheduleCron: row.schedule_cron, ...run.rows[0] }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
