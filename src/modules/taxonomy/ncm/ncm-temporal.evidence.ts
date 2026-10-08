import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../../../infrastructure/database/database.types.js';
import { lockPublicationVersionInScope } from '../../publication-scope/publication-scope.guard.js';
import { readVerifiedLegalScope, type LegalScopeReadResult } from '../legal-scope/legal-scope.repository.js';
import {
  extractNcmCandidates,
  PUBLICATION_NCM_DETECTOR_KEY,
  PUBLICATION_NCM_DETECTOR_VERSION,
} from './publication-ncm.detector.js';

/** A positive result is an exact, immutable join of legal proof, date, text
 * fragments and NCM edition contents. Old 028 scans/mentions are never
 * consulted as current legal evidence. */
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

export interface NcmEditionSnapshot {
  id: string;
  checksum: string;
}

export interface TemporalNcmEvidence {
  scanId: string;
  fingerprint: string;
  attestationId: string;
  codes: string[];
}

export function ncmTemporalFingerprint(
  publicationVersionId: string,
  evidence: LegalScopeReadResult,
  edition: NcmEditionSnapshot,
): string {
  if (!evidence.valid || evidence.coverage !== 'COMPLETE' ||
      !evidence.attestationId || !evidence.htmlSha256 || !evidence.recheckOn ||
      evidence.currentSegments === 0 || evidence.recheckOn <= evidence.asOf) {
    throw new Error('TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED');
  }
  return digest({
    contract: 'TAX13_NCM_TEMPORAL_V1',
    publicationVersionId,
    detectorKey: PUBLICATION_NCM_DETECTOR_KEY,
    detectorVersion: PUBLICATION_NCM_DETECTOR_VERSION,
    attestationId: evidence.attestationId,
    validAsOf: evidence.asOf,
    recheckOn: evidence.recheckOn,
    coverage: evidence.coverage,
    htmlSha256: evidence.htmlSha256,
    fragmentsSha256: digest(evidence.currentFragments),
    catalogEditionId: edition.id,
    catalogSha256: edition.checksum,
  });
}

/** Snapshot all entries, not merely matching NCMs: an edit to assignability
 * or a catalog replacement must invalidate a once-positive scan. PostgreSQL
 * 16/18 both provide pg_catalog.sha256(bytea). */
export async function currentNcmEdition(
  db: Kysely<DB> | Transaction<DB>,
  asOf: string,
): Promise<NcmEditionSnapshot> {
  const result = await sql<{ id: string; checksum: string }>`
    SELECT ed.id,
      encode(sha256(convert_to(
        concat_ws(':', ed.edition_code, ed.source_sha256,
          coalesce((SELECT string_agg(
            e.id::text || ':' || e.official_code || ':' || e.description || ':' || e.metadata::text,
            ';' ORDER BY e.id)
          FROM public.official_catalog_entries e
          WHERE e.catalog_edition_id=ed.id), '')), 'UTF8')), 'hex') AS checksum
    FROM public.official_catalog_editions ed
    JOIN public.official_catalogs c ON c.id=ed.catalog_id
    WHERE c.code='NCM'
      AND (ed.valid_from IS NULL OR ed.valid_from <= ${asOf}::date)
      AND (ed.valid_to IS NULL OR ed.valid_to >= ${asOf}::date)
      AND ed.status <> 'WITHDRAWN'
    ORDER BY ed.valid_from DESC NULLS LAST, ed.created_at DESC, ed.id DESC
    LIMIT 1
  `.execute(db);
  const edition = result.rows[0];
  if (!edition) throw new Error('NCM_CATALOG_EDITION_NOT_AVAILABLE_FOR_DATE');
  return edition;
}

/** Read only codes belonging to this exact signed proof. An intervening
 * attestation, a calendar change, recheck expiry or catalog edit makes this
 * read return null. An old SUCCESS(0) never suppresses historical mentions. */
export async function readCurrentNcmEvidence(
  db: Kysely<DB> | Transaction<DB>,
  publicationVersionId: string,
  evidence: LegalScopeReadResult,
): Promise<TemporalNcmEvidence | null> {
  if (!evidence.valid || evidence.coverage !== 'COMPLETE' ||
      !evidence.attestationId || !evidence.recheckOn ||
      evidence.recheckOn <= evidence.asOf || evidence.currentSegments === 0) {
    return null;
  }
  // A caller may hold a proof object from before a same-day supersession.
  // Never trust that cached object: newest legal event wins at read time.
  const latest = await sql<{ id: string }>`
    SELECT public.tax13_effective_attestation_id(
      ${publicationVersionId}::uuid, ${evidence.asOf}::date
    ) AS id
  `.execute(db);
  if (latest.rows[0]?.id !== evidence.attestationId) return null;
  const edition = await currentNcmEdition(db, evidence.asOf);
  const fingerprint = ncmTemporalFingerprint(publicationVersionId, evidence, edition);
  const run = await sql<{ id: string }>`
    SELECT scan.id FROM public.publication_ncm_scan_evidence scan
    WHERE scan.publication_version_id=${publicationVersionId}::uuid
      AND scan.legal_scope_attestation_id=${evidence.attestationId}::uuid
      AND scan.legal_as_of=${evidence.asOf}::date
      AND scan.recheck_on > ${evidence.asOf}::date
      AND scan.catalog_edition_id=${edition.id}::uuid
      AND scan.catalog_sha256=${edition.checksum}
      AND scan.run_fingerprint=${fingerprint}
      AND scan.outcome='SUCCESS' AND scan.coverage='COMPLETE'
      AND public.tax13_ncm_scan_consistent(scan.id)
    LIMIT 1
  `.execute(db);
  if (!run.rows[0]) return null;
  const codes = await sql<{ ncm_code: string }>`
    SELECT DISTINCT ncm_code FROM public.publication_ncm_scan_evidence_codes
    WHERE scan_evidence_id=${run.rows[0].id}::uuid
    ORDER BY ncm_code
  `.execute(db);
  return {
    scanId: run.rows[0].id,
    fingerprint,
    attestationId: evidence.attestationId,
    codes: codes.rows.map((row) => row.ncm_code),
  };
}

/** The caller controls an explicit single-version or bounded batch execution.
 * Concurrent workers serialize per version. Writes and supersession checks
 * happen inside one transaction; existing ledger entries are never updated. */
export async function persistTemporalNcmScan(
  trx: Transaction<DB>,
  input: { publicationVersionId: string; sanitizedHtml: string; asOf: string },
): Promise<{ inserted: boolean; matches: number; candidates: number }> {
  await lockPublicationVersionInScope(trx, input.publicationVersionId);
  await sql`SELECT pg_advisory_xact_lock(13045, hashtext(${input.publicationVersionId}))`.execute(trx);
  // Re-read UNDER the lock: an outside read is not a safe write authority.
  const proof = await readVerifiedLegalScope(trx, input);
  if (!proof.valid || proof.coverage !== 'COMPLETE' || !proof.attestationId ||
      !proof.recheckOn || proof.recheckOn <= input.asOf || proof.currentSegments === 0) {
    throw new Error('TAX13_NCM_COMPLETE_CURRENT_PROOF_REQUIRED');
  }
  const edition = await currentNcmEdition(trx, input.asOf);
  const fingerprint = ncmTemporalFingerprint(input.publicationVersionId, proof, edition);
  const occurrences = proof.currentFragments.flatMap((fragment, fragmentIndex) =>
    extractNcmCandidates(fragment).map((candidate) => ({ ...candidate, fragmentIndex })));
  const uniqueCandidates = [...new Set(occurrences.map((candidate) => candidate.code))];
  const found = uniqueCandidates.length === 0 ? { rows: [] as Array<{ id: string; code: string }> } :
    await sql<{ id: string; code: string }>`
      SELECT e.id, regexp_replace(e.official_code, '[^0-9]', '', 'g') AS code
      FROM public.official_catalog_entries e
      WHERE e.catalog_edition_id=${edition.id}::uuid
        AND coalesce(e.metadata ->> 'assignable', 'false')='true'
        -- An entry may be revoked within a still CURRENT catalog edition.
        -- The portal importer persists normalized validity as ISO dates.
        AND (nullif(e.metadata ->> 'normalizedValidFrom', '') IS NULL
          OR (e.metadata ->> 'normalizedValidFrom')::date <= ${input.asOf}::date)
        AND (nullif(e.metadata ->> 'normalizedValidTo', '') IS NULL
          OR (e.metadata ->> 'normalizedValidTo')::date >= ${input.asOf}::date)
        AND regexp_replace(e.official_code, '[^0-9]', '', 'g')=ANY(${uniqueCandidates}::text[])
    `.execute(trx);
  const byCode = new Map(found.rows.map((row) => [row.code, row.id]));
  const matches = new Set(occurrences.filter((candidate) => byCode.has(candidate.code))
    .map((candidate) => candidate.code)).size;

  const predecessor = await sql<{ id: string }>`
    SELECT id FROM public.publication_ncm_scan_evidence
    WHERE publication_version_id=${input.publicationVersionId}::uuid
      AND detector_key=${PUBLICATION_NCM_DETECTOR_KEY}
      AND detector_version=${PUBLICATION_NCM_DETECTOR_VERSION}
    ORDER BY created_at DESC, id DESC LIMIT 1
  `.execute(trx);
  const written = await sql<{ id: string }>`
    INSERT INTO public.publication_ncm_scan_evidence (
      publication_version_id, detector_key, detector_version,
      legal_scope_attestation_id, legal_as_of, recheck_on, coverage,
      html_sha256, current_fragments_sha256, catalog_edition_id, catalog_sha256,
      run_fingerprint, source_field, candidate_count, match_count, outcome,
      supersedes_scan_id
    ) VALUES (
      ${input.publicationVersionId}::uuid, ${PUBLICATION_NCM_DETECTOR_KEY},
      ${PUBLICATION_NCM_DETECTOR_VERSION}, ${proof.attestationId}::uuid,
      ${proof.asOf}::date, ${proof.recheckOn}::date, ${proof.coverage},
      ${proof.htmlSha256}, ${digest(proof.currentFragments)},
      ${edition.id}::uuid, ${edition.checksum}, ${fingerprint},
      'CONTENT_TEXT', ${uniqueCandidates.length}, ${matches},
      'SUCCESS', ${predecessor.rows[0]?.id ?? null}::uuid
    )
    ON CONFLICT (run_fingerprint) DO NOTHING RETURNING id
  `.execute(trx);
  const scanId = written.rows[0]?.id;
  if (!scanId) return { inserted: false, matches, candidates: uniqueCandidates.length };
  for (const candidate of occurrences) {
    const entryId = byCode.get(candidate.code);
    if (!entryId) continue;
    await sql`
      INSERT INTO public.publication_ncm_scan_evidence_codes(
        scan_evidence_id, ncm_code, catalog_entry_id, fragment_index, excerpt
      ) VALUES (
        ${scanId}::uuid, ${candidate.code}, ${entryId}::uuid,
        ${candidate.fragmentIndex}, ${candidate.excerpt}
      ) ON CONFLICT (scan_evidence_id,ncm_code,fragment_index) DO NOTHING
    `.execute(trx);
  }
  return { inserted: true, matches, candidates: uniqueCandidates.length };
}
