/**
 * R8-01 PoC: issuer+sealer SQL access must NOT manufacture legal CURRENT.
 * Uses disposable PG16/PG18 databases and actual isolated runtime logins.
 * Demonstrates a forged Ed25519 signature accepted as an UNTRUSTED candidate,
 * but rejected by the independent verifier MAC and positive projections.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { seedTestLegalScopeAttestation } from './legal-scope-attestation.fixture.js';
import { buildLegalProofV2, canonicalLegalProofJson, signLegalProofV2,
  verifySignedLegalProofV2 } from '../src/modules/taxonomy/legal-scope/legal-proof-v2.js';
import { renderedLegalText, type LegalScopeEvidenceV1 } from '../src/modules/taxonomy/legal-scope/legal-scope-evidence.js';

const adminUrl=process.env.DATABASE_ADMIN_URL;
const issuerPassword=process.env.DB_LEGAL_ISSUER_RUNTIME_PASSWORD;
const sealerPassword=process.env.DB_NCM_SEALER_RUNTIME_PASSWORD;
const verifierPassword=process.env.DB_PROOF_VERIFIER_RUNTIME_PASSWORD;
if (!adminUrl || !issuerPassword || !sealerPassword || !verifierPassword ||
    process.env.NODE_ENV!=='test' || process.env.GITHUB_ACTIONS!=='true' ||
    !['127.0.0.1','localhost'].includes(new URL(adminUrl).hostname)) {
  throw new Error('TAX13_R8_DISPOSABLE_PG_ONLY');
}
const sha=(x:string)=>createHash('sha256').update(x,'utf8').digest('hex');
const connectAs=(user:string,pass:string)=>{
  const uri=new URL(adminUrl);
  uri.username=user;uri.password=pass;
  return new Pool({connectionString:uri.toString(),max:1});
};

test('R8 forged Ed25519 issuer+sealer SQL cannot enter verifier ledger or expose CURRENT',async()=>{
  const admin=new Pool({connectionString:adminUrl,max:2});
  const issuer=connectAs('radar_legal_issuer_runtime',issuerPassword);
  const sealer=connectAs('radar_scan_sealer_runtime',sealerPassword);
  const verifier=connectAs('radar_proof_verifier_runtime',verifierPassword);
  try {
    const html='<p class="TextoAcordo">NCM 1006.30.11</p>';
    const pub=(await admin.query<{id:string}>(
      "INSERT INTO public.publications(identity_hash,identity_strength,identity_basis,jurisdiction_level,title,published_on) VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','R8 issuer SQL PoC',CURRENT_DATE) RETURNING id",
      [sha(randomUUID())])).rows[0]!.id;
    const version=(await admin.query<{id:string}>(
      "INSERT INTO public.publication_versions(publication_id,version_no,content_hash,content_text,source_metadata,is_current) VALUES ($1::uuid,1,$2,$3,$4::jsonb,true) RETURNING id",
      [pub,sha(html),renderedLegalText(html),
        JSON.stringify({presentation:{format:'SANITIZED_HTML',html}})])).rows[0]!.id;
    const attId=await seedTestLegalScopeAttestation(admin,version,'COMPLETE',false);
    const a=(await admin.query<{
      source_id:string;official_url:string;manifest:LegalScopeEvidenceV1;
      attestor_ref:string;
    }>(
      'SELECT source_id,official_url,manifest,attestor_ref FROM public.publication_legal_scope_attestations WHERE id=$1::uuid',
      [attId])).rows[0]!;
    const raw='<div id="parent-fieldname-text">'+html+'</div>';
    const rawDigest=sha(raw);
    const artifact=(await admin.query<{id:string}>(
      "INSERT INTO public.tax13_v2_original_http_artifacts(publication_version_id,official_url,http_status,raw_http_bytes,raw_sha256,sanitized_html_sha256,collected_at,collector_identity) VALUES ($1::uuid,$2,200,convert_to($3,'UTF8'),$4,$5,statement_timestamp(),'R8-SYNTHETIC-RAW-TEST') RETURNING id",
      [version,a.official_url,raw,rawDigest,sha(html)])).rows[0]!.id;
    const keyId='r8-test-'+randomUUID();
    const key=generateKeyPairSync('ed25519');
    await admin.query(
      "INSERT INTO public.tax13_v2_authorized_keys(key_id,public_key_pem,active_from,registered_by) VALUES ($1,$2,statement_timestamp()-interval '2 minutes','CI-R8-ADVERSARIAL')",
      [keyId,key.publicKey.export({format:'pem',type:'spki'}).toString()]);
    const proof=buildLegalProofV2(a.manifest,{
      publicationVersionId:version,sourceId:a.source_id,
      officialUrl:a.official_url,sanitizedHtml:html,validAsOf:a.manifest.validAsOf,
      trustedAttestor:true,trustedEvidenceHosts:['www.confaz.fazenda.gov.br'],
    },{
      proofId:randomUUID(),attestationId:attId,
      rawArtifactSha256:rawDigest,presentationArtifactSha256:sha(html),
      parserBuildDigest:sha('r8-adversarial-parser'),
      parserVersion:'r8-parser',sanitizerVersion:'r8-sanitizer',
      legalPolicyVersion:'r8-policy',
      issuerId:'r8-issuer-sql-direct',reviewDecisionId:a.attestor_ref,
    });
    const signed=signLegalProofV2(proof,key.privateKey,keyId);
    const forgedSignature='A'.repeat(86)+'==';
    assert.equal(verifySignedLegalProofV2({
      ...signed,signatureBase64:forgedSignature,
    },createPublicKey(key.publicKey.export({format:'pem',type:'spki'})),keyId),false);

    // This is exactly the R8 static concern: issuer can store an untrusted
    // signed-looking candidate, but positive projections must remain empty.
    await issuer.query(
      'INSERT INTO public.tax13_legal_proofs_v2(id,attestation_id,publication_version_id,html_sha256,valid_as_of,recheck_on,current_fragments,current_fragments_sha256,canonical_payload,payload_sha256,signature_base64,signature_key_id,issuer_id,parser_version,sanitizer_version,policy_version) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::date,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [proof.proofId,attId,version,proof.sanitizedHtmlSha256,
        proof.validAsOf,proof.recheckOn,JSON.stringify(proof.currentFragments),
        proof.currentFragmentsSha256,canonicalLegalProofJson(proof),
        signed.payloadSha256,forgedSignature,keyId,proof.issuerId,
        proof.parserVersion,proof.sanitizerVersion,proof.legalPolicyVersion]);

    await assert.rejects(issuer.query(
      'INSERT INTO public.tax13_v2_verified_proofs(proof_id,artifact_id,payload_sha256,verifier_key_id,verifier_mac,verifier_identity) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)',
      [proof.proofId,artifact,signed.payloadSha256,'r8-fake','0'.repeat(64),'R8-FORGER']),/permission denied/);
    await assert.rejects(sealer.query(
      'INSERT INTO public.tax13_v2_verified_proofs(proof_id,artifact_id,payload_sha256,verifier_key_id,verifier_mac,verifier_identity) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)',
      [proof.proofId,artifact,signed.payloadSha256,'r8-fake','0'.repeat(64),'R8-FORGER']),/permission denied/);

    // A third runtime login is not itself a MAC oracle: missing/incorrect
    // secret and direct SQL against the ledger do not bypass the DB trigger.
    const verifierKey='r8-verifier-'+randomUUID();
    await admin.query(
      "INSERT INTO public.tax13_v2_verifier_mac_keys(key_id,key_bytes) VALUES ($1,decode($2,'hex'))",
      [verifierKey,sha(randomUUID())]);
    await assert.rejects(verifier.query(
      'INSERT INTO public.tax13_v2_verified_proofs(proof_id,artifact_id,payload_sha256,verifier_key_id,verifier_mac,verifier_identity) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)',
      [proof.proofId,artifact,signed.payloadSha256,verifierKey,'0'.repeat(64),'R8-DIRECT-SQL-VERIFIER']),/TAX13_R8_VERIFIER_MAC_INVALID/);

    const result=(await admin.query<{
      fragments:unknown;fingerprint:string|null;codes:string[];
    }>(
      'SELECT public.tax13_v2_admitted_current_fragments($1::uuid) AS fragments, public.tax13_current_ncm_scan_fingerprint($2::uuid) AS fingerprint, ARRAY(SELECT ncm_code FROM public.tax13_public_current_ncm_codes($2::uuid)) AS codes',
      [attId,version])).rows[0]!;
    assert.equal(result.fragments,null);
    assert.equal(result.fingerprint,null);
    assert.deepEqual(result.codes,[]);
  }finally{
    await Promise.all([issuer.end(),sealer.end(),verifier.end(),admin.end()]);
  }
});
