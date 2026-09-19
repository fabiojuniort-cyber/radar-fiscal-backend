import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required to inspect CONFAZ.',
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

try {
  const source = await pool.query(
    `
      SELECT
        id,
        code,
        connector_key,
        schedule_cron,
        schedule_timezone,
        max_attempts,
        is_active,
        updated_at
      FROM sources
      WHERE code = 'confaz'
    `,
  );

  if (source.rows.length === 0) {
    console.log('CONFAZ_INSPECTION=' + JSON.stringify({ source: null }));
    process.exit(0);
  }

  const sourceId = source.rows[0].id as string;

  const runs = await pool.query(
    `
      SELECT
        r.id,
        r.trigger_type,
        r.status,
        r.scheduled_for,
        r.started_at,
        r.finished_at,
        r.source_consulted_at,
        r.error_summary,
        a.attempt_no,
        a.status AS attempt_status,
        a.error_code,
        a.retryable,
        a.response_time_ms
      FROM collection_runs r
      LEFT JOIN LATERAL (
        SELECT
          attempt_no,
          status,
          error_code,
          retryable,
          response_time_ms
        FROM collection_attempts
        WHERE collection_run_id = r.id
        ORDER BY attempt_no DESC
        LIMIT 1
      ) a ON TRUE
      WHERE r.source_id = $1
      ORDER BY r.created_at DESC
      LIMIT 5
    `,
    [sourceId],
  );

  const publications = await pool.query(
    `
      SELECT
        p.act_type,
        p.act_number,
        p.title,
        p.published_on,
        p.effective_on,
        p.identity_strength,
        o.official_url,
        o.external_id,
        v.version_no,
        v.content_hash,
        LEFT(COALESCE(v.content_text, ''), 500) AS content_excerpt
      FROM publication_origins o
      JOIN publications p
        ON p.id = o.publication_id
      JOIN publication_versions v
        ON v.publication_id = p.id
       AND v.is_current = TRUE
      WHERE o.source_id = $1
      ORDER BY p.published_on DESC NULLS LAST, p.act_number DESC
      LIMIT 12
    `,
    [sourceId],
  );

  const counts = await pool.query(
    `
      SELECT
        COUNT(DISTINCT o.publication_id)::int AS publications,
        COUNT(v.id)::int AS versions
      FROM publication_origins o
      JOIN publication_versions v
        ON v.publication_id = o.publication_id
      WHERE o.source_id = $1
    `,
    [sourceId],
  );

  console.log(
    'CONFAZ_INSPECTION=' +
      JSON.stringify({
        source: source.rows[0],
        counts: counts.rows[0],
        runs: runs.rows,
        publications: publications.rows,
      }),
  );
} finally {
  await pool.end();
}
