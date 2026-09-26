import 'dotenv/config';

import { createHash } from 'node:crypto';

import { Pool } from 'pg';

/**
 * DOE-SP-27 production preflight.
 *
 * Safety model:
 * - exactly one business SQL statement;
 * - that statement is a SELECT/CTE snapshot only;
 * - no INSERT/UPDATE/DELETE/DDL/CALL/COPY;
 * - no collection, migration, scheduler or worker imports;
 * - client-side connection/query timeouts;
 * - raw identifiers are emitted only to private Railway logs in bounded
 *   manifest chunks; public handoff uses aggregates/checksums only.
 */
const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required.',
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
  query_timeout: 100_000,
  statement_timeout: 90_000,
  lock_timeout: 2_000,
});

function sha256(value: string): string {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}

type AuditRow = {
  publication_id: string;
  identity_hash: string;
  identity_strength: string;
  title: string;
  published_on: string | null;
  effective_on: string | null;
  doe_external_ids: string[];
  doe_origin_ids: string[];
  doe_official_urls: string[];
  total_origins: number;
  other_source_ids: string[];
  version_count: number;
  current_version_id: string | null;
  current_version_no: number | null;
  current_content_hash: string | null;
  current_content_chars: number;
  version_file_entries: number;
  authenticated_pdf_entries: number;
  attachment_entries: number;
  publication_file_rows: number;
  company_refs: number;
  tenant_refs: number;
  tenant_links: unknown;
  match_refs: number;
  collection_item_refs: number;
  run_refs: number;
  foreign_run_refs: number;
  audit_entity_refs: number;
};

type Snapshot = {
  source: {
    id: string;
    code: string;
    schedule_cron: string | null;
    is_active: boolean;
  } | null;
  active_runs: Array<{
    id: string;
    status: string;
    trigger_type: string;
  }>;
  checkpoints: Array<{
    id: string;
    generation: string;
    state_version: number;
    produced_by_run_id: string;
    created_at: string;
    coverage_from: unknown;
    window_end: unknown;
    pending_ranges: unknown;
  }>;
  rows: AuditRow[];
};

const sql = `
WITH source AS (
  SELECT id, code, schedule_cron, is_active
  FROM sources
  WHERE code = 'doe-sp'
  LIMIT 1
),
active_runs AS (
  SELECT cr.id, cr.status, cr.trigger_type
  FROM collection_runs cr
  JOIN source s ON s.id = cr.source_id
  WHERE cr.status IN ('PENDING', 'RUNNING')
  ORDER BY cr.created_at
),
checkpoints AS (
  SELECT
    cc.id,
    cc.generation::text AS generation,
    cc.state_version,
    cc.produced_by_run_id,
    cc.created_at::text AS created_at,
    cc.payload->'coverageFrom' AS coverage_from,
    cc.payload->'windowEnd' AS window_end,
    cc.payload->'pendingRanges' AS pending_ranges
  FROM collection_checkpoints cc
  JOIN source s ON s.id = cc.source_id
  WHERE cc.connector_key = 'doe-sp'
  ORDER BY cc.generation DESC
),
doe_publications AS (
  SELECT DISTINCT po.publication_id
  FROM publication_origins po
  JOIN source s ON s.id = po.source_id
),
origin_stats AS (
  SELECT
    po.publication_id,
    array_agg(DISTINCT po.external_id ORDER BY po.external_id)
      FILTER (
        WHERE po.source_id = s.id
          AND po.external_id IS NOT NULL
      ) AS doe_external_ids,
    array_agg(po.id::text ORDER BY po.id::text)
      FILTER (WHERE po.source_id = s.id)
      AS doe_origin_ids,
    array_agg(DISTINCT po.official_url ORDER BY po.official_url)
      FILTER (WHERE po.source_id = s.id)
      AS doe_official_urls,
    count(*)::int AS total_origins,
    array_agg(
      DISTINCT po.source_id::text
      ORDER BY po.source_id::text
    ) FILTER (WHERE po.source_id <> s.id)
      AS other_source_ids
  FROM publication_origins po
  JOIN doe_publications d
    ON d.publication_id = po.publication_id
  CROSS JOIN source s
  GROUP BY po.publication_id
),
version_stats AS (
  SELECT
    pv.publication_id,
    count(*)::int AS version_count
  FROM publication_versions pv
  JOIN doe_publications d
    ON d.publication_id = pv.publication_id
  GROUP BY pv.publication_id
),
current_versions AS (
  SELECT DISTINCT ON (pv.publication_id)
    pv.publication_id,
    pv.id,
    pv.version_no,
    pv.content_hash,
    pv.content_text,
    pv.source_metadata
  FROM publication_versions pv
  JOIN doe_publications d
    ON d.publication_id = pv.publication_id
  WHERE pv.is_current = true
  ORDER BY pv.publication_id, pv.version_no DESC
),
publication_file_stats AS (
  SELECT
    pv.publication_id,
    count(*)::int AS publication_file_rows
  FROM publication_files pf
  JOIN publication_versions pv
    ON pv.id = pf.publication_version_id
  JOIN doe_publications d
    ON d.publication_id = pv.publication_id
  GROUP BY pv.publication_id
),
company_stats AS (
  SELECT
    cp.publication_id,
    count(*)::int AS company_refs,
    count(DISTINCT c.tenant_id)::int AS tenant_refs,
    jsonb_agg(
      jsonb_build_object(
        'companyId', cp.company_id,
        'tenantId', c.tenant_id,
        'status', cp.status
      )
      ORDER BY cp.company_id
    ) AS tenant_links
  FROM company_publications cp
  JOIN doe_publications d
    ON d.publication_id = cp.publication_id
  JOIN companies c ON c.id = cp.company_id
  GROUP BY cp.publication_id
),
match_stats AS (
  SELECT
    cp.publication_id,
    count(*)::int AS match_refs
  FROM publication_matches pm
  JOIN company_publications cp
    ON cp.id = pm.company_publication_id
  JOIN doe_publications d
    ON d.publication_id = cp.publication_id
  GROUP BY cp.publication_id
),
item_stats AS (
  SELECT
    ci.publication_id,
    count(*)::int AS collection_item_refs
  FROM collection_items ci
  JOIN doe_publications d
    ON d.publication_id = ci.publication_id
  GROUP BY ci.publication_id
),
run_stats AS (
  SELECT
    crp.publication_id,
    count(*)::int AS run_refs,
    count(*) FILTER (
      WHERE cr.source_id <> s.id
    )::int AS foreign_run_refs
  FROM collection_run_publications crp
  JOIN doe_publications d
    ON d.publication_id = crp.publication_id
  JOIN collection_runs cr
    ON cr.id = crp.collection_run_id
  CROSS JOIN source s
  GROUP BY crp.publication_id
),
audit_stats AS (
  SELECT
    d.publication_id,
    count(al.*)::int AS audit_entity_refs
  FROM doe_publications d
  LEFT JOIN audit_log al
    ON al.entity_id = d.publication_id::text
  GROUP BY d.publication_id
),
audit_rows AS (
  SELECT
    p.id::text AS publication_id,
    p.identity_hash,
    p.identity_strength,
    p.title,
    p.published_on::text,
    p.effective_on::text,
    COALESCE(os.doe_external_ids, ARRAY[]::text[])
      AS doe_external_ids,
    COALESCE(os.doe_origin_ids, ARRAY[]::text[])
      AS doe_origin_ids,
    COALESCE(os.doe_official_urls, ARRAY[]::text[])
      AS doe_official_urls,
    COALESCE(os.total_origins, 0)::int
      AS total_origins,
    COALESCE(os.other_source_ids, ARRAY[]::text[])
      AS other_source_ids,
    COALESCE(vs.version_count, 0)::int
      AS version_count,
    cv.id::text AS current_version_id,
    cv.version_no AS current_version_no,
    cv.content_hash AS current_content_hash,
    COALESCE(length(cv.content_text), 0)::int
      AS current_content_chars,
    COALESCE((
      SELECT count(*)::int
      FROM jsonb_array_elements(
        COALESCE(
          cv.source_metadata->'files',
          '[]'::jsonb
        )
      ) f
    ), 0) AS version_file_entries,
    COALESCE((
      SELECT count(*)::int
      FROM jsonb_array_elements(
        COALESCE(
          cv.source_metadata->'files',
          '[]'::jsonb
        )
      ) f
      WHERE
        f->'metadata'->>'kind' =
        'AUTHENTICATED_PUBLICATION_PDF'
    ), 0) AS authenticated_pdf_entries,
    COALESCE((
      SELECT count(*)::int
      FROM jsonb_array_elements(
        COALESCE(
          cv.source_metadata->'files',
          '[]'::jsonb
        )
      ) f
      WHERE f->'metadata'->>'kind' = 'ATTACHMENT'
    ), 0) AS attachment_entries,
    COALESCE(pfs.publication_file_rows, 0)::int
      AS publication_file_rows,
    COALESCE(cs.company_refs, 0)::int
      AS company_refs,
    COALESCE(cs.tenant_refs, 0)::int
      AS tenant_refs,
    COALESCE(cs.tenant_links, '[]'::jsonb)
      AS tenant_links,
    COALESCE(ms.match_refs, 0)::int
      AS match_refs,
    COALESCE(its.collection_item_refs, 0)::int
      AS collection_item_refs,
    COALESCE(rs.run_refs, 0)::int
      AS run_refs,
    COALESCE(rs.foreign_run_refs, 0)::int
      AS foreign_run_refs,
    COALESCE(ast.audit_entity_refs, 0)::int
      AS audit_entity_refs
  FROM doe_publications d
  JOIN publications p ON p.id = d.publication_id
  LEFT JOIN origin_stats os
    ON os.publication_id = p.id
  LEFT JOIN version_stats vs
    ON vs.publication_id = p.id
  LEFT JOIN current_versions cv
    ON cv.publication_id = p.id
  LEFT JOIN publication_file_stats pfs
    ON pfs.publication_id = p.id
  LEFT JOIN company_stats cs
    ON cs.publication_id = p.id
  LEFT JOIN match_stats ms
    ON ms.publication_id = p.id
  LEFT JOIN item_stats its
    ON its.publication_id = p.id
  LEFT JOIN run_stats rs
    ON rs.publication_id = p.id
  LEFT JOIN audit_stats ast
    ON ast.publication_id = p.id
)
SELECT
  (
    SELECT to_jsonb(s)
    FROM source s
  ) AS source,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(ar))
    FROM active_runs ar
  ), '[]'::jsonb) AS active_runs,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(cp))
    FROM checkpoints cp
  ), '[]'::jsonb) AS checkpoints,
  COALESCE((
    SELECT jsonb_agg(
      to_jsonb(r)
      ORDER BY r.published_on NULLS LAST, r.publication_id
    )
    FROM audit_rows r
  ), '[]'::jsonb) AS rows
`;

const client = await pool.connect();

try {
  const result =
    await client.query<Snapshot>(sql);
  const snapshot = result.rows[0];

  if (!snapshot?.source) {
    throw new Error('DOE-SP source not found.');
  }

  const rows = snapshot.rows ?? [];

  const totals = rows.reduce(
    (acc, row) => {
      acc.publications += 1;
      acc.versions += row.version_count;
      acc.versionFileEntries +=
        row.version_file_entries;
      acc.authenticatedPdfEntries +=
        row.authenticated_pdf_entries;
      acc.attachmentEntries +=
        row.attachment_entries;
      acc.publicationFileRows +=
        row.publication_file_rows;
      acc.companyRefs += row.company_refs;
      acc.tenantRefs += row.tenant_refs;
      acc.matchRefs += row.match_refs;
      acc.collectionItemRefs +=
        row.collection_item_refs;
      acc.runRefs += row.run_refs;
      acc.foreignRunRefs +=
        row.foreign_run_refs;
      acc.auditEntityRefs +=
        row.audit_entity_refs;

      if (row.other_source_ids.length > 0) {
        acc.sharedPublications += 1;
      }

      if (row.current_content_chars > 0) {
        if (row.attachment_entries > 0) {
          acc.htmlPlusMaterialAttachments += 1;
        } else {
          acc.htmlOnlyCandidates += 1;
        }
      } else {
        acc.pdfFallbackCandidates += 1;
      }

      return acc;
    },
    {
      publications: 0,
      versions: 0,
      versionFileEntries: 0,
      authenticatedPdfEntries: 0,
      attachmentEntries: 0,
      publicationFileRows: 0,
      companyRefs: 0,
      tenantRefs: 0,
      matchRefs: 0,
      collectionItemRefs: 0,
      runRefs: 0,
      foreignRunRefs: 0,
      auditEntityRefs: 0,
      sharedPublications: 0,
      htmlOnlyCandidates: 0,
      htmlPlusMaterialAttachments: 0,
      pdfFallbackCandidates: 0,
    },
  );

  const safeRows = rows.map((row) => {
    const contentClass =
      row.current_content_chars === 0
        ? 'PDF_FALLBACK_CANDIDATE'
        : row.attachment_entries > 0
          ? 'HTML_PLUS_MATERIAL_ATTACHMENTS'
          : 'HTML_BODY_CANDIDATE';

    return {
      recordHash: sha256(row.publication_id),
      identityHashDigest: sha256(
        row.identity_hash,
      ),
      identityStrength: row.identity_strength,
      originCount: row.total_origins,
      otherSourceCount: row.other_source_ids.length,
      versionCount: row.version_count,
      contentClass,
      currentContentChars:
        row.current_content_chars,
      versionFileEntries:
        row.version_file_entries,
      authenticatedPdfEntries:
        row.authenticated_pdf_entries,
      attachmentEntries: row.attachment_entries,
      publicationFileRows:
        row.publication_file_rows,
      companyRefs: row.company_refs,
      tenantRefs: row.tenant_refs,
      matchRefs: row.match_refs,
      collectionItemRefs:
        row.collection_item_refs,
      runRefs: row.run_refs,
      foreignRunRefs: row.foreign_run_refs,
      auditEntityRefs: row.audit_entity_refs,
    };
  });

  const sortedSafeRows = safeRows
    .slice()
    .sort((a, b) =>
      a.recordHash.localeCompare(b.recordHash),
    );

  const manifestCanonical =
    JSON.stringify(sortedSafeRows);
  const manifestSha256 =
    sha256(manifestCanonical);

  console.log(
    'DOE_SP_REBUILD_AUDIT_SUMMARY=' +
      JSON.stringify({
        source: {
          code: snapshot.source.code,
          isActive: snapshot.source.is_active,
          hasSchedule: Boolean(
            snapshot.source.schedule_cron,
          ),
        },
        safety: {
          sqlStatements: 1,
          businessStatementType:
            'SELECT_ONLY_SINGLE_SNAPSHOT',
          connectionTimeoutMs: 10_000,
          queryTimeoutMs: 100_000,
          statementTimeoutMs: 90_000,
          lockTimeoutMs: 2_000,
        },
        activeRuns: {
          count:
            snapshot.active_runs?.length ?? 0,
          byStatus: (
            snapshot.active_runs ?? []
          ).reduce<Record<string, number>>(
            (acc, run) => {
              acc[run.status] =
                (acc[run.status] ?? 0) + 1;
              return acc;
            },
            {},
          ),
        },
        checkpoints: {
          count:
            snapshot.checkpoints?.length ?? 0,
          latestGeneration:
            snapshot.checkpoints?.[0]
              ?.generation ?? null,
        },
        totals: {
          ...totals,
          historicalVersions:
            totals.versions -
            totals.publications,
          multiVersionPublications:
            rows.filter(
              (row) => row.version_count > 1,
            ).length,
        },
        manifest: {
          rowCount: safeRows.length,
          sha256: manifestSha256,
          hashAlgorithm: 'SHA-256',
          recordIdentifier:
            'SHA-256(publication_id)',
        },
      }),
  );

  const safeChunkSize = 20;
  for (
    let offset = 0;
    offset < sortedSafeRows.length;
    offset += safeChunkSize
  ) {
    console.log(
      'DOE_SP_REBUILD_AUDIT_SAFE_MANIFEST=' +
        JSON.stringify({
          chunk:
            Math.floor(
              offset / safeChunkSize,
            ) + 1,
          rows: sortedSafeRows.slice(
            offset,
            offset + safeChunkSize,
          ),
        }),
    );
  }

  const privateChunkSize = 10;
  for (
    let offset = 0;
    offset < rows.length;
    offset += privateChunkSize
  ) {
    console.log(
      'DOE_SP_REBUILD_AUDIT_PRIVATE_MANIFEST=' +
        JSON.stringify({
          chunk:
            Math.floor(
              offset / privateChunkSize,
            ) + 1,
          rows: rows.slice(
            offset,
            offset + privateChunkSize,
          ),
        }),
    );
  }
} finally {
  client.release();
  await pool.end();
}
