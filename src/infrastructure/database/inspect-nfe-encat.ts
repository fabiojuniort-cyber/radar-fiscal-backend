import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required to inspect NF-e/ENCAT.',
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

try {
  const sourceResult = await pool.query(
    `
      SELECT
        id,
        code,
        connector_key,
        base_url,
        schedule_cron,
        schedule_timezone,
        max_attempts,
        is_active
      FROM sources
      WHERE code = 'nfe-encat'
    `,
  );

  const source = sourceResult.rows[0];

  if (!source) {
    throw new Error('NF-e/ENCAT source is not provisioned.');
  }

  const sourceId = source.id as string;

  const [
    migrations,
    latestMigrations,
    runs,
    familyCounts,
    gateRows,
    schemaExample,
    manualExample,
    fileStats,
    duplicateOrigins,
    unexpectedDfe,
  ] = await Promise.all([
    pool.query(
      'SELECT count(*)::int AS count FROM schema_migrations',
    ),
    pool.query(
      `
        SELECT filename, applied_at
        FROM schema_migrations
        ORDER BY applied_at DESC
        LIMIT 5
      `,
    ),
    pool.query(
      `
        SELECT
          cr.id,
          cr.trigger_type,
          cr.status,
          cr.scheduled_for,
          cr.started_at,
          cr.finished_at,
          cr.error_summary,
          COALESCE(
            (
              SELECT jsonb_object_agg(disposition, count)
              FROM (
                SELECT disposition, count(*)::int AS count
                FROM collection_run_publications crp
                WHERE crp.collection_run_id = cr.id
                GROUP BY disposition
              ) d
            ),
            '{}'::jsonb
          ) AS dispositions,
          (
            SELECT count(*)::int
            FROM collection_items ci
            WHERE ci.collection_run_id = cr.id
              AND ci.status = 'FAILED'
          ) AS item_errors,
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'attemptNo', ca.attempt_no,
                'status', ca.status,
                'responseTimeMs', ca.response_time_ms,
                'errorCode', ca.error_code,
                'retryable', ca.retryable,
                'publicationCount', COALESCE((ca.metadata->>'publicationCount')::int, 0),
                'partialFailureCount', COALESCE((ca.metadata->>'partialFailureCount')::int, 0),
                'nfeEncat', ca.metadata->'nfeEncat',
                'checkpointItems',
                  jsonb_object_length(
                    COALESCE(
                      ca.metadata->'nfeEncatState'->'items',
                      '{}'::jsonb
                    )
                  )
              )
              ORDER BY ca.attempt_no
            )
            FROM collection_attempts ca
            WHERE ca.collection_run_id = cr.id
          ) AS attempts
        FROM collection_runs cr
        WHERE cr.source_id = $1
        ORDER BY cr.created_at DESC
        LIMIT 5
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT
          COALESCE(po.metadata->>'portalFamily', 'UNKNOWN') AS family,
          count(DISTINCT po.publication_id)::int AS publications
        FROM publication_origins po
        WHERE po.source_id = $1
        GROUP BY 1
        ORDER BY 1
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT
          p.id,
          p.act_type,
          p.act_number,
          p.title,
          p.published_on,
          po.external_id,
          po.metadata->>'documentFamily' AS document_family,
          po.metadata->>'officialVersion' AS official_version,
          po.metadata->>'portalFamily' AS portal_family,
          (
            SELECT count(*)::int
            FROM publication_versions pv2
            WHERE pv2.publication_id = p.id
          ) AS version_count,
          pv.content_hash,
          pv.source_metadata->'files' AS files
        FROM publication_origins po
        JOIN publications p
          ON p.id = po.publication_id
        LEFT JOIN publication_versions pv
          ON pv.publication_id = p.id
         AND pv.is_current = TRUE
        WHERE po.source_id = $1
          AND (
            p.act_number IN (
              '2023.003 v1.30',
              '2026.009 v1.00',
              '2025.002 v1.40',
              '2025.002 v1.50'
            )
            OR po.metadata->>'documentFamily' = 'IT 2025.002'
          )
        ORDER BY p.act_type, p.act_number, p.published_on
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT
          p.id,
          p.title,
          po.external_id,
          po.metadata,
          pv.content_hash,
          pv.source_metadata->'files' AS files
        FROM publication_origins po
        JOIN publications p
          ON p.id = po.publication_id
        JOIN publication_versions pv
          ON pv.publication_id = p.id
         AND pv.is_current = TRUE
        WHERE po.source_id = $1
          AND po.metadata->>'portalFamily' = 'SCHEMAS'
        ORDER BY p.published_on DESC NULLS LAST, p.created_at DESC
        LIMIT 1
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT
          p.id,
          p.title,
          po.external_id,
          po.metadata,
          pv.content_hash,
          pv.source_metadata->'files' AS files
        FROM publication_origins po
        JOIN publications p
          ON p.id = po.publication_id
        JOIN publication_versions pv
          ON pv.publication_id = p.id
         AND pv.is_current = TRUE
        WHERE po.source_id = $1
          AND po.metadata->>'portalFamily' = 'MANUALS'
        ORDER BY p.published_on DESC NULLS LAST, p.created_at DESC
        LIMIT 1
      `,
      [sourceId],
    ),
    pool.query(
      `
        WITH files AS (
          SELECT
            po.metadata->>'portalFamily' AS family,
            file
          FROM publication_origins po
          JOIN publication_versions pv
            ON pv.publication_id = po.publication_id
           AND pv.is_current = TRUE
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(pv.source_metadata->'files', '[]'::jsonb)
          ) AS file
          WHERE po.source_id = $1
        )
        SELECT
          count(*)::int AS total_files,
          count(*) FILTER (
            WHERE file->>'rawSha256' ~ '^[0-9a-f]{64}$'
          )::int AS valid_sha256,
          count(*) FILTER (
            WHERE family = 'SCHEMAS'
              AND file->>'mimeType' IN (
                'application/zip',
                'application/x-zip-compressed'
              )
          )::int AS schema_zip_files
        FROM files
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT external_id, count(*)::int AS count
        FROM publication_origins
        WHERE source_id = $1
          AND external_id IS NOT NULL
        GROUP BY external_id
        HAVING count(*) > 1
      `,
      [sourceId],
    ),
    pool.query(
      `
        SELECT
          p.id,
          p.title,
          p.act_type,
          p.act_number
        FROM publication_origins po
        JOIN publications p
          ON p.id = po.publication_id
        WHERE po.source_id = $1
          AND (
            p.title ~* '(NFGas|NFAg|NFCom|NF3e|NF-e ABI)'
            OR p.act_type ~* '(NFGas|NFAg|NFCom|NF3e|NF-e ABI)'
          )
      `,
      [sourceId],
    ),
  ]);

  console.log(
    'NFE_ENCAT_INSPECTION=' +
      JSON.stringify({
        source,
        schemaMigrations: {
          count: migrations.rows[0]?.count ?? 0,
          latest: latestMigrations.rows,
        },
        runs: runs.rows,
        familyCounts: familyCounts.rows,
        gates: gateRows.rows,
        schemaExample: schemaExample.rows[0] ?? null,
        manualExample: manualExample.rows[0] ?? null,
        fileStats: fileStats.rows[0],
        duplicateOrigins: duplicateOrigins.rows,
        unexpectedDfe: unexpectedDfe.rows,
      }),
  );
} finally {
  await pool.end();
}
