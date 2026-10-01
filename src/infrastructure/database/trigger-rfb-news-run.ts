import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to trigger RFB news.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const source = await client.query<{
      id: string;
      is_active: boolean;
      connector_key: string;
      content_kind: string;
    }>(
      `SELECT id, is_active, connector_key, content_kind
       FROM sources
       WHERE code = 'rfb-news'
       FOR UPDATE`,
    );

    const row = source.rows[0];
    if (!row) throw new Error('RFB_NEWS_SOURCE_NOT_FOUND');
    if (!row.is_active) throw new Error('RFB_NEWS_SOURCE_NOT_ACTIVE');
    if (row.connector_key !== 'rfb-news' || row.content_kind !== 'NEWS') {
      throw new Error('RFB_NEWS_SOURCE_CONTRACT_MISMATCH');
    }

    const active = await client.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM collection_runs
       WHERE source_id = $1
         AND status IN ('PENDING', 'RUNNING')
       ORDER BY created_at
       LIMIT 1`,
      [row.id],
    );

    if (active.rows[0]) {
      await client.query('COMMIT');
      console.log('RFB_NEWS_TRIGGER=' + JSON.stringify({
        created: false,
        runId: active.rows[0].id,
        status: active.rows[0].status,
        reason: 'ACTIVE_RUN_EXISTS',
      }));
      process.exit(0);
    }

    const inserted = await client.query<{ id: string; scheduled_for: Date }>(
      `INSERT INTO collection_runs (
         source_id, scheduled_for, trigger_type, status
       ) VALUES (
         $1,
         date_trunc('minute', now()),
         'MANUAL',
         'PENDING'
       )
       ON CONFLICT (source_id, scheduled_for, trigger_type)
       DO NOTHING
       RETURNING id, scheduled_for`,
      [row.id],
    );

    let run = inserted.rows[0];
    if (!run) {
      const existing = await client.query<{ id: string; scheduled_for: Date }>(
        `SELECT id, scheduled_for
         FROM collection_runs
         WHERE source_id = $1
           AND scheduled_for = date_trunc('minute', now())
           AND trigger_type = 'MANUAL'
         LIMIT 1`,
        [row.id],
      );
      run = existing.rows[0];
    }

    if (!run) throw new Error('RFB_NEWS_RUN_NOT_CREATED');

    await client.query('COMMIT');
    console.log('RFB_NEWS_TRIGGER=' + JSON.stringify({
      created: Boolean(inserted.rows[0]),
      runId: run.id,
      scheduledFor: run.scheduled_for.toISOString(),
      status: 'PENDING',
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
