import 'dotenv/config';

import http from 'node:http';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const token = process.env.ADMIN_PROBE_TOKEN;
const port = Number(process.env.PORT ?? '3000');

if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
if (!token) throw new Error('ADMIN_PROBE_TOKEN is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== token) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }

    const sourceResult = await pool.query(
      `SELECT id, code, base_url, connector_key, schedule_cron, schedule_timezone, max_attempts, is_active
       FROM sources WHERE code = 'sped'`,
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
        `SELECT ca.id, ca.run_id, ca.attempt_no, ca.status, ca.error_code,
                ca.started_at, ca.finished_at, ca.created_at
         FROM collection_attempts ca
         JOIN collection_runs cr ON cr.id = ca.run_id
         WHERE cr.source_id = $1
         ORDER BY ca.created_at DESC
         LIMIT 20`,
        [source.id],
      )).rows;
    }

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ source, runs, attempts }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log('SPED_ADMIN_PROBE_READY=1');
});

const shutdown = async () => {
  server.close();
  await pool.end();
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
