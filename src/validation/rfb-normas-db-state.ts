import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const sourceResult = await pool.query(`
    SELECT id, code, connector_key, base_url, schedule_cron, schedule_timezone,
           max_attempts, is_active, connector_config
      FROM sources
     WHERE code = 'rfb-normas'
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error('RFB Normas source is not provisioned.');
  const sourceId = source.id;

  const [runs, checkpoint, totals, categories, types, files, duplicates, crossSource, multiVersions, sampleFiles] = await Promise.all([
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
          ) x
        ), '{}'::jsonb) AS dispositions,
        (SELECT count(*)::int FROM collection_items ci
          WHERE ci.collection_run_id = cr.id AND ci.status = 'FAILED') AS item_errors,
        (SELECT jsonb_agg(jsonb_build_object(
          'attemptNo', ca.attempt_no,
          'status', ca.status,
          'responseTimeMs', ca.response_time_ms,
          'errorCode', ca.error_code,
          'publicationCount', COALESCE((ca.metadata->>'publicationCount')::int, 0),
          'mode', ca.metadata->'rfbNormas'->>'mode',
          'bootstrap', ca.metadata->'rfbNormas'->'bootstrap',
          'partialFailureCount', COALESCE((ca.metadata->'rfbNormas'->>'partialFailureCount')::int, 0),
          'discoveredCount', COALESCE((ca.metadata->'rfbNormas'->'filtering'->>'discoveredCount')::int, 0),
          'includedCount', COALESCE((ca.metadata->'rfbNormas'->'filtering'->>'includedCount')::int, 0),
          'excludedCount', COALESCE((ca.metadata->'rfbNormas'->'filtering'->>'excludedCount')::int, 0),
          'includedByCategory', ca.metadata->'rfbNormas'->'filtering'->'includedByCategory',
          'excludedByReason', ca.metadata->'rfbNormas'->'filtering'->'excludedByReason',
          'counters', ca.metadata->'rfbNormas'->'counters'
        ) ORDER BY ca.attempt_no)
        FROM collection_attempts ca WHERE ca.collection_run_id = cr.id) AS attempts
      FROM collection_runs cr
      WHERE cr.source_id = $1
      ORDER BY cr.created_at DESC
      LIMIT 8
    `, [sourceId]),
    pool.query(`
      SELECT cc.id, cc.generation, cc.state_version, cc.created_at,
             cc.produced_by_run_id, cr.status AS produced_by_run_status,
             cc.payload->'bootstrap' AS bootstrap,
             cc.payload->>'lastSuccessAt' AS last_success_at,
             COALESCE((SELECT count(*)::int FROM jsonb_object_keys(COALESCE(cc.payload->'files','{}'::jsonb))), 0) AS checkpoint_files,
             cc.payload_bytes, cc.payload_sha256
      FROM collection_checkpoints cc
      LEFT JOIN collection_runs cr ON cr.id = cc.produced_by_run_id
      WHERE cc.source_id = $1 AND cc.connector_key = 'rfb-normas'
      ORDER BY cc.generation DESC
      LIMIT 3
    `, [sourceId]),
    pool.query(`
      SELECT
        count(DISTINCT po.publication_id)::int AS publications,
        count(DISTINCT po.id)::int AS origins,
        count(DISTINCT pv.id)::int AS versions,
        count(DISTINCT pv.id) FILTER (WHERE pv.is_current)::int AS current_versions,
        count(DISTINCT pv.id) FILTER (WHERE NOT pv.is_current)::int AS historical_versions
      FROM publication_origins po
      JOIN publication_versions pv ON pv.publication_id = po.publication_id
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(po.metadata->>'captureCategory','UNKNOWN') AS category,
             count(DISTINCT po.publication_id)::int AS publications
      FROM publication_origins po
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY 1
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(p.act_type,'UNKNOWN') AS act_type,
             count(DISTINCT p.id)::int AS publications
      FROM publication_origins po
      JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY publications DESC, act_type
    `, [sourceId]),
    pool.query(`
      SELECT
        count(*)::int AS file_entries,
        count(*) FILTER (WHERE file_entry->>'rawSha256' ~ '^[a-f0-9]{64}$')::int AS valid_sha256,
        count(*) FILTER (WHERE NULLIF(file_entry->>'url','') IS NOT NULL)::int AS with_url
      FROM publication_origins po
      JOIN publication_versions pv ON pv.publication_id = po.publication_id AND pv.is_current = TRUE
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pv.source_metadata->'files','[]'::jsonb)) file_entry
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT external_id, count(*)::int AS count
      FROM publication_origins
      WHERE source_id = $1 AND external_id IS NOT NULL
      GROUP BY external_id
      HAVING count(*) > 1
      ORDER BY count DESC, external_id
      LIMIT 20
    `, [sourceId]),
    pool.query(`
      SELECT count(*)::int AS publications_with_multiple_sources
      FROM (
        SELECT p.id
        FROM publications p
        JOIN publication_origins po ON po.publication_id = p.id
        WHERE p.id IN (
          SELECT publication_id FROM publication_origins WHERE source_id = $1
        )
        GROUP BY p.id
        HAVING count(DISTINCT po.source_id) > 1
      ) x
    `, [sourceId]),
    pool.query(`
      SELECT p.id, p.act_type, p.act_number, p.title,
             po.external_id, po.official_url,
             jsonb_agg(jsonb_build_object(
               'versionNo', pv.version_no,
               'isCurrent', pv.is_current,
               'contentHash', pv.content_hash,
               'sourceRole', pv.source_metadata->>'sourceRole',
               'sourceIdAto', pv.source_metadata->'rfbNormas'->>'idAto',
               'fileCount', COALESCE(jsonb_array_length(pv.source_metadata->'files'), 0)
             ) ORDER BY pv.version_no) AS versions
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id AND po.source_id = $1
      JOIN publication_versions pv ON pv.publication_id = p.id
      GROUP BY p.id, p.act_type, p.act_number, p.title, po.external_id, po.official_url
      HAVING count(pv.id) > 1
      ORDER BY p.title
      LIMIT 20
    `, [sourceId]),
    pool.query(`
      SELECT p.id, p.title, po.external_id,
             pv.source_metadata->'files' AS files
      FROM publication_origins po
      JOIN publications p ON p.id = po.publication_id
      JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current = TRUE
      WHERE po.source_id = $1
        AND jsonb_typeof(pv.source_metadata->'files') = 'array'
        AND jsonb_array_length(pv.source_metadata->'files') > 0
      ORDER BY p.published_on DESC NULLS LAST
      LIMIT 5
    `, [sourceId]),
  ]);

  console.log('RFB_NORMAS_DB_STATE=' + JSON.stringify({
    source,
    runs: runs.rows,
    checkpoints: checkpoint.rows,
    totals: totals.rows[0],
    categories: categories.rows,
    types: types.rows,
    files: files.rows[0],
    duplicateOrigins: duplicates.rows,
    crossSource: crossSource.rows[0],
    multiVersions: multiVersions.rows,
    sampleFiles: sampleFiles.rows,
  }));
} finally {
  await pool.end();
}
