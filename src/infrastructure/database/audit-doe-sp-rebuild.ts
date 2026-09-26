import 'dotenv/config';

import { createHash } from 'node:crypto';

import { Pool } from 'pg';

/**
 * Read-only preflight for a possible DOE-SP corpus reconstruction.
 *
 * It intentionally performs no UPDATE/DELETE/INSERT and starts a READ ONLY
 * transaction. Output is split into one summary plus one JSON line per
 * publication so every affected ID can be reconciled before any destructive
 * operation is separately authorized.
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
  options: [
    '-c default_transaction_read_only=on',
    '-c statement_timeout=30000',
    '-c lock_timeout=2000',
    '-c idle_in_transaction_session_timeout=30000',
  ].join(' '),
});

function sha256(value: string): string {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}

const client = await pool.connect();
try {
  const sessionReadOnly = (
    await client.query<{ setting: string }>(
      'SHOW default_transaction_read_only',
    )
  ).rows[0]?.setting;
  const sessionStatementTimeout = (
    await client.query<{ setting: string }>(
      'SHOW statement_timeout',
    )
  ).rows[0]?.setting;
  const sessionLockTimeout = (
    await client.query<{ setting: string }>(
      'SHOW lock_timeout',
    )
  ).rows[0]?.setting;
  const sessionIdleTransactionTimeout = (
    await client.query<{ setting: string }>(
      'SHOW idle_in_transaction_session_timeout',
    )
  ).rows[0]?.setting;

  if (sessionReadOnly !== 'on') {
    throw new Error(
      'Refusing DOE-SP rebuild audit: session is not read-only.',
    );
  }

  await client.query('BEGIN READ ONLY');
  await client.query(
    "SET LOCAL statement_timeout = '30s'",
  );
  await client.query(
    "SET LOCAL lock_timeout = '2s'",
  );
  await client.query(
    "SET LOCAL idle_in_transaction_session_timeout = '30s'",
  );

  const transactionReadOnly = (
    await client.query<{ setting: string }>(
      'SHOW transaction_read_only',
    )
  ).rows[0]?.setting;

  if (transactionReadOnly !== 'on') {
    throw new Error(
      'Refusing DOE-SP rebuild audit: transaction is not read-only.',
    );
  }

  const source = (
    await client.query<{
      id: string;
      code: string;
      schedule_cron: string | null;
      is_active: boolean;
    }>(
      `SELECT id, code, schedule_cron, is_active
       FROM sources
       WHERE code = 'doe-sp'`,
    )
  ).rows[0];

  if (!source) {
    throw new Error('DOE-SP source not found.');
  }

  const activeRuns = (
    await client.query<{
      id: string;
      status: string;
      trigger_type: string;
    }>(
      `SELECT id, status, trigger_type
       FROM collection_runs
       WHERE source_id = $1
         AND status IN ('PENDING', 'RUNNING')
       ORDER BY created_at`,
      [source.id],
    )
  ).rows;

  const checkpoints = (
    await client.query<{
      id: string;
      generation: string;
      state_version: number;
      produced_by_run_id: string;
      created_at: Date;
      coverage_from: unknown;
      window_end: unknown;
      pending_ranges: unknown;
    }>(
      `SELECT
         id,
         generation::text,
         state_version,
         produced_by_run_id,
         created_at,
         payload->'coverageFrom' AS coverage_from,
         payload->'windowEnd' AS window_end,
         payload->'pendingRanges' AS pending_ranges
       FROM collection_checkpoints
       WHERE source_id = $1
         AND connector_key = 'doe-sp'
       ORDER BY generation DESC`,
      [source.id],
    )
  ).rows;

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

  const rows = (
    await client.query<AuditRow>(
      `WITH doe_publications AS (
         SELECT DISTINCT po.publication_id
         FROM publication_origins po
         WHERE po.source_id = $1
       )
       SELECT
         p.id AS publication_id,
         p.identity_hash,
         p.identity_strength,
         p.title,
         p.published_on::text,
         p.effective_on::text,
         COALESCE((
           SELECT array_agg(DISTINCT po.external_id ORDER BY po.external_id)
           FILTER (WHERE po.external_id IS NOT NULL)
           FROM publication_origins po
           WHERE po.publication_id = p.id
             AND po.source_id = $1
         ), ARRAY[]::text[]) AS doe_external_ids,
         COALESCE((
           SELECT array_agg(po.id::text ORDER BY po.id::text)
           FROM publication_origins po
           WHERE po.publication_id = p.id
             AND po.source_id = $1
         ), ARRAY[]::text[]) AS doe_origin_ids,
         COALESCE((
           SELECT array_agg(DISTINCT po.official_url ORDER BY po.official_url)
           FROM publication_origins po
           WHERE po.publication_id = p.id
             AND po.source_id = $1
         ), ARRAY[]::text[]) AS doe_official_urls,
         (
           SELECT count(*)::int
           FROM publication_origins po
           WHERE po.publication_id = p.id
         ) AS total_origins,
         COALESCE((
           SELECT array_agg(DISTINCT po.source_id::text ORDER BY po.source_id::text)
           FROM publication_origins po
           WHERE po.publication_id = p.id
             AND po.source_id <> $1
         ), ARRAY[]::text[]) AS other_source_ids,
         (
           SELECT count(*)::int
           FROM publication_versions pv
           WHERE pv.publication_id = p.id
         ) AS version_count,
         current_v.id AS current_version_id,
         current_v.version_no AS current_version_no,
         current_v.content_hash AS current_content_hash,
         COALESCE(length(current_v.content_text), 0)::int AS current_content_chars,
         COALESCE((
           SELECT count(*)::int
           FROM jsonb_array_elements(
             COALESCE(current_v.source_metadata->'files', '[]'::jsonb)
           ) f
         ), 0) AS version_file_entries,
         COALESCE((
           SELECT count(*)::int
           FROM jsonb_array_elements(
             COALESCE(current_v.source_metadata->'files', '[]'::jsonb)
           ) f
           WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF'
         ), 0) AS authenticated_pdf_entries,
         COALESCE((
           SELECT count(*)::int
           FROM jsonb_array_elements(
             COALESCE(current_v.source_metadata->'files', '[]'::jsonb)
           ) f
           WHERE f->'metadata'->>'kind' = 'ATTACHMENT'
         ), 0) AS attachment_entries,
         (
           SELECT count(*)::int
           FROM publication_files pf
           JOIN publication_versions pv
             ON pv.id = pf.publication_version_id
           WHERE pv.publication_id = p.id
         ) AS publication_file_rows,
         (
           SELECT count(*)::int
           FROM company_publications cp
           WHERE cp.publication_id = p.id
         ) AS company_refs,
         (
           SELECT count(DISTINCT c.tenant_id)::int
           FROM company_publications cp
           JOIN companies c ON c.id = cp.company_id
           WHERE cp.publication_id = p.id
         ) AS tenant_refs,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'companyId', cp.company_id,
               'tenantId', c.tenant_id,
               'status', cp.status
             )
             ORDER BY cp.company_id
           )
           FROM company_publications cp
           JOIN companies c ON c.id = cp.company_id
           WHERE cp.publication_id = p.id
         ), '[]'::jsonb) AS tenant_links,
         (
           SELECT count(*)::int
           FROM publication_matches pm
           JOIN company_publications cp
             ON cp.id = pm.company_publication_id
           WHERE cp.publication_id = p.id
         ) AS match_refs,
         (
           SELECT count(*)::int
           FROM collection_items ci
           WHERE ci.publication_id = p.id
         ) AS collection_item_refs,
         (
           SELECT count(*)::int
           FROM collection_run_publications crp
           WHERE crp.publication_id = p.id
         ) AS run_refs,
         (
           SELECT count(*)::int
           FROM collection_run_publications crp
           JOIN collection_runs cr
             ON cr.id = crp.collection_run_id
           WHERE crp.publication_id = p.id
             AND cr.source_id <> $1
         ) AS foreign_run_refs,
         (
           SELECT count(*)::int
           FROM audit_log al
           WHERE al.entity_id = p.id::text
         ) AS audit_entity_refs
       FROM doe_publications d
       JOIN publications p ON p.id = d.publication_id
       LEFT JOIN LATERAL (
         SELECT
           pv.id,
           pv.version_no,
           pv.content_hash,
           pv.content_text,
           pv.source_metadata
         FROM publication_versions pv
         WHERE pv.publication_id = p.id
           AND pv.is_current = true
         LIMIT 1
       ) current_v ON true
       ORDER BY p.published_on NULLS LAST, p.id`,
      [source.id],
    )
  ).rows;

  const totals = rows.reduce(
    (acc, row) => {
      acc.publications += 1;
      acc.versions += row.version_count;
      acc.versionFileEntries += row.version_file_entries;
      acc.authenticatedPdfEntries +=
        row.authenticated_pdf_entries;
      acc.attachmentEntries += row.attachment_entries;
      acc.publicationFileRows += row.publication_file_rows;
      acc.companyRefs += row.company_refs;
      acc.tenantRefs += row.tenant_refs;
      acc.matchRefs += row.match_refs;
      acc.collectionItemRefs += row.collection_item_refs;
      acc.runRefs += row.run_refs;
      acc.foreignRunRefs += row.foreign_run_refs;
      acc.auditEntityRefs += row.audit_entity_refs;
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

  const manifestCanonical = JSON.stringify(
    safeRows
      .slice()
      .sort((a, b) =>
        a.recordHash.localeCompare(b.recordHash),
      ),
  );
  const manifestSha256 = sha256(
    manifestCanonical,
  );
  const recordHashes = safeRows
    .map((row) => row.recordHash)
    .sort();

  console.log(
    'DOE_SP_REBUILD_AUDIT_SUMMARY=' +
      JSON.stringify({
        source: {
          code: source.code,
          isActive: source.is_active,
          hasSchedule: Boolean(
            source.schedule_cron,
          ),
        },
        safety: {
          defaultTransactionReadOnly:
            sessionReadOnly,
          transactionReadOnly,
          connectionTimeoutMs: 10_000,
          statementTimeout:
            sessionStatementTimeout,
          lockTimeout: sessionLockTimeout,
          idleInTransactionSessionTimeout:
            sessionIdleTransactionTimeout,
        },
        activeRuns: {
          count: activeRuns.length,
          byStatus: activeRuns.reduce<
            Record<string, number>
          >((acc, run) => {
            acc[run.status] =
              (acc[run.status] ?? 0) + 1;
            return acc;
          }, {}),
        },
        checkpoints: {
          count: checkpoints.length,
          latestGeneration:
            checkpoints[0]?.generation ?? null,
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

  for (const row of safeRows) {
    console.log(
      'DOE_SP_REBUILD_AUDIT_SAFE_ROW=' +
        JSON.stringify(row),
    );
  }

  const chunkSize = 100;
  for (
    let offset = 0;
    offset < recordHashes.length;
    offset += chunkSize
  ) {
    console.log(
      'DOE_SP_REBUILD_AUDIT_MANIFEST=' +
        JSON.stringify({
          chunk:
            Math.floor(offset / chunkSize) +
            1,
          hashes: recordHashes.slice(
            offset,
            offset + chunkSize,
          ),
        }),
    );
  }

  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
