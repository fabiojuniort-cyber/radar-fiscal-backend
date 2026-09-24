import 'dotenv/config';

import { Pool } from 'pg';

/*
 * Read-only production inspection for the DOE-SP connector gates:
 * runs/attempts, capture distribution, identity, files, duplicates,
 * versions and checkpoint. Never writes.
 */
const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to inspect DOE-SP.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const sourceResult = await pool.query(`
    SELECT id, code, connector_key, base_url, uf, schedule_cron, schedule_timezone,
           max_attempts, is_active, connector_config
    FROM sources WHERE code = 'doe-sp'
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error('DOE-SP source is not provisioned.');
  const sourceId = source.id;

  const [runs, categories, types, agencies, identity, fileStats, duplicateOrigins, duplicateIdentity, versions, checkpoints, samples] = await Promise.all([
    pool.query(`
      SELECT cr.id, cr.trigger_type, cr.status, cr.scheduled_for, cr.started_at, cr.finished_at,
             EXTRACT(EPOCH FROM (cr.finished_at - cr.started_at))::int AS duration_s,
             cr.error_summary,
             COALESCE((SELECT jsonb_object_agg(disposition, count) FROM (
               SELECT disposition, count(*)::int AS count FROM collection_run_publications crp
               WHERE crp.collection_run_id = cr.id GROUP BY disposition) d), '{}'::jsonb) AS dispositions,
             (SELECT count(*)::int FROM collection_items ci WHERE ci.collection_run_id = cr.id AND ci.status = 'FAILED') AS item_errors,
             (SELECT jsonb_agg(jsonb_build_object(
                'attemptNo', ca.attempt_no, 'status', ca.status, 'responseTimeMs', ca.response_time_ms,
                'errorCode', ca.error_code,
                'doeSp', (ca.metadata->'doeSp') - 'filtering' || jsonb_build_object(
                  'filtering', (ca.metadata->'doeSp'->'filtering') - 'excludedSamples'),
                'checkpointRef', ca.metadata->'checkpointRef'
              ) ORDER BY ca.attempt_no)
              FROM collection_attempts ca WHERE ca.collection_run_id = cr.id) AS attempts
      FROM collection_runs cr
      WHERE cr.source_id = $1
      ORDER BY cr.created_at DESC
      LIMIT 10
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(pv.source_metadata->>'captureCategory', 'UNKNOWN') AS category, count(DISTINCT po.publication_id)::int AS publications
      FROM publication_origins po JOIN publication_versions pv ON pv.publication_id = po.publication_id AND pv.is_current
      WHERE po.source_id = $1 GROUP BY 1 ORDER BY 2 DESC
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(p.act_type, 'UNKNOWN') AS act_type, count(DISTINCT p.id)::int AS publications
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1 GROUP BY 1 ORDER BY 2 DESC
    `, [sourceId]),
    pool.query(`
      SELECT COALESCE(p.agency, 'UNKNOWN') AS agency, count(DISTINCT p.id)::int AS publications
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 40
    `, [sourceId]),
    pool.query(`
      SELECT p.identity_strength, count(DISTINCT p.id)::int AS publications
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1 GROUP BY 1
    `, [sourceId]),
    pool.query(`
      SELECT count(*)::int AS file_entries,
             count(*) FILTER (WHERE f->>'rawSha256' ~ '^[a-f0-9]{64}$')::int AS valid_sha256,
             count(*) FILTER (WHERE (f->>'sizeBytes')::bigint > 0)::int AS with_size,
             count(*) FILTER (WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF')::int AS authenticated_pdfs,
             count(*) FILTER (WHERE f->'metadata'->>'kind' = 'ATTACHMENT')::int AS attachments,
             COALESCE(sum((f->>'sizeBytes')::bigint), 0)::bigint AS total_bytes
      FROM publication_origins po
      JOIN publication_versions pv ON pv.publication_id = po.publication_id AND pv.is_current
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pv.source_metadata->'files', '[]'::jsonb)) f
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT external_id, count(*)::int AS count FROM publication_origins
      WHERE source_id = $1 AND external_id IS NOT NULL GROUP BY external_id HAVING count(*) > 1 LIMIT 50
    `, [sourceId]),
    pool.query(`
      SELECT p.identity_hash, count(DISTINCT po.external_id)::int AS doe_ids, jsonb_agg(DISTINCT p.title) AS titles
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      WHERE po.source_id = $1 GROUP BY p.identity_hash HAVING count(DISTINCT po.external_id) > 1 LIMIT 50
    `, [sourceId]),
    pool.query(`
      SELECT count(DISTINCT p.id)::int AS publications, count(pv.id)::int AS versions,
             count(*) FILTER (WHERE NOT pv.is_current)::int AS historical_versions,
             COALESCE(sum(length(pv.content_text)), 0)::bigint AS text_chars,
             count(*) FILTER (WHERE pv.content_text IS NULL OR pv.content_text = '')::int AS empty_text
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      JOIN publication_versions pv ON pv.publication_id = p.id
      WHERE po.source_id = $1
    `, [sourceId]),
    pool.query(`
      SELECT generation, state_version, payload_bytes, payload_sha256, produced_by_run_id, created_at,
             payload->'coverageFrom' AS coverage_from, payload->'windowEnd' AS window_end,
             payload->'pendingRanges' AS pending_ranges,
             (SELECT jsonb_object_agg(k, jsonb_build_object('total', v->'total', 'included', jsonb_array_length(v->'included'), 'hashed', (v->>'idsHash') <> ''))
              FROM jsonb_each(payload->'days') AS d(k, v)) AS days
      FROM collection_checkpoints WHERE source_id = $1 AND connector_key = 'doe-sp'
      ORDER BY generation DESC
    `, [sourceId]),
    pool.query(`
      SELECT p.published_on, p.agency, p.act_type, p.act_number, p.title, p.identity_strength,
             po.external_id, po.official_url, pv.source_metadata->>'captureCategory' AS category,
             pv.source_metadata->>'organ' AS organ, pv.source_metadata->>'authCode' AS auth_code,
             jsonb_array_length(COALESCE(pv.source_metadata->'files', '[]'::jsonb)) AS files,
             left(pv.content_text, 160) AS text_start
      FROM publication_origins po JOIN publications p ON p.id = po.publication_id
      JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current
      WHERE po.source_id = $1
      ORDER BY p.published_on DESC NULLS LAST, p.act_type, p.act_number
      LIMIT 40
    `, [sourceId]),
  ]);

  console.log('DOE_SP_INSPECTION=' + JSON.stringify({
    source,
    runs: runs.rows,
    categories: categories.rows,
    types: types.rows,
    agencies: agencies.rows,
    identity: identity.rows,
    fileStats: fileStats.rows[0],
    duplicateOrigins: duplicateOrigins.rows,
    duplicateIdentity: duplicateIdentity.rows,
    versions: versions.rows[0],
    checkpoints: checkpoints.rows,
    samples: samples.rows,
  }));
} finally {
  await pool.end();
}
