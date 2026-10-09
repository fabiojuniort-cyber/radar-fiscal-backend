import 'dotenv/config';

import { createHash, createPublicKey } from 'node:crypto';
import { Pool } from 'pg';

import { brazilLegalReferenceDate, validateLegalScopeEvidence,
  type LegalScopeEvidenceV1 } from '../../modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { OFFICIAL_EVIDENCE_HOSTS } from '../../modules/taxonomy/legal-scope/legal-scope.repository.js';
import {
  canonicalLegalProofJson, verifySignedLegalProofV2,
  type LegalProofV2Payload,
} from '../../modules/taxonomy/legal-scope/legal-proof-v2.js';
import { extractNcmCandidates } from '../../modules/taxonomy/ncm/publication-ncm.detector.js';
import { ncmTemporalFingerprint } from '../../modules/taxonomy/ncm/ncm-temporal.evidence.js';

interface SealerBundle {
  scanId: string; runFingerprint: string; publicationVersionId: string;
  detectorKey: string; detectorVersion: string; attestationId: string;
  legalAsOf: string; recheckOn: string; htmlSha256: string;
  fragmentsSha256: string; catalogEditionId: string; catalogSha256: string;
  candidateCount: number; matchCount: number;
  proofId: string; payloadCanonical: string; payloadSha256: string;
  signatureBase64: string; signatureKeyId: string; signingPublicKeyPem: string;
  legalManifest: LegalScopeEvidenceV1; sanitizedHtml: string;
  sourceId: string; officialUrl: string;
  codes: { code: string; fragmentIndex: number; catalogEntryId: string; excerpt: string }[];
}
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const input = process.argv.find((s) => s.startsWith('--scan='))?.slice(7);
if (!input || !uuid.test(input)) throw new Error('TAX13_V2_SCAN_UUID_REQUIRED');
const confirmed = process.argv.includes('--confirm');
if (confirmed && process.env.TAX13_ARCH02_SCAN_SEAL_APPROVED !== 'true') {
  throw new Error('TAX13_V2_SCAN_SEAL_NOT_APPROVED');
}
const dbUrl = process.env.DATABASE_NCM_SEALER_URL;
if (!dbUrl || new URL(dbUrl).username !== 'radar_scan_sealer_runtime') {
  throw new Error('TAX13_V2_DEDICATED_SEALER_DATABASE_REQUIRED');
}
const sealerId = process.env.TAX13_NCM_SEALER_ID;
if (!sealerId || !sealerId.trim()) throw new Error('TAX13_V2_SEALER_ID_REQUIRED');
const pool = new Pool({ connectionString: dbUrl, max: 1 });
const db = await pool.connect();
try {
  const role = await db.query<{
    current_user: string; rolsuper: boolean; rolbypassrls: boolean; member: boolean;
  }>(`
    SELECT current_user, r.rolsuper, r.rolbypassrls,
      pg_has_role(current_user,'radar_scan_sealer','MEMBER') AS member
    FROM pg_roles r WHERE r.rolname=current_user
  `);
  const auth = role.rows[0];
  if (!auth || auth.current_user !== 'radar_scan_sealer_runtime' ||
      auth.rolsuper || auth.rolbypassrls || !auth.member) {
    throw new Error('TAX13_V2_SEALER_ROLE_NOT_ISOLATED');
  }
  await db.query(confirmed ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const result = await db.query<{ bundle: SealerBundle | null }>(
    'SELECT public.tax13_v2_sealer_bundle($1::uuid) AS bundle', [input]);
  const b = result.rows[0]?.bundle;
  if (!b) throw new Error('TAX13_V2_SCAN_NOT_ELIGIBLE_FOR_SEAL');
  const payload = JSON.parse(b.payloadCanonical) as LegalProofV2Payload;
  if (canonicalLegalProofJson(payload) !== b.payloadCanonical ||
      !verifySignedLegalProofV2({
        payload, payloadSha256:b.payloadSha256,
        signatureAlgorithm:'Ed25519', signatureKeyId:b.signatureKeyId,
        signatureBase64:b.signatureBase64,
      }, createPublicKey(b.signingPublicKeyPem), b.signatureKeyId)) {
    throw new Error('TAX13_V2_SCAN_SIGNED_PROOF_INVALID');
  }
  if (payload.proofId !== b.proofId ||
      payload.attestationId !== b.attestationId ||
      payload.publicationVersionId !== b.publicationVersionId ||
      payload.sourceId !== b.sourceId ||
      payload.officialUrl !== b.officialUrl ||
      payload.sanitizedHtmlSha256 !== b.htmlSha256 ||
      payload.currentFragmentsSha256 !== b.fragmentsSha256 ||
      payload.validAsOf !== b.legalAsOf ||
      payload.recheckOn !== b.recheckOn) {
    throw new Error('TAX13_V2_SCAN_BINDING_MISMATCH');
  }
  // This is the same versioned Node validation used by the issuer, not a SQL
  // or CSS-based second interpreter. A malicious 044 CURRENT is rejected here.
  const checked = validateLegalScopeEvidence(b.legalManifest, {
    publicationVersionId:b.publicationVersionId,
    sourceId:b.sourceId, officialUrl:b.officialUrl,
    sanitizedHtml:b.sanitizedHtml, validAsOf:b.legalAsOf,
    trustedAttestor:true,
    trustedEvidenceHosts:OFFICIAL_EVIDENCE_HOSTS.confaz ?? [],
  });
  if (!checked.valid || checked.coverage !== 'COMPLETE' ||
      checked.currentSegments === 0 ||
      canonicalLegalProofJson(checked.currentFragments) !==
        canonicalLegalProofJson(payload.currentFragments)) {
    throw new Error('TAX13_V2_SCAN_NOT_NODE_LEGAL_CURRENT');
  }
  if (sha(JSON.stringify(payload.currentFragments)) !== b.fragmentsSha256) {
    throw new Error('TAX13_V2_SCAN_FRAGMENTS_HASH_MISMATCH');
  }
  const actualFingerprint = ncmTemporalFingerprint(b.publicationVersionId, {
    ...checked, attestationId:b.attestationId, asOf:b.legalAsOf,
    htmlSha256:b.htmlSha256, recheckOn:b.recheckOn,
  }, { id:b.catalogEditionId, checksum:b.catalogSha256 });
  if (actualFingerprint !== b.runFingerprint) {
    throw new Error('TAX13_V2_SCAN_FINGERPRINT_MISMATCH');
  }
  const candidates = payload.currentFragments.flatMap((fragment, fragmentIndex) =>
    extractNcmCandidates(fragment).map((hit) => ({
      code:hit.code, fragmentIndex,
    })));
  const expectedCandidateCount = new Set(candidates.map((hit) => hit.code)).size;
  const storedCodes = new Set(b.codes.map((c) => c.code));
  if (expectedCandidateCount !== b.candidateCount ||
      storedCodes.size !== b.matchCount) {
    throw new Error('TAX13_V2_SCAN_CARDINALITY_MISMATCH');
  }
  const validPairKeys = new Set(candidates.map((c) => c.fragmentIndex + ':' + c.code));
  if (b.codes.some((c) => !validPairKeys.has(c.fragmentIndex + ':' + c.code))) {
    throw new Error('TAX13_V2_SCAN_CODE_OUTSIDE_NODE_FRAGMENT');
  }
  const resultInfo = {
    scanId:b.scanId,proofId:b.proofId,
    codeCount:storedCodes.size,validAsOf:b.legalAsOf,sealerId,
    currentReferenceDay:brazilLegalReferenceDate(),
  };
  if (!confirmed) {
    await db.query('ROLLBACK');
    console.log('TAX13_V2_SEAL_DRY_RUN=' + JSON.stringify(resultInfo));
  } else {
    await db.query(`
      INSERT INTO public.tax13_ncm_seals_v2(
        scan_evidence_id,legal_proof_id,scan_fingerprint,sealer_id
      ) VALUES ($1::uuid,$2::uuid,$3,$4)
      ON CONFLICT(scan_evidence_id) DO NOTHING
    `, [b.scanId,b.proofId,b.runFingerprint,sealerId]);
    await db.query('COMMIT');
    console.log('TAX13_V2_SCAN_SEALED=' + JSON.stringify(resultInfo));
  }
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  db.release();
  await pool.end();
}
