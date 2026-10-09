import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';

import { renderedLegalText, type LegalScopeEvidenceV1 } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import {
  buildLegalProofV2, canonicalLegalProofJson, signLegalProofV2, verifySignedLegalProofV2,
} from '../src/modules/taxonomy/legal-scope/legal-proof-v2.js';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const officialUrl = 'https://www.confaz.fazenda.gov.br/test-only/legal-v2';
const html = '<p class="TextoAcordo">NCM 10062099</p>';
const text = renderedLegalText(html);
const versionId = randomUUID();
const sourceId = randomUUID();
const manifest: LegalScopeEvidenceV1 = {
  version: 1, publicationVersionId: versionId, sourceId, officialUrl,
  htmlSha256: hash(html),
  validAsOf: '2026-10-08', verifiedAt: '2026-10-08T08:00:00.000Z',
  recheckOn: '2026-10-10', coverage: 'COMPLETE',
  segments: [{
    start: 0, end: text.length, textSha256: hash(text),
    status: 'CURRENT', method: 'OFFICIAL_AMENDMENT', evidenceUrls: [officialUrl],
  }],
};
const ctx = {
  publicationVersionId: versionId, sourceId, officialUrl, sanitizedHtml: html,
  validAsOf: '2026-10-08', trustedAttestor: true,
  trustedEvidenceHosts: ['www.confaz.fazenda.gov.br'],
};
const meta = {
  proofId: randomUUID(), attestationId: randomUUID(),
  rawArtifactSha256: hash('official-source-bytes'),
  presentationArtifactSha256: hash(html),
  parserBuildDigest: hash('audited-parser-build'),
  parserVersion: 'tax13-dom-v1', sanitizerVersion: 'tax13-sanitizer-v1',
  legalPolicyVersion: 'tax13-legal-v2', issuerId: 'reviewed-confaz-adapter',
  reviewDecisionId: 'human-review-test-only',
};

test('TAX13 V2 canonicalization is stable across object insertion order and preserves fragments', () => {
  assert.equal(canonicalLegalProofJson({ b: 'á', a: [1, '😀'] }),
    canonicalLegalProofJson({ a: [1, '😀'], b: 'á' }));
  assert.throws(() => canonicalLegalProofJson({ invalid: undefined }), /UNDEFINED_FIELD/);
  assert.throws(() => canonicalLegalProofJson({ invalid: 0.5 }), /NON_CANONICAL_VALUE/);
  const payload = buildLegalProofV2(manifest, ctx, meta);
  assert.deepEqual(payload.currentFragments, ['NCM 10062099']);
  assert.equal(payload.offsetUnit, 'UTF16_CODE_UNITS');
});

test('TAX13 V2 signature binds content, parser, scope and issuer to a trusted signing key', () => {
  const keys = generateKeyPairSync('ed25519');
  const another = generateKeyPairSync('ed25519');
  const payload = buildLegalProofV2(manifest, ctx, meta);
  const signed = signLegalProofV2(payload, keys.privateKey, 'tax13-test-k1');
  assert.equal(verifySignedLegalProofV2(signed, keys.publicKey, 'tax13-test-k1'), true);
  assert.equal(verifySignedLegalProofV2(signed, another.publicKey, 'tax13-test-k1'), false);
  assert.equal(verifySignedLegalProofV2(signed, keys.publicKey, 'revoked-k1'), false);
  assert.equal(verifySignedLegalProofV2({
    ...signed, payload: { ...payload, currentFragments: ['NCM 10063011'] },
  }, keys.publicKey, 'tax13-test-k1'), false);
  assert.equal(verifySignedLegalProofV2({
    ...signed, payload: { ...payload, parserVersion: 'unapproved-parser' },
  }, keys.publicKey, 'tax13-test-k1'), false);
});

test('TAX13 V2 never signs CURRENT for normative-excluded, PARTIAL or untrusted content', () => {
  assert.throws(() => buildLegalProofV2({
    ...manifest, coverage: 'PARTIAL',
  }, ctx, meta), /COMPLETE_CURRENT_PROOF_REQUIRED/);
  assert.throws(() => buildLegalProofV2(manifest, {
    ...ctx, trustedAttestor: false,
  }, meta), /COMPLETE_CURRENT_PROOF_REQUIRED/);
  const headingHtml = '<p class="TextoAcordo">Convênio ICMS 10062099</p>';
  const heading = renderedLegalText(headingHtml);
  assert.throws(() => buildLegalProofV2({
    ...manifest, htmlSha256: hash(headingHtml),
    segments: [{ ...manifest.segments[0]!, end: heading.length, textSha256: hash(heading) }],
  }, { ...ctx, sanitizedHtml: headingHtml }, meta), /CURRENT_IN_NON_NORMATIVE_SCOPE/);
});
