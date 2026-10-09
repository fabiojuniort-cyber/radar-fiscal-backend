/**
 * TAX13-R8: independent Ed25519 + original HTTP verifier.
 * DB only recognizes CURRENT when this isolated service authenticates the
 * signature and source bytes using a third-party MAC the issuer/sealer lack.
 * This service never holds signing keys or application credentials.
 */
import 'dotenv/config';
import { createHash, createHmac, createPublicKey } from 'node:crypto';
import { Pool } from 'pg';
import { extractActBodyHtml } from '../../modules/collection/confaz.connector.js';
import { sanitizeLegalPresentationHtml } from '../../modules/collection/legal-presentation.js';
import { validateLegalScopeEvidence, type LegalScopeEvidenceV1 } from '../../modules/taxonomy/legal-scope/legal-scope-evidence.js';
import { OFFICIAL_EVIDENCE_HOSTS } from '../../modules/taxonomy/legal-scope/legal-scope.repository.js';
import { canonicalLegalProofJson, verifySignedLegalProofV2, type LegalProofV2Payload } from '../../modules/taxonomy/legal-scope/legal-proof-v2.js';

interface VerifyBundle {
  proofId:string; attestationId:string; publicationVersionId:string;
  canonicalPayload:string; payloadSha256:string; signatureBase64:string;
  signatureKeyId:string; publicKeyPem:string; rawArtifactId:string;
  rawBase64:string; rawSha256:string; officialUrl:string; sanitizedHtml:string;
  manifest:LegalScopeEvidenceV1; sourceId:string;
  attestorKind:string; attestorRef:string;
}
const hex64=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const proofId=process.argv.find(v=>v.startsWith('--proof='))?.slice(8);
if (!proofId || !uuid.test(proofId)) throw new Error('TAX13_R8_PROOF_UUID_REQUIRED');
const confirmed=process.argv.includes('--confirm');
if (confirmed && process.env.TAX13_R8_PROOF_VERIFICATION_APPROVED!=='true')
  throw new Error('TAX13_R8_VERIFICATION_NOT_APPROVED');
const dbUrl=process.env.DATABASE_PROOF_VERIFIER_URL;
if (!dbUrl || new URL(dbUrl).username!=='radar_proof_verifier_runtime')
  throw new Error('TAX13_R8_DEDICATED_VERIFIER_DATABASE_REQUIRED');
const macSecret=process.env.TAX13_R8_VERIFIER_MAC_KEY_HEX;
const macKeyId=process.env.TAX13_R8_VERIFIER_MAC_KEY_ID;
const verifierId=process.env.TAX13_R8_VERIFIER_ID;
const build=process.env.TAX13_LEGAL_PARSER_BUILD_SHA;
const parser=process.env.TAX13_LEGAL_PARSER_VERSION;
const sanitizer=process.env.TAX13_LEGAL_SANITIZER_VERSION;
const policy=process.env.TAX13_LEGAL_POLICY_VERSION;
if (!hex64.test(macSecret??'') || !macKeyId || !verifierId ||
    verifierId.length<5 || !hex64.test(build??'') || !parser || !sanitizer || !policy)
  throw new Error('TAX13_R8_INDEPENDENT_VERIFIER_CONFIGURATION_REQUIRED');
const pool=new Pool({connectionString:dbUrl,max:1});
const db=await pool.connect();
try {
  const role=await db.query<{who:string;member:boolean;rolsuper:boolean;rolbypassrls:boolean}>(
    "SELECT current_user AS who, pg_has_role(current_user,'radar_proof_verifier','MEMBER') AS member, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user");
  const who=role.rows[0];
  if (who?.who!=='radar_proof_verifier_runtime' || !who.member || who.rolsuper || who.rolbypassrls)
    throw new Error('TAX13_R8_VERIFIER_ROLE_NOT_ISOLATED');
  await db.query(confirmed?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const answer=await db.query<{bundle:VerifyBundle|null}>(
    'SELECT public.tax13_v2_verifier_bundle($1::uuid) AS bundle',[proofId]);
  const b=answer.rows[0]?.bundle;
  if (!b) throw new Error('TAX13_R8_RAW_HTTP_OR_SIGNATURE_PROOF_MISSING');
  const proof=JSON.parse(b.canonicalPayload) as LegalProofV2Payload;
  if (canonicalLegalProofJson(proof)!==b.canonicalPayload ||
      !verifySignedLegalProofV2({
        payload:proof,payloadSha256:b.payloadSha256,
        signatureAlgorithm:'Ed25519',signatureKeyId:b.signatureKeyId,
        signatureBase64:b.signatureBase64,
      },createPublicKey(b.publicKeyPem),b.signatureKeyId))
    throw new Error('TAX13_R8_ED25519_INVALID');
  const raw=Buffer.from(b.rawBase64,'base64');
  if (sha(raw)!==b.rawSha256 || sha(raw)!==proof.rawArtifactSha256)
    throw new Error('TAX13_R8_RAW_BYTES_SHA_MISMATCH');
  const html=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  const body=extractActBodyHtml(html);
  if (!body) throw new Error('TAX13_R8_ORIGINAL_HTTP_BODY_NOT_SUPPORTED');
  const normalized=sanitizeLegalPresentationHtml(body);
  if (!normalized || normalized!==b.sanitizedHtml ||
      sha(normalized)!==proof.sanitizedHtmlSha256 ||
      sha(normalized)!==proof.presentationArtifactSha256)
    throw new Error('TAX13_R8_ORIGINAL_TO_PRESENTATION_MISMATCH');
  if (!(OFFICIAL_EVIDENCE_HOSTS.confaz??[]).includes(new URL(b.officialUrl).hostname) ||
      b.attestorKind!=='HUMAN_REVIEW' || !b.attestorRef)
    throw new Error('TAX13_R8_SOURCE_REVIEW_NOT_TRUSTED');
  const checked=validateLegalScopeEvidence(b.manifest,{
    publicationVersionId:b.publicationVersionId,sourceId:b.sourceId,
    officialUrl:b.officialUrl,sanitizedHtml:normalized,
    validAsOf:proof.validAsOf,trustedAttestor:true,
    trustedEvidenceHosts:OFFICIAL_EVIDENCE_HOSTS.confaz??[],
  });
  if (!checked.valid || checked.coverage!=='COMPLETE' ||
      checked.currentSegments===0 ||
      canonicalLegalProofJson(checked.currentFragments)!==
        canonicalLegalProofJson(proof.currentFragments) ||
      proof.proofId!==b.proofId || proof.attestationId!==b.attestationId ||
      proof.publicationVersionId!==b.publicationVersionId ||
      proof.sourceId!==b.sourceId || proof.officialUrl!==b.officialUrl ||
      proof.reviewDecisionId!==b.attestorRef ||
      proof.parserBuildDigest!==build || proof.parserVersion!==parser ||
      proof.sanitizerVersion!==sanitizer || proof.legalPolicyVersion!==policy)
    throw new Error('TAX13_R8_SIGNED_SCOPE_OR_BUILD_INVALID');
  const macInput='TRIBUSCA:TAX13:R8:PROOF_VERIFIED:1\n'+
    b.proofId+':'+b.payloadSha256+':'+b.signatureBase64+':'+b.rawSha256;
  const mac=createHmac('sha256',Buffer.from(macSecret!,'hex'))
    .update(macInput,'utf8').digest('hex');
  if (confirmed) {
    await db.query(
      'INSERT INTO public.tax13_v2_verified_proofs(proof_id,artifact_id,payload_sha256,verifier_key_id,verifier_mac,verifier_identity) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6)',
      [b.proofId,b.rawArtifactId,b.payloadSha256,macKeyId,mac,verifierId]);
    await db.query('COMMIT');
    console.log('TAX13_R8_PROOF_VERIFIED='+JSON.stringify({
      proofId:b.proofId,rawSha256:b.rawSha256,verifierId,
    }));
  } else {
    await db.query('ROLLBACK');
    console.log('TAX13_R8_PROOF_DRY_RUN='+JSON.stringify({
      proofId:b.proofId,rawSha256:b.rawSha256,verifierId,
    }));
  }
} catch(e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  db.release();
  await pool.end();
}
