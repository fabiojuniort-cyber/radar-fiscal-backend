import 'dotenv/config';

import { Pool } from 'pg';

const ACTIVATION_RUN_AT = new Date('2026-10-01T13:00:00.000Z');

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required to activate RFB news.');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sourceResult = await client.query<{
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

    const source = sourceResult.rows[0];
    if (!source) throw new Error('RFB_NEWS_SOURCE_NOT_FOUND');
    if (source.connector_key !== 'rfb-news' || source.content_kind !== 'NEWS') {
      throw new Error('RFB_NEWS_SOURCE_CONTRACT_MISMATCH');
    }

    const wasActive = source.is_active;

    await client.query(
      `UPDATE sources
       SET is_active = TRUE,
           updated_at = now()
       WHERE id = $1::uuid`,
      [source.id],
    );

    const inserted = await client.query<{
      id: string;
      status: string;
      scheduled_for: Date;
    }>(
      `INSERT INTO collection_runs (
         source_id,
         scheduled_for,
         trigger_type,
         status
       ) VALUES (
         $1::uuid,
         $2::timestamptz,
         'MANUAL',
         'PENDING'
       )
       ON CONFLICT (source_id, scheduled_for, trigger_type)
       DO NOTHING
       RETURNING id, status, scheduled_for`,
      [source.id, ACTIVATION_RUN_AT.toISOString()],
    );

    let run = inserted.rows[0];
    if (!run) {
      const existing = await client.query<{
        id: string;
        status: string;
        scheduled_for: Date;
      }>(
        `SELECT id, status, scheduled_for
         FROM collection_runs
         WHERE source_id = $1::uuid
           AND scheduled_for = $2::timestamptz
           AND trigger_type = 'MANUAL'
         LIMIT 1`,
        [source.id, ACTIVATION_RUN_AT.toISOString()],
      );
      run = existing.rows[0];
    }

    if (!run) throw new Error('RFB_NEWS_INITIAL_RUN_NOT_FOUND');

    await client.query('COMMIT');

    console.log('RFB_NEWS_ACTIVATION=' + JSON.stringify({
      ok: true,
      sourceId: source.id,
      wasActive,
      isActive: true,
      runCreated: Boolean(inserted.rows[0]),
      runId: run.id,
      runStatus: run.status,
      scheduledFor: run.scheduled_for.toISOString(),
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
