import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to inspect SPED.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const sourceResult = await pool.query(`
    SELECT id, code, connector_key, base_url, schedule_cron, schedule_timezone,
           max_attempts, is_active, connector_config
    FROM sources WHERE code = 'sped'
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error('SPED source is not provisioned.');
  const sourceId = source.id as string;

  const [
    migrations,
    latestMigrations,
    runs,
    moduleCounts,
    kindCounts,
    gates,
    fileStats,
    duplicateOrigins,
    unexpectedModules,
    multiVersion,
    versionTotals,
  ] = await Promise.all([
    pool.query('SELECT count(*)::int AS count FROM schema_migrations'),
    pool.query(`SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 5`),
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
          'retryable', ca.retryable,
          'publicationCount', COALESCE((ca.metadata->>'publicationCount')::int, 0),
          'partialFailureCount', COALESCE((ca.metadata->>'partialFailureCount')::int, 0),
          'sped', (COALESCE(ca.metadata->'sped', '{}'::jsonb) - 'identityAudit' - 'deferredDocuments' - 'moduleResults')
                  || jsonb_build_object(
                       'moduleResults', ca.metadata->'sped'->'moduleResults',
                       'deferredDocuments', ca.metadata->'sped'->'deferredDocuments',
                       'identityCollisionsResolved', jsonb_array_length(COALESCE(ca.metadata->'sped'->'identityAudit'->'collisionsResolved', '[]'::jsonb)),
                       'identityUnresolvedCollisions', ca.metadata->'sped'->'identityAudit'->'unresolvedCollisions',
                       'identityMirrorGroups', jsonb_array_length(COALESCE(ca.metadata->'sped'->'identityAudit'->'mirrorGroups', '[]'::jsonb)),
                       'collisions', ca.metadata->'sped'->'identityAudit'->'collisionsResolved'
                     ),
          'stateVersion', ca.metadata->'spedState'->'version',
          'checkpointItems', (
            SELECT count(*)::int FROM jsonb_object_keys(COALESCE(ca.metadata->'spedState'->'items', '{}'::jsonb))
          )
        ) ORDER BY ca.attempt_no)
        FROM collection_attempts ca WHERE ca.collection_run_id = cr.id) AS attempts
      FROM collection_runs cr
      WHERE cr.source_id = $1
      ORDER BY cr.created_at DESC
      LIMIT 8
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(po.metadata->>'module', 'UNKNOWN') AS module,
             count(DISTINCT po.publication_id)::int AS publications
      FROM publication_origins po
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY 1
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(po.metadata->>'documentKind', 'UNKNOWN') AS kind,
             count(DISTINCT po.publication_id)::int AS publications
      FROM publication_origins po
      WHERE po.source_id = $1
      GROUP BY 1 ORDER BY 1
    `, [sourceId]),
    pool.query(`
      WITH gate_origins AS (
        SELECT
          CASE
            WHEN po.metadata->>'module' = 'EFD_ICMS_IPI' AND po.metadata->>'documentKind' = 'GUIDE'
                 AND po.metadata->>'officialVersion' = '3.2.4' THEN 'ICMS_IPI_GUIA_3_2_4'
            WHEN po.metadata->>'module' = 'EFD_CONTRIBUICOES' AND po.metadata->>'documentNumber' = '11/2026'
                 AND COALESCE(po.metadata->>'documentCarrier','DOCUMENT') = 'DOCUMENT' THEN 'CONTRIBUICOES_NT_11_2026'
            WHEN po.metadata->>'module' = 'EFD_CONTRIBUICOES' AND po.metadata->>'documentNumber' = '12/2026'
                 AND COALESCE(po.metadata->>'documentCarrier','DOCUMENT') = 'DOCUMENT' THEN 'CONTRIBUICOES_NT_12_2026'
            WHEN po.metadata->>'module' = 'EFD_REINF' AND po.metadata->>'documentNumber' = '01/2026'
                 AND COALESCE(po.metadata->>'documentCarrier','DOCUMENT') = 'DOCUMENT' THEN 'REINF_NT_01_2026'
            WHEN po.metadata->>'module' = 'EFD_REINF' AND po.metadata->>'documentKind' = 'XSD_SCHEMA'
                 AND po.metadata->>'officialVersion' = '2.1.2' THEN 'REINF_XSD_2_1_2'
            WHEN po.metadata->>'module' = 'DERE' AND po.metadata->>'officialVersion' = '1.2.0' THEN 'DERE_1_2_0'
          END AS gate,
          po.publication_id, po.external_id
        FROM publication_origins po
        WHERE po.source_id = $1
      )
      SELECT
        g.gate, p.title, p.act_number, g.external_id,
        (SELECT count(*)::int FROM publication_versions pv2 WHERE pv2.publication_id = p.id) AS version_count,
        (
          SELECT jsonb_agg(jsonb_build_object('name', f->>'name', 'sizeBytes', f->'sizeBytes', 'rawSha256', f->>'rawSha256'))
          FROM jsonb_array_elements(COALESCE(pv.source_metadata->'files','[]'::jsonb)) f
        ) AS files
      FROM gate_origins g
      JOIN publications p ON p.id = g.publication_id
      LEFT JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current = TRUE
      WHERE g.gate IS NOT NULL
      ORDER BY g.gate, p.title
    `, [sourceId]),
    pool.query(`
      SELECT
        count(*)::int AS current_versions,
        count(*) FILTER (WHERE file_entry->>'rawSha256' ~ '^[a-f0-9]{64}$')::int AS valid_sha256,
        count(*) FILTER (WHERE NULLIF(file_entry->>'url','') IS NOT NULL)::int AS files_with_url,
        count(*) FILTER (WHERE NULLIF(file_entry->>'sizeBytes','') IS NOT NULL)::int AS files_with_size
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
      SELECT DISTINCT po.metadata->>'module' AS module
      FROM publication_origins po
      WHERE po.source_id = $1
        AND COALESCE(po.metadata->>'module','') NOT IN ('EFD_ICMS_IPI','EFD_CONTRIBUICOES','EFD_REINF','DERE')
      ORDER BY 1
    `, [sourceId]),
    pool.query(`
      SELECT p.id, p.title, count(DISTINCT pv.id)::int AS versions, count(DISTINCT po.id)::int AS origins
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id AND po.source_id = $1
      JOIN publication_versions pv ON pv.publication_id = p.id
      GROUP BY p.id, p.title
      HAVING count(DISTINCT pv.id) > 1
      ORDER BY versions DESC, p.title
      LIMIT 50
    `, [sourceId]),
    pool.query(`
      SELECT count(DISTINCT p.id)::int AS publications,
             count(DISTINCT pv.id)::int AS versions,
             count(DISTINCT po.id)::int AS origins
      FROM publications p
      JOIN publication_origins po ON po.publication_id = p.id AND po.source_id = $1
      LEFT JOIN publication_versions pv ON pv.publication_id = p.id
    `, [sourceId]),
  ]);

  console.log('SPED_INSPECTION=' + JSON.stringify({
    source,
    migrations: migrations.rows[0],
    latestMigrations: latestMigrations.rows,
    runs: runs.rows,
    moduleCounts: moduleCounts.rows,
    kindCounts: kindCounts.rows,
    gates: gates.rows,
    fileStats: fileStats.rows[0],
    duplicateOrigins: duplicateOrigins.rows,
    unexpectedModules: unexpectedModules.rows,
    totals: versionTotals.rows[0],
    publicationsWithMultipleVersions: multiVersion.rows,
  }));
} finally {
  await pool.end();
}
