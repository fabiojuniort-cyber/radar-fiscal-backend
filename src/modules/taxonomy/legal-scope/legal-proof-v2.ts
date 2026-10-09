import { createHash, sign, verify, type KeyObject } from 'node:crypto';

import {
  validateLegalScopeEvidence,
  type LegalScopeEvidenceV1,
  type LegalScopeValidationContext,
} from './legal-scope-evidence.js';

/**
 * TAX13-ARCH-02: one legal semantics authority (the versioned Node parser).
 * This is an immutable emission artifact, NOT a grant for worker/app to assert
 * CURRENT. Only an isolated legal issuer may admit its signed contents.
 *
 * JSON canonicalization here is a narrowly defined, string/boolean/integer/
 * array/object contract. It is deliberately NOT advertised as full RFC 8785.
 */
export const LEGAL_PROOF_V2_DOMAIN = 'TRIBUSCA:TAX13:LEGAL_PROOF_V2\u0000';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalLegalProofJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalLegalProofJson).join(',') + ']';
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('TAX13_PROOF_NON_CANONICAL_VALUE');
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0);
  if (entries.some(([, val]) => val === undefined)) throw new Error('TAX13_PROOF_UNDEFINED_FIELD');
  return '{' + entries.map(([key, val]) =>
    JSON.stringify(key) + ':' + canonicalLegalProofJson(val)).join(',') + '}';
}

export interface LegalProofV2Payload {
  contract: 'TRIBUSCA_TAX13_LEGAL_PROOF_V2';
  proofId: string;
  attestationId: string;
  publicationVersionId: string;
  sourceId: string;
  officialUrl: string;
  rawArtifactSha256: string;
  presentationArtifactSha256: string;
  sanitizedHtmlSha256: string;
  parserBuildDigest: string;
  parserVersion: string;
  sanitizerVersion: string;
  legalPolicyVersion: string;
  offsetUnit: 'UTF16_CODE_UNITS';
  validAsOf: string;
  verifiedAt: string;
  recheckOn: string;
  coverage: 'COMPLETE';
  currentFragments: string[];
  currentFragmentsSha256: string;
  segmentManifestSha256: string;
  segments: LegalScopeEvidenceV1['segments'];
  issuerId: string;
  reviewDecisionId: string;
}

export interface SignedLegalProofV2 {
  payload: LegalProofV2Payload;
  payloadSha256: string;
  signatureAlgorithm: 'Ed25519';
  signatureKeyId: string;
  signatureBase64: string;
}

export function buildLegalProofV2(
  evidence: LegalScopeEvidenceV1,
  context: LegalScopeValidationContext,
  meta: {
    proofId: string;
    attestationId: string;
    rawArtifactSha256: string;
    presentationArtifactSha256: string;
    parserBuildDigest: string;
    parserVersion: string;
    sanitizerVersion: string;
    legalPolicyVersion: string;
    issuerId: string;
    reviewDecisionId: string;
  },
): LegalProofV2Payload {
  const validation = validateLegalScopeEvidence(evidence, context);
  if (!validation.valid || validation.coverage !== 'COMPLETE' || validation.currentSegments === 0) {
    throw new Error('TAX13_V2_COMPLETE_CURRENT_PROOF_REQUIRED:' + (validation.reason ?? validation.coverage));
  }
  if (!context.trustedAttestor) throw new Error('TAX13_V2_UNTRUSTED_ISSUER');
  if (!uuid.test(meta.proofId) || !uuid.test(meta.attestationId)) {
    throw new Error('TAX13_V2_PROOF_IDENTITY_REQUIRED');
  }
  for (const key of ['rawArtifactSha256', 'presentationArtifactSha256', 'parserBuildDigest'] as const) {
    if (!digest.test(meta[key])) throw new Error('TAX13_V2_INVALID_' + key);
  }
  for (const key of ['parserVersion', 'sanitizerVersion', 'legalPolicyVersion', 'issuerId', 'reviewDecisionId'] as const) {
    if (!meta[key].trim() || meta[key].length > 256) throw new Error('TAX13_V2_INVALID_' + key);
  }
  return {
    contract: 'TRIBUSCA_TAX13_LEGAL_PROOF_V2',
    proofId: meta.proofId,
    attestationId: meta.attestationId,
    publicationVersionId: evidence.publicationVersionId,
    sourceId: evidence.sourceId,
    officialUrl: evidence.officialUrl,
    rawArtifactSha256: meta.rawArtifactSha256,
    presentationArtifactSha256: meta.presentationArtifactSha256,
    sanitizedHtmlSha256: evidence.htmlSha256,
    parserBuildDigest: meta.parserBuildDigest,
    parserVersion: meta.parserVersion,
    sanitizerVersion: meta.sanitizerVersion,
    legalPolicyVersion: meta.legalPolicyVersion,
    offsetUnit: 'UTF16_CODE_UNITS',
    validAsOf: evidence.validAsOf,
    verifiedAt: evidence.verifiedAt,
    recheckOn: evidence.recheckOn,
    coverage: 'COMPLETE',
    currentFragments: [...validation.currentFragments],
    currentFragmentsSha256: sha(canonicalLegalProofJson(validation.currentFragments)),
    segmentManifestSha256: sha(canonicalLegalProofJson(evidence.segments)),
    segments: evidence.segments.map((segment) => ({
      ...segment,
      evidenceUrls: [...segment.evidenceUrls],
      ...(segment.supportingActs ? { supportingActs: [...segment.supportingActs] } : {}),
    })),
    issuerId: meta.issuerId,
    reviewDecisionId: meta.reviewDecisionId,
  };
}

function signedBytes(payload: LegalProofV2Payload): Buffer {
  return Buffer.from(LEGAL_PROOF_V2_DOMAIN + canonicalLegalProofJson(payload), 'utf8');
}

export function signLegalProofV2(
  payload: LegalProofV2Payload,
  privateKey: KeyObject,
  signatureKeyId: string,
): SignedLegalProofV2 {
  if (!signatureKeyId.trim() || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('TAX13_V2_INVALID_SIGNING_KEY');
  }
  const bytes = signedBytes(payload);
  return {
    payload,
    payloadSha256: createHash('sha256').update(bytes).digest('hex'),
    signatureAlgorithm: 'Ed25519',
    signatureKeyId,
    signatureBase64: sign(null, bytes, privateKey).toString('base64'),
  };
}

export function verifySignedLegalProofV2(
  proof: SignedLegalProofV2,
  publicKey: KeyObject,
  trustedKeyId: string,
): boolean {
  try {
    if (proof?.payload?.contract !== 'TRIBUSCA_TAX13_LEGAL_PROOF_V2' ||
        proof.signatureAlgorithm !== 'Ed25519' ||
        proof.signatureKeyId !== trustedKeyId ||
        publicKey.asymmetricKeyType !== 'ed25519' ||
        !digest.test(proof.payloadSha256) ||
        !/^[A-Za-z0-9+/]{86}==?$/.test(proof.signatureBase64)) return false;
    const bytes = signedBytes(proof.payload);
    const expected = createHash('sha256').update(bytes).digest('hex');
    return expected === proof.payloadSha256 &&
      verify(null, bytes, publicKey, Buffer.from(proof.signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
