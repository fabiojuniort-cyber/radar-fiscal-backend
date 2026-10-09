import 'dotenv/config';

import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  buildLegalProofV2, canonicalLegalProofJson,
  signLegalProofV2, verifySignedLegalProofV2,
} from '../../modules/taxonomy/legal-scope/legal-proof-v2.js';
import type { LegalScopeEvidenceV1 } from '../../modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { OFFICIAL_EVIDENCE_HOSTS } from '../../modules/taxonomy/legal-scope/legal-scope.repository.js';

/**
 * TAX13-ARCH-02: dedicated legal issuer, NOT a worker CLI.
 * Dry-run by default, never uses DATABASE_ADMIN_URL/DATABASE_URL.
 *
 * Required options:
 *   --attestation=<uuid> --raw-artifact-sha=<source-byte-sha256>
 * Confirmation is disabled unless TAX13_ARCH02_ISSUANCE_APPROVED=true.
 * Source original digest must come from a separately audited raw artifact;
 * absence or uncertainty fails closed. No CSS is legal validity evidence.
 */
const arg = (key: string): string | undefined =>
  process.argv.find((item) => item.startsWith('--' + key + '='))?.slice(key.length + 3);
const required = (key: string): string => {
  const value = arg(key);
  if (!value) throw new Error('TAX13_V2_REQUIRED_' + key.toUpperCase());
  return value;
};
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hex64 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attestationId = required('attestation');
const rawDigest = required('raw-artifact-sha');
if (!uuid.test(attestationId) || !hex64.test(rawDigest)) throw new Error('TAX13_V2_INVALID_ARTIFACT_IDENTITY');
const confirm = process.argv.includes('--confirm');
if (confirm && process.env.TAX13_ARCH02_ISSUANCE_APPROVED !== 'true') {
  throw new Error('TAX13_V2_ISSUANCE_NOT_APPROVED');
}
const issuerUrl = process.env.DATABASE_LEGAL_ISSUER_URL;
if (!issuerUrl || new URL(issuerUrl).username !== 'radar_legal_issuer_runtime') {
  throw new Error('TAX13_V2_DEDICATED_ISSUER_DATABASE_REQUIRED');
}
const issuerId = process.env.TAX13_LEGAL_ISSUER_ID;
const keyId = process.env.TAX13_LEGAL_SIGNING_KEY_ID;
const buildDigest = process.env.TAX13_LEGAL_PARSER_BUILD_SHA;
const parserVersion = process.env.TAX13_LEGAL_PARSER_VERSION;
const sanitizerVersion = process.env.TAX13_LEGAL_SANITIZER_VERSION;
const policyVersion = process.env.TAX13_LEGAL_POLICY_VERSION;
if (!issuerId || !keyId || !buildDigest || !parserVersion || !sanitizerVersion || !policyVersion) {
  throw new Error('TAX13_V2_VERSIONED_ISSUER_CONFIGURATION_REQUIRED');
}
const pool = new Pool({ connectionString: issuerUrl, max: 1 });
const db = await pool.connect();
try {
  const auth = await db.query<{
    current_user: string; rolsuper: boolean; rolbypassrls: boolean; member: boolean;
  }>(`
    SELECT current_user, r.rolsuper, r.rolbypassrls,
     pg_has_role(current_user,'radar_legal_issuer','MEMBER') AS member
    FROM pg_roles r WHERE r.rolname=current_user
  `);
  const role = auth.rows[0];
  if (!role || role.current_user !== 'radar_legal_issuer_runtime' ||
      role.rolsuper || role.rolbypassrls || !role.member) {
    throw new Error('TAX13_V2_ISSUER_ROLE_NOT_ISOLATED');
  }
  await db.query(confirm ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
    : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const data = await db.query<{
    attestation_id: string;
    publication_version_id: string;
    source_id: string;
    official_url: string;
    sanitized_html: string;
    manifest: LegalScopeEvidenceV1;
    attestor_ref: string;
    attestor_kind: string;
  }>(`
    SELECT * FROM public.tax13_v2_issuer_input($1::uuid)
  `, [attestationId]);
  const row = data.rows[0];
  if (!row) throw new Error('TAX13_V2_OFFICIAL_ATTESTATION_NOT_ELIGIBLE');
  const original = await db.query<{ok:boolean}>(`
    SELECT public.tax13_v2_original_exists_for_issuer(
      $1::uuid,$2::text) AS ok
  `, [attestationId,rawDigest]);
  if (!original.rows[0]?.ok) {
    throw new Error('TAX13_R8_ORIGINAL_HTTP_NOT_REGISTERED_OR_HASH_MISMATCH');
  }
  const host = new URL(row.official_url).hostname.toLowerCase();
  const hosts = OFFICIAL_EVIDENCE_HOSTS.confaz;
  if (!hosts || !hosts.includes(host) || !row.attestor_ref) {
    throw new Error('TAX13_V2_UNTRUSTED_OFFICIAL_REVIEW');
  }
  const proof = buildLegalProofV2(row.manifest, {
    publicationVersionId: row.publication_version_id,
    sourceId: row.source_id,
    officialUrl: row.official_url,
    sanitizedHtml: row.sanitized_html,
    validAsOf: row.manifest.validAsOf,
    trustedAttestor: true, trustedEvidenceHosts: hosts,
  }, {
    proofId: randomUUID(), attestationId: row.attestation_id,
    rawArtifactSha256: rawDigest,
    presentationArtifactSha256: sha(row.sanitized_html),
    parserBuildDigest: buildDigest,
    parserVersion, sanitizerVersion, legalPolicyVersion: policyVersion,
    issuerId, reviewDecisionId: row.attestor_ref,
  });
  const key = await db.query<{ public_key_pem: string | null }>(`
    SELECT public.tax13_v2_issuer_key($1) AS public_key_pem
  `, [keyId]);
  if (!key.rows[0]?.public_key_pem) throw new Error('TAX13_V2_SIGNER_NOT_REGISTERED_OR_REVOKED');
  if (confirm) {
    const privatePem = process.env.TAX13_LEGAL_ED25519_PRIVATE_KEY_PEM;
    if (!privatePem) throw new Error('TAX13_V2_PRIVATE_KEY_UNAVAILABLE');
    const signed = signLegalProofV2(proof, createPrivateKey(privatePem), keyId);
    if (!verifySignedLegalProofV2(signed,
      createPublicKey(key.rows[0].public_key_pem), keyId)) {
      throw new Error('TAX13_V2_SIGNATURE_VERIFICATION_FAILED');
    }
    await db.query(`
      INSERT INTO public.tax13_legal_proofs_v2 (
        id, attestation_id, publication_version_id, html_sha256,
        valid_as_of, recheck_on, current_fragments, current_fragments_sha256,
        canonical_payload, payload_sha256, signature_base64,
        signature_key_id,issuer_id,parser_version,sanitizer_version,policy_version
      ) VALUES (
        $1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7::jsonb,$8,
        $9,$10,$11,$12,$13,$14,$15,$16
      )
    `, [
      proof.proofId, proof.attestationId, proof.publicationVersionId,
      proof.sanitizedHtmlSha256, proof.validAsOf, proof.recheckOn,
      JSON.stringify(proof.currentFragments), proof.currentFragmentsSha256,
      canonicalLegalProofJson(proof), signed.payloadSha256, signed.signatureBase64,
      signed.signatureKeyId, proof.issuerId, proof.parserVersion,
      proof.sanitizerVersion, proof.legalPolicyVersion,
    ]);
    await db.query('COMMIT');
    console.log('TAX13_V2_ISSUED=' + JSON.stringify({
      proofId:proof.proofId,attestationId,issuerId,
      payloadSha256:signed.payloadSha256, keyId,
    }));
  } else {
    await db.query('ROLLBACK');
    console.log('TAX13_V2_DRY_RUN=' + JSON.stringify({
      attestationId,issuerId,sourceId:row.source_id,
      currentFragments:proof.currentFragments.length,
      parserVersion,policyVersion,
    }));
  }
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  db.release();
  await pool.end();
}
