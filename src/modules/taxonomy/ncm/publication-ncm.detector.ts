import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';

import type { DB } from '../../../infrastructure/database/database.types.js';
import { currentWordingText } from '../../collection/legal-presentation.js';
import { brazilLegalReferenceDate } from '../legal-scope/legal-scope-evidence.js';
import { readVerifiedLegalScope } from '../legal-scope/legal-scope.repository.js';
import { currentNcmEdition, persistTemporalNcmScan, type NcmEditionSnapshot } from './ncm-temporal.evidence.js';
import {
  isPublicationOutOfScopeError,
  lockPublicationVersionInScope,
} from '../../publication-scope/publication-scope.guard.js';

export const PUBLICATION_NCM_DETECTOR_KEY = 'ncm.catalog.regex';
// 1.3.0: candidate extraction exclusively from an audited, date-bound
// legal-scope attestation, never merely from CSS or remote status attributes.
// Prior 1.2.0 SUCCESS scans remain historical and are NOT accepted as proof.
export const PUBLICATION_NCM_DETECTOR_VERSION = '1.3.0';

export type PublicationNcmSourceField =
  | 'CONTENT_TEXT'
  | 'RELEVANT_EXCERPT'
  | 'NONE';

/**
 * Mentions stay append-only evidence. When a newer version of the same
 * detector has scanned a publication version, only its findings count:
 * this condition hides the older ones (e.g. NCMs of previous wordings that
 * detector 1.0.0 still read). Mentions without scans are kept.
 */
export function NOT_SUPERSEDED_NCM_MENTION_SQL(alias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM publication_ncm_scans newer_scan
    WHERE newer_scan.publication_version_id = ${alias}.publication_version_id
      AND newer_scan.detector_key = ${alias}.detector_key
      AND newer_scan.status = 'SUCCESS'
      AND newer_scan.detector_version > ${alias}.detector_version
      -- R2-01: 1.3.0 may only ever be scoped evidence; it cannot make
      -- every legacy NCM vanish in unchecked areas of the document.
      AND newer_scan.detector_version IN ('1.1.0', '1.2.0')
  )`;
}

export function notSupersededNcmMention(alias: string): RawBuilder<boolean> {
  return sql<boolean>`${sql.raw(NOT_SUPERSEDED_NCM_MENTION_SQL(alias))}`;
}

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
  presentation_html: string | null;
}

interface CatalogMatch {
  id: string;
  code: string;
}

const CANDIDATE_RE = /(?<![\d.])(\d{8}|\d{4}\.\d{2}\.\d{2}|\d{4}\.\d{4})(?![\d]|\.\d)/g;
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

/**
 * Diagnostic only: codes found in unscoped raw content but absent from the
 * date-bound, attested CURRENT fragments. Their legal status is UNKNOWN:
 * they could be editorial citations, revoked wording, uncovered annexes or
 * text not stored in the certified presentation. Never label them PREVIOUS
 * or feed them into a persisted CURRENT classification.
 */
export function codesOutsideAttestedCurrent(
  rawContentText: string | null | undefined,
  attestedCurrentText: string | null | undefined,
): string[] {
  const current = new Set(
    extractNcmCandidates(attestedCurrentText ?? '').map((item) => item.code),
  );
  return [...new Set(
    extractNcmCandidates(rawContentText ?? '').map((item) => item.code),
  )].filter((code) => !current.has(code)).sort();
}

export function selectText(row: VersionForNcmScan): {
  text: string;
  sourceField: PublicationNcmSourceField;
  currentWordingOnly: boolean;
} {
  // Unscoped stored text/excerpts contain titles, revoked amendments and
  // external annex references. They cannot be a source of affirmative NCM
  // evidence. Only the legal-scope selection can authorize a detector match.
  // In particular: absent/oversized/ambiguous HTML must NOT fall back to
  // content_text or relevant_excerpt, even if one of those is non-empty.
  const current = currentWordingText(row.presentation_html);
  if (current !== undefined) {
    return { text: current, sourceField: 'CONTENT_TEXT', currentWordingOnly: true };
  }
  return { text: '', sourceField: 'NONE', currentWordingOnly: false };
}

export async function assertCurrentNcmCatalog(
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

export async function catalogMatches(
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

export async function persistSuccessfulScan(
  trx: Transaction<DB>,
  row: VersionForNcmScan,
  sourceField: PublicationNcmSourceField,
  candidates: NcmCandidate[],
  currentWordingOnly = false,
): Promise<number> {
  await lockPublicationVersionInScope(
    trx,
    row.publication_version_id,
  );

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
      currentWordingOnly,
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
    WHERE publication_ncm_scans.status <> 'SUCCESS'
  `.execute(trx);

  return insertedMatches;
}

async function markFailedScan(
  db: Kysely<DB>,
  row: VersionForNcmScan,
  sourceField: PublicationNcmSourceField,
  candidateCount: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error
    ? error.message.slice(0, 2_000)
    : 'Unknown NCM enrichment error';

  await db.transaction().execute(async (trx) => {
    await lockPublicationVersionInScope(
      trx,
      row.publication_version_id,
    );

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
    `.execute(trx);
  });
}

async function selectBatch(
  db: Kysely<DB>,
  limit: number,
  asOf: string,
  edition: NcmEditionSnapshot,
): Promise<VersionForNcmScan[]> {
  const result = await sql<VersionForNcmScan>`
    SELECT
      pv.id AS publication_version_id,
      pv.content_text,
      pv.relevant_excerpt,
      CASE WHEN pv.source_metadata -> 'presentation' ->> 'format' = 'SANITIZED_HTML'
        THEN pv.source_metadata -> 'presentation' ->> 'html'
        ELSE NULL
      END AS presentation_html
    FROM publications p
    JOIN publication_versions pv
      ON pv.publication_id = p.id
     AND pv.is_current = true
    WHERE public.publication_scope_is_in_scope(p.id)
      -- Without an audited provenance manifest the new version must NOT
      -- create a SUCCESS scan and supersede older NCM findings.
      AND EXISTS (
        SELECT 1
        FROM public.publication_legal_scope_attestations a
        WHERE a.publication_version_id = pv.id
          AND a.valid_as_of = ${asOf}::date
          AND a.recheck_on > ${asOf}::date
          AND a.coverage = 'COMPLETE'
          AND a.id = public.tax13_effective_attestation_id(pv.id, ${asOf}::date)
      )
      -- A SUCCESS on a different attestation, day or NCM edition is never
      -- evidence of completion. Legacy 028 statuses do not gate this path.
      AND NOT EXISTS (
        SELECT 1 FROM public.publication_ncm_scan_evidence e
        WHERE e.publication_version_id = pv.id
          AND e.detector_key = ${PUBLICATION_NCM_DETECTOR_KEY}
          AND e.detector_version = ${PUBLICATION_NCM_DETECTOR_VERSION}
          AND e.legal_as_of = ${asOf}::date
          AND e.recheck_on > ${asOf}::date
          AND e.catalog_edition_id = ${edition.id}::uuid
          AND e.catalog_sha256 = ${edition.checksum}
          AND e.legal_scope_attestation_id = public.tax13_effective_attestation_id(pv.id, ${asOf}::date)
          AND e.outcome = 'SUCCESS'
          AND public.tax13_ncm_scan_consistent(e.id)
          AND e.run_fingerprint = public.tax13_current_ncm_scan_fingerprint(pv.id)
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

  const asOf = brazilLegalReferenceDate();
  const edition = await currentNcmEdition(db, asOf);
  const rows = await selectBatch(db, limit, asOf, edition);
  const result: PublicationNcmBatchResult = {
    selected: rows.length,
    succeeded: 0,
    failed: 0,
    candidates: 0,
    matches: 0,
  };

  for (const row of rows) {
    // The official attestation is the only source of CURRENT legal text.
    // Invalid, stale and partial/unreviewed HTML never becomes SUCCESS.
    // In particular, zero matches without proof must not hide old findings.
    let verified;
    try {
      verified = await readVerifiedLegalScope(db, {
        publicationVersionId: row.publication_version_id,
        sanitizedHtml: row.presentation_html ?? '',
        asOf,
      });
    } catch (error) {
      // Operational faults are not evidence of zero current NCMs.
      // Surface the failure rather than sealing this publication as SUCCESS.
      throw error;
    }
    // PARTIAL is not proof of the absence of NCMs in unreviewed annexes.
    if (!verified.valid || verified.coverage !== 'COMPLETE' ||
        verified.currentSegments === 0) continue;
    const sourceField: PublicationNcmSourceField = 'CONTENT_TEXT';
    const currentWordingOnly = true;
    const candidates = extractNcmCandidates(verified.currentText);
    result.candidates += candidates.length;

    try {
      const stored = await db.transaction().execute(async (trx) => {
        const temporal = await persistTemporalNcmScan(trx, {
          publicationVersionId: row.publication_version_id,
          sanitizedHtml: row.presentation_html ?? '',
          asOf,
        });
        // Keep the legacy catalog-only indexes populated for historical
        // search. They NEVER authorize CURRENT or taxonomy classification.
        if (temporal.inserted) {
          await persistSuccessfulScan(trx, row, sourceField, candidates, currentWordingOnly);
        }
        return temporal;
      });

      // Both workers completed a valid scan when the fingerprint already
      // exists; only the first committed physical scan adds matched rows.
      result.succeeded += 1;
      if (stored.inserted) result.matches += stored.matches;
    } catch (error) {
      if (isPublicationOutOfScopeError(error)) {
        continue;
      }

      try {
        await markFailedScan(
          db,
          row,
          sourceField,
          candidates.length,
          error,
        );
        result.failed += 1;
      } catch (markError) {
        if (isPublicationOutOfScopeError(markError)) {
          continue;
        }
        throw markError;
      }
    }
  }

  return result;
}
