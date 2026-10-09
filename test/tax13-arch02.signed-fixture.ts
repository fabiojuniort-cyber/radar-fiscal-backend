import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  buildLegalProofV2, canonicalLegalProofJson, signLegalProofV2,
  verifySignedLegalProofV2,
} from '../src/modules/taxonomy/legal-scope/legal-proof-v2.js';
import type { LegalScopeEvidenceV1 } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { OFFICIAL_EVIDENCE_HOSTS } from '../src/modules/taxonomy/legal-scope/legal-scope.repository.js';

/**
 * Disposable CI database ONLY. Admin bypass models a correctly authorized
 * independent issuer/sealer; it is not a production issuance workflow.
 * Production must use the isolated runtime identity and key registry.
 */
const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export async function seedTestV2LegalProof(admin: Pool, attestationId: string): Promise<string> {
  const rows = await admin.query<{
    id: string; source_id: string; source_code: string; official_url: string;
    publication_version_id: string; sanitized_html: string;
    manifest: LegalScopeEvidenceV1; attestor_ref: string;
  }>(`
    SELECT a.id,a.source_id,s.code AS source_code,a.official_url,
      a.publication_version_id,
      pv.source_metadata->'presentation'->>'html' AS sanitized_html,
      a.manifest,a.attestor_ref
    FROM public.publication_legal_scope_attestations a
    JOIN public.publication_versions pv ON pv.id=a.publication_version_id
    JOIN public.sources s ON s.id=a.source_id
    WHERE a.id=$1::uuid
  `,[attestationId]);
  const a=rows.rows[0];
  if (!a) throw new Error('TAX13_CI_ATTESTATION_MISSING');
  const hosts=OFFICIAL_EVIDENCE_HOSTS[a.source_code];
  if (!hosts) throw new Error('TAX13_CI_UNSUPPORTED_OFFICIAL_SOURCE');
  // Synthetic disposable HTTP fixture. NOT real CONFAZ network provenance.
  // The independent verifier will require actual captured HTTP bytes in
  // production; admin-only CI seeding models an already verified source.
  const sourceRaw='<div id="parent-fieldname-text">'+a.sanitized_html+'</div>';
  const rawSha=hash(sourceRaw);
  // Only one immutable original per version/URL/hash; another CI attestation
  // reuses that exact captured artifact instead of rewriting the ledger.
  await admin.query(`
    INSERT INTO public.tax13_v2_original_http_artifacts(
      publication_version_id,official_url,http_status,raw_http_bytes,
      raw_sha256,sanitized_html_sha256,collected_at,collector_identity
    ) VALUES ($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,
      statement_timestamp(),'CI-SYNTHETIC-RAW-BYTES')
    ON CONFLICT (publication_version_id,official_url,raw_sha256) DO NOTHING
  `,[a.publication_version_id,a.official_url,sourceRaw,rawSha,hash(a.sanitized_html)]);
  const artifact=await admin.query<{id:string}>(`
    SELECT id FROM public.tax13_v2_original_http_artifacts
    WHERE publication_version_id=$1::uuid
      AND official_url=$2 AND raw_sha256=$3
      AND sanitized_html_sha256=$4
  `,[a.publication_version_id,a.official_url,rawSha,hash(a.sanitized_html)]);
  if (!artifact.rows[0]?.id) throw new Error('TAX13_CI_ORIGINAL_ARTIFACT_MISSING');
  const proof=buildLegalProofV2(a.manifest,{
    publicationVersionId:a.publication_version_id,sourceId:a.source_id,
    officialUrl:a.official_url,sanitizedHtml:a.sanitized_html,
    validAsOf:a.manifest.validAsOf,trustedAttestor:true,
    trustedEvidenceHosts:hosts,
  },{
    proofId:randomUUID(),attestationId:a.id,
    rawArtifactSha256:rawSha, // synthetic CI wrapper, not real HTTP
    presentationArtifactSha256:hash(a.sanitized_html),
    parserBuildDigest:hash('CI-only-deterministic-parser-build'),
    parserVersion:'ci-node-24-htmlparser2',sanitizerVersion:'ci-sanitizer',
    legalPolicyVersion:'ci-proof-v2',
    issuerId:'ci-isolated-issuer',reviewDecisionId:a.attestor_ref,
  });
  const keys=generateKeyPairSync('ed25519');
  const keyId='tax13-ci-'+randomUUID();
  const pub=keys.publicKey.export({format:'pem',type:'spki'}).toString();
  const signed=signLegalProofV2(proof,keys.privateKey,keyId);
  if (!verifySignedLegalProofV2(signed,keys.publicKey,keyId)) {
    throw new Error('TAX13_CI_SIGNATURE_BAD');
  }
  await admin.query(`
    INSERT INTO public.tax13_v2_authorized_keys(
      key_id,public_key_pem,active_from,registered_by
    ) VALUES ($1,$2,statement_timestamp()-interval '1 minute','CI-ONLY')
  `,[keyId,pub]);
  await admin.query(`
    INSERT INTO public.tax13_legal_proofs_v2 (
      id,attestation_id,publication_version_id,html_sha256,valid_as_of,
      recheck_on,current_fragments,current_fragments_sha256,
      canonical_payload,payload_sha256,signature_base64,signature_key_id,
      issuer_id,parser_version,sanitizer_version,policy_version
    ) VALUES (
      $1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7::jsonb,$8,
      $9,$10,$11,$12,$13,$14,$15,$16
    )
  `,[
    proof.proofId,proof.attestationId,proof.publicationVersionId,
    proof.sanitizedHtmlSha256,proof.validAsOf,proof.recheckOn,
    JSON.stringify(proof.currentFragments),proof.currentFragmentsSha256,
    canonicalLegalProofJson(proof),signed.payloadSha256,signed.signatureBase64,
    signed.signatureKeyId,proof.issuerId,proof.parserVersion,
    proof.sanitizerVersion,proof.legalPolicyVersion,
  ]);
  const verifierSecret=randomBytes(32);
  const verifierKeyId='CI-VERIFIER-'+randomUUID();
  await admin.query(`
    INSERT INTO public.tax13_v2_verifier_mac_keys(key_id,key_bytes)
    VALUES ($1,$2::bytea)
  `,[verifierKeyId,verifierSecret]);
  const macMaterial='TRIBUSCA:TAX13:R8:PROOF_VERIFIED:1\n'+
    proof.proofId+':'+signed.payloadSha256+':'+signed.signatureBase64+':'+rawSha;
  const mac=createHmac('sha256',verifierSecret).update(macMaterial,'utf8').digest('hex');
  await admin.query(`
    INSERT INTO public.tax13_v2_verified_proofs(
      proof_id,artifact_id,payload_sha256,verifier_key_id,verifier_mac,verifier_identity
    ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,'CI-SYNTHETIC-TEST-VERIFIER')
  `,[proof.proofId,artifact.rows[0]!.id,signed.payloadSha256,verifierKeyId,mac]);
  return proof.proofId;
}

export async function seedTestV2NcmSeals(
  admin: Pool, publicationVersionId: string, asOf: string,
): Promise<void> {
  await admin.query(`
    INSERT INTO public.tax13_ncm_seals_v2(
      scan_evidence_id,legal_proof_id,scan_fingerprint,sealer_id)
    SELECT scan.id,proof.id,scan.run_fingerprint,'CI-ONLY-TEST-SEALER'
    FROM public.publication_ncm_scan_evidence scan
    JOIN public.tax13_legal_proofs_v2 proof
      ON proof.attestation_id=scan.legal_scope_attestation_id
     AND proof.publication_version_id=scan.publication_version_id
     AND proof.current_fragments_sha256=scan.current_fragments_sha256
    WHERE scan.publication_version_id=$1::uuid AND scan.legal_as_of=$2::date
      AND public.tax13_ncm_scan_consistent(scan.id)
      AND NOT EXISTS (SELECT 1 FROM public.tax13_ncm_seals_v2 prior
        WHERE prior.scan_evidence_id=scan.id)
    ON CONFLICT(scan_evidence_id) DO NOTHING
  `,[publicationVersionId,asOf]);
}
