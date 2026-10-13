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
        a.response_time_ms,
        a.metadata->>'route' AS route,
        a.metadata->>'sourceConsulted' AS source_consulted,
        a.metadata->>'failureClass' AS failure_class,
        a.metadata->>'publicationCount' AS discovered
      FROM collection_runs r
      LEFT JOIN LATERAL (
        SELECT
          attempt_no,
          status,
          error_code,
          retryable,
          response_time_ms,
          metadata
        FROM collection_attempts
        WHERE collection_run_id = r.id
        ORDER BY attempt_no DESC
        LIMIT 1
      ) a ON TRUE
      WHERE r.source_id = $1
      ORDER BY r.created_at DESC
      LIMIT 10
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

  // D-006: DOU is the PRIMARY channel for formally published CONFAZ acts.
  // Coverage must stay visible even while the portal is unreachable, and the
  // portal/DOU overlap proves both origins attach to one global publication.
  const douCoverage = await pool.query(
    `
      SELECT
        p.act_type,
        COUNT(DISTINCT p.id)::int AS publications,
        MAX(p.published_on) AS latest_published_on,
        MAX(o.last_seen_at) AS latest_seen_at
      FROM publications p
      JOIN publication_origins o ON o.publication_id = p.id
      JOIN sources s ON s.id = o.source_id AND s.code = 'dou'
      WHERE p.agency = 'CONFAZ'
      GROUP BY p.act_type
      ORDER BY publications DESC
    `,
  );

  const douLatest = await pool.query(
    `
      SELECT
        p.act_type,
        p.act_number,
        p.published_on,
        p.identity_strength,
        o.official_url,
        o.external_id
      FROM publications p
      JOIN publication_origins o ON o.publication_id = p.id
      JOIN sources s ON s.id = o.source_id AND s.code = 'dou'
      WHERE p.agency = 'CONFAZ'
        AND p.act_number IS NOT NULL
      ORDER BY p.published_on DESC NULLS LAST, p.act_number DESC
      LIMIT 12
    `,
  );

  const overlap = await pool.query(
    `
      SELECT COUNT(*)::int AS publications_with_portal_and_dou_origins
      FROM publications p
      WHERE EXISTS (
        SELECT 1 FROM publication_origins o
        WHERE o.publication_id = p.id AND o.source_id = $1
      )
      AND EXISTS (
        SELECT 1 FROM publication_origins o
        JOIN sources s ON s.id = o.source_id AND s.code = 'dou'
        WHERE o.publication_id = p.id
      )
    `,
    [sourceId],
  );

  const douRuns = await pool.query(
    `
      SELECT
        r.id,
        r.status,
        r.started_at,
        r.finished_at,
        (SELECT MAX(attempt_no) FROM collection_attempts a WHERE a.collection_run_id = r.id) AS attempts,
        LEFT(COALESCE(r.error_summary, ''), 200) AS error_summary
      FROM collection_runs r
      JOIN sources s ON s.id = r.source_id AND s.code = 'dou'
      ORDER BY r.created_at DESC
      LIMIT 5
    `,
  );

  const lastPortalRun = runs.rows[0] as Record<string, unknown> | undefined;

  console.log(
    'CONFAZ_INSPECTION=' +
      JSON.stringify({
        source: source.rows[0],
        summary: {
          portalLastRunStatus: lastPortalRun?.status ?? null,
          portalConsulted: lastPortalRun?.source_consulted ?? null,
          portalRoute: lastPortalRun?.route ?? null,
          portalFailureClass: lastPortalRun?.failure_class ?? null,
          portalErrorCode: lastPortalRun?.error_code ?? null,
          douLastRunStatus: (douRuns.rows[0] as Record<string, unknown> | undefined)?.status ?? null,
          confazActsViaDou: douCoverage.rows.reduce(
            (total: number, row: { publications: number }) => total + row.publications,
            0,
          ),
          ...overlap.rows[0],
        },
        counts: counts.rows[0],
        runs: runs.rows,
        publications: publications.rows,
        dou: {
          runs: douRuns.rows,
          confazCoverageByActType: douCoverage.rows,
          latestConfazActs: douLatest.rows,
        },
      }),
  );
} finally {
  await pool.end();
}
