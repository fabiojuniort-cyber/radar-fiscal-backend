import { brazilLegalReferenceDate } from './legal-scope-evidence.js';
import { verifyPersistedLegalScopeRow, type AttestationRow } from './legal-scope.repository.js';

/**
 * NOT ROUTED: candidate for a future audited backend projection.
 *
 * A valid worker ledger row is not a grant of public distribution. The
 * renderer must separately prove it is showing the identical sanitized HTML
 * and can map exact UTF-16 text-node offsets. Until that reviewed bridge
 * exists, highlightsAuthorized remains false even for verified evidence.
 */
export interface ReviewedPublicCurrentSegment {
  start: number;
  end: number;
  textSha256: string;
  status: 'CURRENT';
  evidenceUrls: string[];
  supportingActs: string[];
}

export interface ReviewedPublicLegalScopeDraft {
  schemaVersion: 1;
  status: 'VERIFIED_PARTIAL' | 'VERIFIED_COMPLETE';
  referenceDate: string;
  publicationVersionId: string;
  attestationId: string;
  htmlSha256: string;
  recheckOn: string;
  verifiedAt: string;
  /** Exact UTF-16 text-node order of the stored SANITIZED_HTML, not UI HTML. */
  offsetBasis: 'SOURCE_SANITIZED_HTML_UTF16';
  highlightsAuthorized: false;
  currentSegments: ReviewedPublicCurrentSegment[];
}

export type PublicLegalScopeDraft =
  | UnverifiedPublicLegalScope
  | ReviewedPublicLegalScopeDraft;

/**
 * Pure preparation boundary for a FUTURE worker-authorized read-only bridge.
 * Never call this with source_metadata, frontend content, or tenant JSON.
 * Validates the persisted attestation again before disclosing CURRENT slices.
 *
 * No route uses this function; in particular ordinary radar_app cannot SELECT
 * publication_legal_scope_attestations under migration 044 FORCE RLS.
 */
export function prepareReviewedPublicLegalScopeDraft(
  row: AttestationRow | undefined,
  input: { publicationVersionId: string; sanitizedHtml: string; asOf: string },
): PublicLegalScopeDraft {
  const fallback = () => unavailablePublicLegalScope(input.publicationVersionId, input.asOf);
  if (!row) return fallback();

  const checked = verifyPersistedLegalScopeRow(row, input);
  if (!checked.valid || checked.currentSegments === 0 || !checked.attestationId ||
      !['PARTIAL', 'COMPLETE'].includes(checked.coverage)) {
    return fallback();
  }

  const segments = row.manifest.segments
    .filter((segment) => segment.status === 'CURRENT')
    .map((segment): ReviewedPublicCurrentSegment => ({
      start: segment.start,
      end: segment.end,
      textSha256: segment.textSha256,
      status: 'CURRENT',
      evidenceUrls: [...segment.evidenceUrls],
      supportingActs: Array.isArray(segment.supportingActs)
        ? [...segment.supportingActs]
        : [],
    }));
  if (segments.length !== checked.currentSegments ||
      segments.length !== checked.currentFragments.length) return fallback();

  return {
    schemaVersion: 1,
    status: checked.coverage === 'COMPLETE' ? 'VERIFIED_COMPLETE' : 'VERIFIED_PARTIAL',
    referenceDate: checked.asOf,
    publicationVersionId: input.publicationVersionId,
    attestationId: checked.attestationId,
    htmlSha256: row.html_sha256,
    recheckOn: row.recheck_on,
    verifiedAt: row.manifest.verifiedAt,
    offsetBasis: 'SOURCE_SANITIZED_HTML_UTF16',
    highlightsAuthorized: false,
    currentSegments: segments,
  };
}


/**
 * TAX13/F2: public representation for a document whose scoped legal evidence
 * has NOT been authorized for publication. This does not query the worker
 * ledger and intentionally cannot return a positive CURRENT assertion.
 *
 * NEVER infer legal status from source_metadata, remote CSS/current markers,
 * display dates, previously detected NCMs or legacy classification.
 */
export interface UnverifiedPublicLegalScope {
  schemaVersion: 1;
  status: 'UNVERIFIED';
  reason: 'NO_AUTHORIZED_PUBLIC_ATTESTATION';
  referenceDate: string;
  publicationVersionId: string | null;
  highlightsAuthorized: false;
  currentSegments: [];
}

export function unavailablePublicLegalScope(
  publicationVersionId: string | null,
  referenceDate: string = brazilLegalReferenceDate(),
): UnverifiedPublicLegalScope {
  return {
    schemaVersion: 1,
    status: 'UNVERIFIED',
    reason: 'NO_AUTHORIZED_PUBLIC_ATTESTATION',
    referenceDate,
    publicationVersionId,
    highlightsAuthorized: false,
    currentSegments: [],
  };
}
