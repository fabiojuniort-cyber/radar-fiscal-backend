import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  brazilLegalReferenceDate,
  renderedLegalText,
  validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
  type LegalScopeValidationContext,
} from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';

import { verifyPersistedLegalScopeRow, type AttestationRow } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const html = '<p>ANEXO II</p><table><tr><td>8701.90.00 revogado</td>' +
  '<td>7307.19.20 vigente</td></tr></table>';
const text = renderedLegalText(html);
const current = '7307.19.20 vigente';
const start = text.indexOf(current);
const ctx: LegalScopeValidationContext = {
  publicationVersionId: '00000000-0000-4000-8000-000000000001',
  sourceId: 'registered-confaz-id',
  officialUrl: 'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91',
  sanitizedHtml: html,
  validAsOf: '2026-10-08',
  trustedAttestor: true,
  trustedEvidenceHosts: ['www.confaz.fazenda.gov.br'],
};
const manifest = (): LegalScopeEvidenceV1 => ({
  version: 1,
  publicationVersionId: ctx.publicationVersionId,
  sourceId: ctx.sourceId,
  officialUrl: ctx.officialUrl,
  htmlSha256: digest(html),
  validAsOf: ctx.validAsOf,
  verifiedAt: new Date(Date.now() - 86_400_000).toISOString(),
  recheckOn: '2026-10-20',
  coverage: 'PARTIAL',
  segments: [{
    start, end: start + current.length,
    textSha256: digest(current),
    status: 'CURRENT',
    method: 'OFFICIAL_CONSOLIDATION',
    evidenceUrls: ['https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91'],
    supportingActs: ['CONVÊNIO ICMS 52/91'],
  }],
});

test('TAX13 B4 accepts only the attested cell and excludes older sibling', () => {
  assert.ok(start > 0);
  assert.equal(text.slice(start, start + current.length), current);
  const r = validateLegalScopeEvidence(manifest(), ctx);
  assert.equal(r.valid, true);
  assert.equal(r.currentText, current);
  assert.equal(r.coverage, 'PARTIAL');
  assert.equal(r.currentSegments, 1);
  assert.doesNotMatch(r.currentText, /8701\.90\.00|ANEXO II/);
});

test('TAX13 B4 refuses forged status in source HTML without internal attestation', () => {
  const forged = html.replace('<td>7307', '<td data-legal-status="current">7307');
  const untrusted = validateLegalScopeEvidence(manifest(), { ...ctx, sanitizedHtml: forged, trustedAttestor: false });
  assert.deepEqual({valid:untrusted.valid, reason:untrusted.reason}, {valid:false,reason:'UNTRUSTED_ATTESTOR'});
  const drifted = validateLegalScopeEvidence(manifest(), { ...ctx, sanitizedHtml: forged });
  assert.equal(drifted.reason, 'HTML_HASH_MISMATCH');
  assert.equal(drifted.currentText, '');
});

test('TAX13 B4 rejects a scope from a different publication/version/source or date', () => {
  const mismatches = [
    [ctx.publicationVersionId + '-other', 'WRONG_PUBLICATION_OR_SOURCE', 'publicationVersionId'],
    ['different-source', 'WRONG_PUBLICATION_OR_SOURCE', 'sourceId'],
    ['2026-10-09', 'REFERENCE_DATE_MISMATCH', 'validAsOf'],
  ] as const;
  for (const [value, reason, key] of mismatches) {
    const actual = validateLegalScopeEvidence(manifest(), { ...ctx, [key]: value });
    assert.equal(actual.reason, reason);
  }
  const unregistered = validateLegalScopeEvidence(manifest(), { ...ctx, trustedEvidenceHosts: [] });
  assert.equal(unregistered.reason, 'SOURCE_NOT_REGISTERED');
});

test('TAX13 B4 rejects expired, undated and untrusted legal evidence', () => {
  assert.equal(validateLegalScopeEvidence({...manifest(), recheckOn:'2026-10-08'},ctx).reason, 'EVIDENCE_EXPIRED');
  assert.equal(validateLegalScopeEvidence({...manifest(), validAsOf:'2026-02-30'},ctx).reason,'REFERENCE_DATE_MISMATCH');
  assert.equal(validateLegalScopeEvidence({...manifest(), officialUrl:'https://example.invalid/act'},ctx).reason,'SOURCE_URL_MISMATCH');
  const badUrl=manifest();
  badUrl.segments[0]!.evidenceUrls=['https://attacker.example/act'];
  assert.equal(validateLegalScopeEvidence(badUrl,ctx).reason,'UNTRUSTED_EVIDENCE_URL');
  const original=manifest();
  original.segments[0]!.method='ORIGINAL_PUBLICATION';
  assert.equal(validateLegalScopeEvidence(original,ctx).reason,'CURRENT_WITHOUT_OFFICIAL_PROOF');
});

test('TAX13 B4 refuses changed fragment, gaps with overlapping attestations, and missing proof', () => {
  const tamper=manifest();
  tamper.segments[0]!.textSha256=digest('pretended current');
  assert.equal(validateLegalScopeEvidence(tamper,ctx).reason,'FRAGMENT_HASH_MISMATCH');
  const overlapping=manifest();
  overlapping.segments.push({...overlapping.segments[0]!});
  assert.equal(validateLegalScopeEvidence(overlapping,ctx).reason,'INVALID_SEGMENT_BOUNDS');
  const noUrl=manifest();
  noUrl.segments[0]!.evidenceUrls=[];
  assert.equal(validateLegalScopeEvidence(noUrl,ctx).reason,'CURRENT_WITHOUT_OFFICIAL_PROOF');
  const noManifest=validateLegalScopeEvidence(null,ctx);
  assert.equal(noManifest.reason,'EVIDENCE_MISSING');
  assert.equal(noManifest.currentText,'');
});

test('TAX13 B4 allows recorded UNVERIFIED fragment but never promotes it to current', () => {
  const uncertain=manifest();
  uncertain.segments[0]!.status='UNVERIFIED';
  uncertain.segments[0]!.method='ORIGINAL_PUBLICATION';
  uncertain.segments[0]!.evidenceUrls=[];
  const result=validateLegalScopeEvidence(uncertain,ctx);
  assert.equal(result.valid,true);
  assert.equal(result.currentText,'');
  assert.equal(result.currentSegments,0);
});

test('TAX13 B4 fails closed on malformed persisted evidence JSON', () => {
  const invalid = manifest() as unknown as { segments: unknown };
  invalid.segments = null;
  assert.equal(validateLegalScopeEvidence(invalid as unknown as LegalScopeEvidenceV1, ctx).reason, 'INVALID_SEGMENTS');
  invalid.segments = [null];
  assert.equal(validateLegalScopeEvidence(invalid as unknown as LegalScopeEvidenceV1, ctx).reason, 'INVALID_SEGMENT');
});

test('TAX13 B4 verified ledger row is the only trusted source of active fragment', () => {
  const valid=manifest();
  const row: AttestationRow = {
    id:'00000000-0000-4000-8000-000000000002',
    manifest:valid,
    source_id:ctx.sourceId,
    source_code:'confaz',
    official_url:ctx.officialUrl,
    origin_url:ctx.officialUrl,
    html_sha256:valid.htmlSha256,
    valid_as_of:valid.validAsOf,
    recheck_on:valid.recheckOn,
    verified_at:new Date(valid.verifiedAt),
    coverage:valid.coverage,
    attestor_kind:'HUMAN_REVIEW',
  };
  const input={publicationVersionId:ctx.publicationVersionId,sanitizedHtml:html,asOf:ctx.validAsOf};
  const result=verifyPersistedLegalScopeRow(row,input);
  assert.equal(result.valid,true);
  assert.equal(result.currentText,current);
  assert.equal(result.attestationId,row.id);
  assert.equal(verifyPersistedLegalScopeRow(undefined,input).reason,'ATTESTATION_MISSING');
  assert.equal(verifyPersistedLegalScopeRow({...row,source_code:'unknown-source'},input).reason,'SOURCE_ADAPTER_NOT_ATTESTED');
  assert.equal(verifyPersistedLegalScopeRow({...row,html_sha256:digest('other')},input).reason,'ATTESTATION_RECORD_MISMATCH');
  assert.equal(verifyPersistedLegalScopeRow({...row,origin_url:'https://attacker.example'},input).reason,'ATTESTATION_RECORD_MISMATCH');
  assert.equal(verifyPersistedLegalScopeRow({...row,attestor_kind:'REMOTE_METADATA'},input).reason,'ATTESTATION_RECORD_MISMATCH');
});

test('TAX13 B4 normative date is Brazil-local at UTC midnight boundary', () => {
  assert.equal(brazilLegalReferenceDate(new Date('2026-10-08T01:59:59.000Z')), '2026-10-07');
  assert.equal(brazilLegalReferenceDate(new Date('2026-10-08T03:00:00.000Z')), '2026-10-08');
});
