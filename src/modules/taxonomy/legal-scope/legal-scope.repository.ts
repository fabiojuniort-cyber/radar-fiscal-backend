import { sql, type Kysely } from 'kysely';

import type { DB } from '../../../infrastructure/database/database.types.js';
import {
  validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
  type LegalScopeValidation,
} from './legal-scope-evidence.js';

/**
 * Source-adapter allowlist, reviewed in source code rather than copied from
 * remote HTML, source_metadata or a tenant-editable table.
 * Enable additional portals only with their own source adapter/evidence tests.
 */
export const OFFICIAL_EVIDENCE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  confaz: ['www.confaz.fazenda.gov.br'],
};

export type LegalScopeReadResult = LegalScopeValidation & {
  attestationId: string | null;
  asOf: string;
  /** Only populated after full content-addressed row validation. */
  htmlSha256: string | null;
  recheckOn: string | null;
};

export interface AttestationRow {
  id: string;
  manifest: LegalScopeEvidenceV1;
  source_id: string;
  source_code: string;
  official_url: string;
  origin_url: string;
  html_sha256: string;
  valid_as_of: string;
  recheck_on: string;
  verified_at: Date;
  coverage: string;
  attestor_kind: string;
}

function unverified(asOf: string, reason: string): LegalScopeReadResult {
  return {
    valid: false,
    reason,
    coverage: 'UNVERIFIED',
    currentText: '',
    currentFragments: [],
    currentSegments: 0,
    attestationId: null,
    asOf,
    htmlSha256: null,
    recheckOn: null,
  };
}

/**
 * Worker-only reader. RLS restricts rows to current in-scope publications;
 * this code refuses unregistered source hosts and checks all DB columns
 * against the audited content-addressed manifest before exposing current text.
 *
 * No attestation record is created by a collection connector automatically.
 * An official consolidation/amendment review must first be persisted by an
 * admin-controlled, audited workflow (separate B4 deliverable).
 */
export async function readVerifiedLegalScope(
  db: Kysely<DB>,
  input: { publicationVersionId: string; sanitizedHtml: string; asOf: string },
): Promise<LegalScopeReadResult> {
  const result = await sql<AttestationRow>`
    SELECT
      a.id,
      a.manifest,
      a.source_id,
      s.code AS source_code,
      a.official_url,
      po.official_url AS origin_url,
      a.html_sha256,
      a.valid_as_of::text AS valid_as_of,
      a.recheck_on::text AS recheck_on,
      a.verified_at,
      a.coverage,
      a.attestor_kind
    FROM public.publication_legal_scope_attestations a
    JOIN public.publication_origins po
      ON po.id = a.publication_origin_id
     AND po.source_id = a.source_id
    JOIN public.sources s ON s.id = a.source_id
    JOIN public.publication_versions pv
      ON pv.id = a.publication_version_id
     AND pv.publication_id = po.publication_id
     AND pv.is_current = TRUE
    WHERE a.publication_version_id = ${input.publicationVersionId}::uuid
      AND a.valid_as_of = ${input.asOf}::date
      AND public.publication_scope_is_in_scope(pv.publication_id)
      -- An explicit supersession outranks UUID/timestamp ordering, even
      -- when both events were committed with the same transaction timestamp.
      AND NOT EXISTS (
        SELECT 1 FROM public.publication_legal_scope_attestations successor
        WHERE successor.supersedes_attestation_id = a.id
          AND successor.publication_version_id = a.publication_version_id
          AND successor.valid_as_of = a.valid_as_of
      )
      -- Competing terminal branches are ambiguous: fail closed rather than
      -- selecting an arbitrary "latest" UUID as a legal authority.
      AND (
        SELECT count(*) FROM public.publication_legal_scope_attestations terminal
        WHERE terminal.publication_version_id = a.publication_version_id
          AND terminal.valid_as_of = a.valid_as_of
          AND NOT EXISTS (
            SELECT 1 FROM public.publication_legal_scope_attestations child
            WHERE child.supersedes_attestation_id = terminal.id
              AND child.publication_version_id = terminal.publication_version_id
              AND child.valid_as_of = terminal.valid_as_of
          )
      ) = 1
    LIMIT 1
  `.execute(db);

  return verifyPersistedLegalScopeRow(result.rows[0], input);
}

/** Pure boundary: DB ledger fields must match the manifest before trust. */
export function verifyPersistedLegalScopeRow(
  row: AttestationRow | undefined,
  input: { publicationVersionId: string; sanitizedHtml: string; asOf: string },
): LegalScopeReadResult {
  if (!row) return unverified(input.asOf, 'ATTESTATION_MISSING');
  const hosts = OFFICIAL_EVIDENCE_HOSTS[row.source_code];
  if (!hosts) return unverified(input.asOf, 'SOURCE_ADAPTER_NOT_ATTESTED');

  const manifest = row.manifest;
  if (!manifest || manifest.version !== 1 ||
      manifest.htmlSha256 !== row.html_sha256 ||
      manifest.sourceId !== row.source_id ||
      manifest.officialUrl !== row.official_url ||
      manifest.validAsOf !== row.valid_as_of ||
      manifest.recheckOn !== row.recheck_on ||
      manifest.coverage !== row.coverage ||
      manifest.verifiedAt !== new Date(row.verified_at).toISOString() ||
      row.origin_url !== row.official_url ||
      !['OFFICIAL_ADAPTER', 'HUMAN_REVIEW'].includes(row.attestor_kind)) {
    return unverified(input.asOf, 'ATTESTATION_RECORD_MISMATCH');
  }

  const checked = validateLegalScopeEvidence(manifest, {
    publicationVersionId: input.publicationVersionId,
    sourceId: row.source_id,
    officialUrl: row.official_url,
    sanitizedHtml: input.sanitizedHtml,
    validAsOf: input.asOf,
    trustedAttestor: true, // Only admin-owned persisted ledger + RLS source.
    trustedEvidenceHosts: hosts,
  });
  return {
    ...checked,
    attestationId: checked.valid ? row.id : null,
    asOf: input.asOf,
    htmlSha256: checked.valid ? row.html_sha256 : null,
    recheckOn: checked.valid ? row.recheck_on : null,
  };
}
