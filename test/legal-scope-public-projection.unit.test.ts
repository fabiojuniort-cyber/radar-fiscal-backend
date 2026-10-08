import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unavailablePublicLegalScope } from '../src/modules/taxonomy/legal-scope/legal-scope.public-projection.js';

test('TAX13 public API does not infer CURRENT from an act identity or its presence', () => {
  const row = unavailablePublicLegalScope(
    '00000000-0000-4000-8000-000000000001',
    '2026-10-08',
  );
  assert.deepEqual(row, {
    schemaVersion: 1,
    status: 'UNVERIFIED',
    reason: 'NO_AUTHORIZED_PUBLIC_ATTESTATION',
    referenceDate: '2026-10-08',
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    highlightsAuthorized: false,
    currentSegments: [],
  });
});

test('TAX13 public API remains fail-closed for absent current versions', () => {
  const row = unavailablePublicLegalScope(null, '2026-10-08');
  assert.equal(row.publicationVersionId, null);
  assert.equal(row.highlightsAuthorized, false);
  assert.equal(row.status, 'UNVERIFIED');
  assert.deepEqual(row.currentSegments, []);
});

import { createHash } from 'node:crypto';

import type { AttestationRow } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';
import {
  prepareReviewedPublicLegalScopeDraft,
} from '../src/modules/taxonomy/legal-scope/legal-scope.public-projection.js';

const checksum = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const reviewedVersion = '00000000-0000-4000-8000-000000000401';
const reviewedAttestation = '00000000-0000-4000-8000-000000000402';
const sourceId = '00000000-0000-4000-8000-000000000403';
const sourceUrl = 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91';
const sourceHtml = '<p>Redação anterior 8451.21.00</p><p>NCM 7307.19.20 vigente</p>';
const currentPiece = 'NCM 7307.19.20 vigente';
const startIndex = sourceHtml.indexOf(currentPiece);
const decodedStart = 'Redação anterior 8451.21.00'.length;
const reviewedAt = new Date(Date.now() - 60_000).toISOString();

function legalRow(): AttestationRow {
  const manifest = {
    version: 1 as const,
    publicationVersionId: reviewedVersion,
    sourceId,
    officialUrl: sourceUrl,
    htmlSha256: checksum(sourceHtml),
    validAsOf: '2026-10-08',
    verifiedAt: reviewedAt,
    recheckOn: '2026-10-20',
    coverage: 'PARTIAL' as const,
    segments: [{
      start: decodedStart,
      end: decodedStart + currentPiece.length,
      textSha256: checksum(currentPiece),
      status: 'CURRENT' as const,
      method: 'OFFICIAL_CONSOLIDATION' as const,
      evidenceUrls: [sourceUrl],
      supportingActs: ['CONVÊNIO ICMS 52/91'],
    }],
  };
  return {
    id: reviewedAttestation,
    manifest,
    source_id: sourceId,
    source_code: 'confaz',
    official_url: sourceUrl,
    origin_url: sourceUrl,
    html_sha256: manifest.htmlSha256,
    valid_as_of: manifest.validAsOf,
    recheck_on: manifest.recheckOn,
    verified_at: new Date(manifest.verifiedAt),
    coverage: manifest.coverage,
    attestor_kind: 'HUMAN_REVIEW',
  };
}
const legalInput = {
  publicationVersionId: reviewedVersion,
  sanitizedHtml: sourceHtml,
  asOf: '2026-10-08',
};

test('TAX13 internal projection returns only validated CURRENT and never authorizes the renderer', () => {
  const result = prepareReviewedPublicLegalScopeDraft(legalRow(), legalInput);
  assert.equal(result.status, 'VERIFIED_PARTIAL');
  assert.equal(result.highlightsAuthorized, false);
  if (result.status === 'UNVERIFIED') throw new Error('reviewed row unexpectedly invalid');
  assert.equal(result.offsetBasis, 'SOURCE_SANITIZED_HTML_UTF16');
  assert.equal(result.publicationVersionId, reviewedVersion);
  assert.equal(result.attestationId, reviewedAttestation);
  assert.equal(result.htmlSha256, checksum(sourceHtml));
  assert.equal(result.currentSegments.length, 1);
  assert.deepEqual(result.currentSegments[0], {
    start: decodedStart,
    end: decodedStart + currentPiece.length,
    textSha256: checksum(currentPiece),
    status: 'CURRENT',
    evidenceUrls: [sourceUrl],
    supportingActs: ['CONVÊNIO ICMS 52/91'],
  });
  assert.equal(startIndex > 0, true);
  assert.ok(decodedStart !== startIndex, 'offset must NOT index the source HTML string');
});

test('TAX13 no positive public projection from missing, foreign, stale or corrupted evidence', () => {
  const cases: Array<[string, AttestationRow | undefined, typeof legalInput]> = [
    ['missing', undefined, legalInput],
    ['foreign-version', legalRow(), { ...legalInput, publicationVersionId: 'other-version' }],
    ['wrong-document', legalRow(), { ...legalInput, sanitizedHtml: sourceHtml + '<p>DRIFT</p>' }],
    ['stale-date', legalRow(), { ...legalInput, asOf: '2026-10-20' }],
    ['forged-status', {
      ...legalRow(),
      manifest: {
        ...legalRow().manifest,
        segments: [{...legalRow().manifest.segments[0]!, textSha256: checksum('not official')}],
      },
    }, legalInput],
    ['different-origin', {...legalRow(), origin_url: 'https://another.example/act'}, legalInput],
    ['untrusted-adapter', {...legalRow(), source_code: 'unknown-source'}, legalInput],
  ];
  for (const [name, row, input] of cases) {
    const result = prepareReviewedPublicLegalScopeDraft(row, input);
    assert.equal(result.status, 'UNVERIFIED', name);
    assert.equal(result.highlightsAuthorized, false, name);
    assert.deepEqual(result.currentSegments, [], name);
  }
});

test('TAX13 draft cannot accidentally assert COMPLETE when attestations cover only one cell', () => {
  const row = legalRow();
  row.manifest.coverage = 'COMPLETE';
  row.coverage = 'COMPLETE';
  const result = prepareReviewedPublicLegalScopeDraft(row, legalInput);
  assert.equal(result.status, 'UNVERIFIED');
});

test('TAX13 revocation/history-only evidence produces zero public CURRENT segments', () => {
  const row = legalRow();
  row.manifest.segments[0]!.status = 'REVOKED';
  row.manifest.segments[0]!.method = 'ORIGINAL_PUBLICATION';
  row.manifest.segments[0]!.evidenceUrls = [];
  const result = prepareReviewedPublicLegalScopeDraft(row, legalInput);
  assert.equal(result.status, 'UNVERIFIED');
  assert.deepEqual(result.currentSegments, []);
});
