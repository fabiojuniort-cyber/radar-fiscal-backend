import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required to enqueue RFB news.');
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

    if (!wasActive) {
      await client.query(
        `UPDATE sources
         SET is_active = TRUE,
             updated_at = now()
         WHERE id = $1::uuid`,
        [source.id],
      );
    }

    const activeRunResult = await client.query<{
      id: string;
      status: string;
      scheduled_for: Date;
    }>(
      `SELECT id, status, scheduled_for
       FROM collection_runs
       WHERE source_id = $1::uuid
         AND status IN ('PENDING', 'RUNNING')
       ORDER BY created_at DESC
       LIMIT 1`,
      [source.id],
    );

    let run = activeRunResult.rows[0];
    let runCreated = false;

    if (!run) {
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
           now() - interval '1 second',
           'MANUAL',
           'PENDING'
         )
         RETURNING id, status, scheduled_for`,
        [source.id],
      );

      run = inserted.rows[0];
      runCreated = true;
    }

    if (!run) throw new Error('RFB_NEWS_RUN_NOT_FOUND');

    await client.query('COMMIT');

    console.log(
      'RFB_NEWS_ENQUEUE=' +
        JSON.stringify({
          ok: true,
          sourceId: source.id,
          wasActive,
          isActive: true,
          runCreated,
          runId: run.id,
          runStatus: run.status,
          scheduledFor: run.scheduled_for.toISOString(),
        }),
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
