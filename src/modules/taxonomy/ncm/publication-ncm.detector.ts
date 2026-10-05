import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../../../infrastructure/database/database.types.js';

export const PUBLICATION_NCM_DETECTOR_KEY = 'ncm.catalog.regex';
export const PUBLICATION_NCM_DETECTOR_VERSION = '1.0.0';

export type PublicationNcmSourceField =
  | 'CONTENT_TEXT'
  | 'RELEVANT_EXCERPT'
  | 'NONE';

export interface NcmCandidate {
  code: string;
  spanStart: number;
  spanEnd: number;
  excerpt: string;
  occurrenceCount: number;
}

export interface PublicationNcmBatchResult {
  selected: number;
  succeeded: number;
  failed: number;
  candidates: number;
  matches: number;
}

interface VersionForNcmScan {
  publication_version_id: string;
  content_text: string | null;
  relevant_excerpt: string | null;
}

interface CatalogMatch {
  id: string;
  code: string;
}

const CANDIDATE_RE = /(?<!\d)(\d{8}|\d{4}\.\d{2}\.\d{2})(?!\d)/g;
const EXCERPT_RADIUS = 120;
const FAILED_RETRY_INTERVAL = '15 minutes';

function normalizeCandidate(raw: string): string {
  return raw.replace(/\D/g, '');
}

function evidenceExcerpt(
  text: string,
  start: number,
  end: number,
): string {
  const from = Math.max(0, start - EXCERPT_RADIUS);
  const to = Math.min(text.length, end + EXCERPT_RADIUS);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

export function extractNcmCandidates(text: string): NcmCandidate[] {
  const byCode = new Map<string, NcmCandidate>();

  for (const match of text.matchAll(CANDIDATE_RE)) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;

    const code = normalizeCandidate(raw);
    if (!/^\d{8}$/.test(code)) continue;

    const existing = byCode.get(code);
    if (existing) {
      existing.occurrenceCount += 1;
      continue;
    }

    byCode.set(code, {
      code,
      spanStart: start,
      spanEnd: start + raw.length,
      excerpt: evidenceExcerpt(text, start, start + raw.length),
      occurrenceCount: 1,
    });
  }

  return [...byCode.values()];
}

function selectText(row: VersionForNcmScan): {
  text: string;
  sourceField: PublicationNcmSourceField;
} {
  const content = row.content_text?.trim();
  if (content) {
    return { text: row.content_text!, sourceField: 'CONTENT_TEXT' };
  }

  const excerpt = row.relevant_excerpt?.trim();
  if (excerpt) {
    return {
      text: row.relevant_excerpt!,
      sourceField: 'RELEVANT_EXCERPT',
    };
  }

  return { text: '', sourceField: 'NONE' };
}

async function assertCurrentNcmCatalog(
  db: Kysely<DB>,
): Promise<void> {
  const result = await sql<{ id: string }>`
    SELECT oce.id
    FROM official_catalog_editions oce
    JOIN official_catalogs oc
      ON oc.id = oce.catalog_id
    WHERE oc.code = 'NCM'
      AND oce.status = 'CURRENT'
    LIMIT 1
  `.execute(db);

  if (!result.rows[0]) {
    throw new Error('NCM_CURRENT_CATALOG_NOT_AVAILABLE');
  }
}

async function catalogMatches(
  trx: Transaction<DB>,
  codes: string[],
): Promise<Map<string, CatalogMatch>> {
  if (codes.length === 0) return new Map();

  const result = await sql<{
    id: string;
    code: string;
  }>`
    SELECT
      oce.id,
      regexp_replace(oce.official_code, '[^0-9]', '', 'g') AS code
    FROM official_catalog_entries oce
    JOIN official_catalog_editions oed
      ON oed.id = oce.catalog_edition_id
    JOIN official_catalogs oc
      ON oc.id = oed.catalog_id
    WHERE oc.code = 'NCM'
      AND oed.status = 'CURRENT'
      AND COALESCE(oce.metadata ->> 'assignable', 'false') = 'true'
      AND regexp_replace(oce.official_code, '[^0-9]', '', 'g')
          = ANY(${codes}::text[])
  `.execute(trx);

  return new Map(
    result.rows.map((row) => [row.code, row]),
  );
}

async function persistSuccessfulScan(
  trx: Transaction<DB>,
  row: VersionForNcmScan,
  sourceField: PublicationNcmSourceField,
  candidates: NcmCandidate[],
): Promise<number> {
  const matches = await catalogMatches(
    trx,
    candidates.map((candidate) => candidate.code),
  );

  let insertedMatches = 0;

  for (const candidate of candidates) {
    const catalog = matches.get(candidate.code);
    if (!catalog) continue;

    const metadata = JSON.stringify({
      occurrenceCount: candidate.occurrenceCount,
      sourceField,
      interpretation: 'CATALOG_CODE_MENTION_ONLY',
    });

    const inserted = await sql<{ id: string }>`
      INSERT INTO publication_ncm_mentions (
        publication_version_id,
        ncm_code,
        official_catalog_entry_id,
        verification_status,
        method_type,
        detector_key,
        detector_version,
        confidence,
        span_start,
        span_end,
        excerpt,
        metadata
      ) VALUES (
        ${row.publication_version_id}::uuid,
        ${candidate.code},
        ${catalog.id}::uuid,
        'CATALOG_MATCHED',
        'EXTRACTOR',
        ${PUBLICATION_NCM_DETECTOR_KEY},
        ${PUBLICATION_NCM_DETECTOR_VERSION},
        1.0,
        ${candidate.spanStart},
        ${candidate.spanEnd},
        ${candidate.excerpt},
        ${metadata}::jsonb
      )
      ON CONFLICT (
        publication_version_id,
        ncm_code,
        detector_key,
        detector_version
      ) DO NOTHING
      RETURNING id
    `.execute(trx);

    if (inserted.rows[0]) insertedMatches += 1;
  }

  await sql`
    INSERT INTO publication_ncm_scans (
      publication_version_id,
      detector_key,
      detector_version,
      status,
      source_field,
      candidate_count,
      match_count,
      error_message,
      scanned_at
    ) VALUES (
      ${row.publication_version_id}::uuid,
      ${PUBLICATION_NCM_DETECTOR_KEY},
      ${PUBLICATION_NCM_DETECTOR_VERSION},
      'SUCCESS',
      ${sourceField},
      ${candidates.length},
      ${matches.size},
      NULL,
      now()
    )
    ON CONFLICT (
      publication_version_id,
      detector_key,
      detector_version
    ) DO UPDATE SET
      status = 'SUCCESS',
      source_field = EXCLUDED.source_field,
      candidate_count = EXCLUDED.candidate_count,
      match_count = EXCLUDED.match_count,
      error_message = NULL,
      scanned_at = now()
  `.execute(trx);

  return insertedMatches;
}

export async function markFailedScan(
  db: Kysely<DB>,
  row: VersionForNcmScan,
  sourceField: PublicationNcmSourceField,
  candidateCount: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message.slice(0, 2_000)
    : 'Unknown NCM enrichment error';

  await sql`
    INSERT INTO publication_ncm_scans (
      publication_version_id,
      detector_key,
      detector_version,
      status,
      source_field,
      candidate_count,
      match_count,
      error_message,
      scanned_at
    ) VALUES (
      ${row.publication_version_id}::uuid,
      ${PUBLICATION_NCM_DETECTOR_KEY},
      ${PUBLICATION_NCM_DETECTOR_VERSION},
      'FAILED',
      ${sourceField},
      ${candidateCount},
      0,
      ${message},
      now()
    )
    ON CONFLICT (
      publication_version_id,
      detector_key,
      detector_version
    ) DO UPDATE SET
      status = 'FAILED',
      source_field = EXCLUDED.source_field,
      candidate_count = EXCLUDED.candidate_count,
      match_count = 0,
      error_message = EXCLUDED.error_message,
      scanned_at = now()
    WHERE publication_ncm_scans.status <> 'SUCCESS'
  `.execute(db);
}

async function selectBatch(
  db: Kysely<DB>,
  limit: number,
): Promise<VersionForNcmScan[]> {
  const result = await sql<VersionForNcmScan>`
    SELECT
      pv.id AS publication_version_id,
      pv.content_text,
      pv.relevant_excerpt
    FROM publications p
    JOIN publication_versions pv
      ON pv.publication_id = p.id
     AND pv.is_current = true
    LEFT JOIN publication_ncm_scans pns
      ON pns.publication_version_id = pv.id
     AND pns.detector_key = ${PUBLICATION_NCM_DETECTOR_KEY}
     AND pns.detector_version = ${PUBLICATION_NCM_DETECTOR_VERSION}
    WHERE
      pns.id IS NULL
      OR (
        pns.status = 'FAILED'
        AND pns.scanned_at <= now() - ${FAILED_RETRY_INTERVAL}::interval
      )
    ORDER BY
      p.published_on DESC NULLS LAST,
      pv.captured_at DESC,
      pv.id
    LIMIT ${limit}
  `.execute(db);

  return result.rows;
}

export async function processPublicationNcmEnrichmentBatch(
  db: Kysely<DB>,
  options: { limit?: number } = {},
): Promise<PublicationNcmBatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  await assertCurrentNcmCatalog(db);

  const rows = await selectBatch(db, limit);
  const result: PublicationNcmBatchResult = {
    selected: rows.length,
    succeeded: 0,
    failed: 0,
    candidates: 0,
    matches: 0,
  };

  for (const row of rows) {
    const { text, sourceField } = selectText(row);
    const candidates = extractNcmCandidates(text);
    result.candidates += candidates.length;

    try {
      const insertedMatches = await db.transaction().execute((trx) =>
        persistSuccessfulScan(
          trx,
          row,
          sourceField,
          candidates,
        ),
      );

      result.succeeded += 1;
      result.matches += insertedMatches;
    } catch (error) {
      result.failed += 1;
      await markFailedScan(
        db,
        row,
        sourceField,
        candidates.length,
        error,
      );
    }
  }

  return result;
}
