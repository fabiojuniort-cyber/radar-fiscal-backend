import { Pool } from 'pg';

import { env } from '../../config/env.js';

const ACTIVATION_RUN_AT = new Date('2026-10-01T13:00:00.000Z');

const connectionString = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  max: 1,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
});

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sourceResult = await client.query<{
      id: string;
      connector_key: string;
      content_kind: string;
      is_active: boolean;
    }>(`
      SELECT id, connector_key, content_kind, is_active
      FROM sources
      WHERE code = 'rfb-news'
      FOR UPDATE
    `);

    const source = sourceResult.rows[0];
    if (!source) {
      throw new Error('RFB_NEWS_SOURCE_NOT_FOUND');
    }
    if (source.connector_key !== 'rfb-news') {
      throw new Error('RFB_NEWS_CONNECTOR_MISMATCH');
    }
    if (source.content_kind !== 'NEWS') {
      throw new Error('RFB_NEWS_CONTENT_KIND_MISMATCH');
    }

    const wasActive = source.is_active;

    await client.query(`
      UPDATE sources
      SET is_active = true,
          updated_at = now()
      WHERE id = $1::uuid
    `, [source.id]);

    const runResult = await client.query<{ id: string; status: string }>(`
      INSERT INTO collection_runs (
        source_id,
        scheduled_for,
        trigger_type,
        status
      )
      VALUES ($1::uuid, $2::timestamptz, 'MANUAL', 'PENDING')
      ON CONFLICT (source_id, scheduled_for, trigger_type)
      DO UPDATE SET updated_at = collection_runs.updated_at
      RETURNING id, status
    `, [source.id, ACTIVATION_RUN_AT.toISOString()]);

    const run = runResult.rows[0];
    if (!run) {
      throw new Error('RFB_NEWS_INITIAL_RUN_NOT_CREATED');
    }

    await client.query('COMMIT');

    console.log('RFB_NEWS_ACTIVATION=' + JSON.stringify({
      ok: true,
      sourceId: source.id,
      wasActive,
      isActive: true,
      runId: run.id,
      runStatus: run.status,
      scheduledFor: ACTIVATION_RUN_AT.toISOString(),
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
