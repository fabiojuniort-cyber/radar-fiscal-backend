import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const sourceResult = await pool.query(
    `SELECT id, code, base_url, connector_key, schedule_cron, schedule_timezone, max_attempts, is_active
     FROM sources
     WHERE code = 'sped'`,
  );
  const source = sourceResult.rows[0] ?? null;

  let runs: unknown[] = [];
  let attempts: unknown[] = [];
  if (source) {
    runs = (await pool.query(
      `SELECT id, status, trigger_type, scheduled_for, started_at, finished_at, created_at
       FROM collection_runs
       WHERE source_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [source.id],
    )).rows;

    attempts = (await pool.query(
      `SELECT ca.id, ca.collection_run_id, ca.attempt_no, ca.status, ca.error_code,
              ca.started_at, ca.finished_at, ca.created_at
       FROM collection_attempts ca
       JOIN collection_runs cr ON cr.id = ca.collection_run_id
       WHERE cr.source_id = $1
       ORDER BY ca.created_at DESC
       LIMIT 20`,
      [source.id],
    )).rows;
  }

  console.log('SPED_ADMIN_STATE=' + JSON.stringify({ source, runs, attempts }));
} finally {
  await pool.end();
}
