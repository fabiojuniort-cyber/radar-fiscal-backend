import { brazilLegalReferenceDate } from './legal-scope-evidence.js';

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
