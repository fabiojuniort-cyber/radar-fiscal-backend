import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to inspect RFB Normas.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const sourceResult = await pool.query(`
    SELECT id, code, connector_key, base_url, schedule_cron, schedule_timezone,
           max_attempts, is_active, connector_config
    FROM sources WHERE code = 'rfb-normas'
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error('RFB Normas source is not provisioned.');
  const sourceId = source.id;

  const [runs, categoryCounts, typeCounts, fileStats, duplicateOrigins, versionStats, crossSource, gates] = await Promise.all([
    pool.query(`
      SELECT
        cr.id, cr.trigger_type, cr.status, cr.scheduled_for, cr.started_at, cr.finished_at,
        cr.error_summary,
        COALESCE((
          SELECT jsonb_object_agg(disposition, count)
          FROM (
            SELECT disposition, count(*)::int AS count
            FROM collection_run_publications crp
            WHERE crp.collection_run_id = cr.id
            GROUP BY disposition
          ) d
        ), '{}'::jsonb) AS dispositions,
        (SELECT count(*)::int FROM collection_items ci WHERE ci.collection_run_id = cr.id AND ci.status = 'FAILED') AS item_errors,
        (SELECT jsonb_agg(jsonb_build_object(
          'attemptNo', ca.attempt_no,
          'status', ca.status,
          'responseTimeMs', ca.response_time_ms,
          'errorCode', ca.error_code,
          'publicationCount', COALESCE((ca.metadata->>'publicationCount')::int, 0),
          'partialFailureCount', COALESCE((ca.metadata->'rfbNormas'->>'partialFailureCount')::int, 0),
          'rfbNormas', ca.metadata->'rfbNormas'
        ) ORDER BY ca.attempt_no)
        FROM collection_attempts ca WHERE ca.collection_run_id = cr.id) AS attempts
      FROM collection_runs cr
      WHERE cr.source_id = $1
      ORDER BY cr.created_at DESC
      LIMIT 12
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(po.metadata->>'captureCategory', 'UNKNOWN') AS category,
             count(DISTINCT po.publication_id)::int AS publications
      FROM publication_origins po
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY 1
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(p.act_type, 'UNKNOWN') AS act_type,
             count(DISTINCT p.id)::int AS publications
      FROM publication_origins po
      JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY 1
    `, [sourceId]),
    pool.query(`
      SELECT
        count(*)::int AS file_entries,
        count(*) FILTER (WHERE file_entry->>'rawSha256' ~ '^[a-f0-9]{64}$')::int AS valid_sha256,
        count(*) FILTER (WHERE NULLIF(file_entry->>'url','') IS NOT NULL)::int AS files_with_url
      FROM publication_origins po
      JOIN publication_versions pv ON pv.publication_id = po.publication_id AND pv.is_current = TRUE
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pv.source_metadata->'files','[]'::jsonb)) file_entry
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT external_id, count(*)::int AS count
      FROM publication_origins
      WHERE source_id = $1 AND external_id IS NOT NULL
      GROUP BY external_id HAVING count(*) > 1
      ORDER BY count DESC, external_id
    `, [sourceId]),
    pool.query(`
      SELECT
        count(DISTINCT p.id)::int AS publications,
        count(pv.id)::int AS versions,
        count(*) FILTER (WHERE pv.is_current)::int AS current_versions,
        count(*) FILTER (WHERE NOT pv.is_current)::int AS historical_versions
      FROM publication_origins po
      JOIN publications p ON p.id = po.publication_id
      JOIN publication_versions pv ON pv.publication_id = p.id
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT p.id, p.act_type, p.act_number, p.title,
             count(DISTINCT po.source_id)::int AS source_count,
             jsonb_agg(DISTINCT s.code) AS source_codes,
             (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id) AS version_count
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id
      JOIN sources s ON s.id = po.source_id
      WHERE p.id IN (
        SELECT publication_id FROM publication_origins WHERE source_id = $1
      )
      GROUP BY p.id, p.act_type, p.act_number, p.title
      HAVING count(DISTINCT po.source_id) > 1
      ORDER BY source_count DESC, p.title
      LIMIT 100
    `, [sourceId]),
    pool.query(`
      SELECT p.id, p.agency, p.act_type, p.act_number, p.title, p.published_on,
             po.external_id, po.official_url,
             po.metadata->'rfbNormas'->'representations' AS representations,
             po.metadata->>'captureCategory' AS category,
             (SELECT count(*)::int FROM publication_versions pv WHERE pv.publication_id = p.id) AS version_count
      FROM publication_origins po
      JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1
        AND (
          p.act_type = 'INSTRUÇÃO NORMATIVA'
          OR p.act_type IN ('SOLUÇÃO DE CONSULTA','SOLUÇÃO DE DIVERGÊNCIA')
          OR p.act_type = 'ATO TÉCNICO CONJUNTO'
        )
      ORDER BY p.published_on DESC NULLS LAST, p.act_type, p.act_number
      LIMIT 40
    `, [sourceId]),
  ]);

  console.log('RFB_NORMAS_INSPECTION=' + JSON.stringify({
    source,
    runs: runs.rows,
    categoryCounts: categoryCounts.rows,
    typeCounts: typeCounts.rows,
    fileStats: fileStats.rows[0],
    duplicateOrigins: duplicateOrigins.rows,
    versionStats: versionStats.rows[0],
    crossSource: crossSource.rows,
    gates: gates.rows,
  }));
} finally {
  await pool.end();
}
