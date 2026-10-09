/**
 * TAX13-R8-02: signature boundary for an EXTERNAL DOU certification review.
 * Verifying Ed25519 attests only that an independently authorized verifier
 * signed the assertion. This module DOES NOT inspect a PDF/ICP-Brasil
 * certificate, prove official origin, attest vigency, or mint legal CURRENT.
 *
 * The trusted keyring must be provisioned OUTSIDE the ingestion DB/repository.
 * A key shipped in a fixture or in caller-submitted data is never trusted.
 */
import {createPublicKey,verify as verifySignature} from 'node:crypto';
import type {DouConfazTrace} from './dou-source-custody-preflight.js';

const hex=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;
const statementFields=[
 'schema','reviewId','verifierIdentity','verifiedAt','certificatePolicyVersion',
 'certificateFingerprintSha256','certifiedPdfSha256','sourceCode',
 'publicationDate','section','edition','officialMatterId',
 'certifiedPageUrl','archiveSha256','xmlPartSha256','parentExternalId',
 'parentTextSha256','certifiedExtractedTextSha256'
] as const;
const signedFields=['keyId','statement','signatureBase64'] as const;
const sameKeys=(x:Record<string,unknown>,keys:readonly string[])=>
 Object.keys(x).sort().join('\0')===[...keys].sort().join('\0');
const strictIso=(text:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)&&
 !Number.isNaN(new Date(text).getTime())&&new Date(text).toISOString()===text;

export interface DouCertifiedReviewStatementV1 {
 schema:'TRIBUSCA:DOU:CERTIFIED_REVIEW:1';
 reviewId:string;
 verifierIdentity:string;
 verifiedAt:string;
 certificatePolicyVersion:string;
 certificateFingerprintSha256:string;
 certifiedPdfSha256:string;
 sourceCode:'dou';
 publicationDate:string;
 section:string;
 edition:string;
 officialMatterId:string;
 certifiedPageUrl:string;
 archiveSha256:string;
 xmlPartSha256:readonly string[];
 parentExternalId:string;
 parentTextSha256:string;
 certifiedExtractedTextSha256:string;
}
export interface SignedDouCertifiedReview {
 keyId:string;
 statement:DouCertifiedReviewStatementV1;
 signatureBase64:string;
}
export interface IndependentDouReviewKeyring {
 readonly publicKeysById:ReadonlyMap<string,string>;
 readonly revokedKeyIds:ReadonlySet<string>;
 readonly approvedCertificatePolicies:ReadonlySet<string>;
}
/** Signers and independent reviewers MUST use this exact domain-separated byte representation. */
export function canonicalDouReviewStatement(s:DouCertifiedReviewStatementV1):string{
 const record=s as unknown as Record<string,unknown>;
 if(!record||typeof record!=='object'||Array.isArray(record)||
    !sameKeys(record,statementFields))throw new Error('R802_DOU_REVIEW_UNKNOWN_FIELDS');
 if(s.schema!=='TRIBUSCA:DOU:CERTIFIED_REVIEW:1'||
   !uuid.test(s.reviewId)||!keyId.test(s.verifierIdentity)||
   !strictIso(s.verifiedAt)||!keyId.test(s.certificatePolicyVersion)||
   !hex.test(s.certificateFingerprintSha256)||!hex.test(s.certifiedPdfSha256)||
   s.sourceCode!=='dou'||!/^\d{4}-\d{2}-\d{2}$/.test(s.publicationDate)||
   !['DO1','DO1E','DO3','DO3E'].includes(s.section)||
   !/^\d+$/.test(s.edition)||!/^\d+$/.test(s.officialMatterId)||
   !hex.test(s.archiveSha256)||!hex.test(s.parentTextSha256)||
   !hex.test(s.certifiedExtractedTextSha256)||
   !Array.isArray(s.xmlPartSha256)||s.xmlPartSha256.length<1||
   s.xmlPartSha256.length>48||s.xmlPartSha256.some(x=>!hex.test(x))||
   typeof s.certifiedPageUrl!=='string'||s.certifiedPageUrl.length>2048||
   typeof s.parentExternalId!=='string'||s.parentExternalId.length>150)
   throw new Error('R802_DOU_REVIEW_INVALID_FIELDS');
 const values=statementFields.map(field=>[field,s[field]]);
 return 'TRIBUSCA:DOU:CERTIFIED_REVIEW:1\n'+JSON.stringify(values);
}
export type DouReviewResult={
 readonly reviewSignatureAuthenticated:boolean;
 readonly authenticatedOfficialPublication:false;
 readonly grantsLegalCurrent:false;
 readonly reason:string;
};
const reject=(reason:string):DouReviewResult=>({
 reviewSignatureAuthenticated:false,authenticatedOfficialPublication:false,
 grantsLegalCurrent:false,reason
});
/**
 * Verify the independently signed review assertion against an OUT-OF-BAND key.
 * This is a custody boundary, never an assertion that PDF/ICP validation ran.
 * Passing this check must not be wired to SQL CURRENT by itself.
 */
export function verifyIndependentDouReview(
 trace:DouConfazTrace,
 signed:SignedDouCertifiedReview,
 trust:IndependentDouReviewKeyring,
 now:Date=new Date()
):DouReviewResult{
 try {
  if(trace.status!=='DOU_XML_TRACE_ONLY'||trace.grantsLegalCurrent!==false||
     trace.authenticatedOfficialPublication!==false)
    return reject('DOU_TRACE_NOT_UNTRUSTED');
  const shape=signed as unknown as Record<string,unknown>;
  if(!shape||!sameKeys(shape,signedFields)||!keyId.test(signed.keyId)||
    !trust||!trust.publicKeysById||!trust.revokedKeyIds||!trust.approvedCertificatePolicies)
    return reject('DOU_SIGNED_REVIEW_FORMAT_INVALID');
  const s=signed.statement;
  const raw=canonicalDouReviewStatement(s);
  if(!trust.approvedCertificatePolicies.has(s.certificatePolicyVersion)||
    trust.revokedKeyIds.has(signed.keyId))
    return reject('DOU_REVIEW_POLICY_OR_KEY_REVOKED');
  if(!strictIso(s.verifiedAt)||new Date(s.verifiedAt).getTime()>now.getTime()||
    new Date(s.verifiedAt).getTime()<Date.parse(s.publicationDate))
    return reject('DOU_REVIEW_TIME_INVALID');
  if(s.publicationDate!==trace.publicationDate||s.section!==trace.section||
    s.edition!==trace.edition||s.officialMatterId!==trace.officialMatterId||
    s.certifiedPageUrl!==trace.certifiedPageUrl||
    s.archiveSha256!==trace.archiveSha256||
    s.parentTextSha256!==trace.parentTextSha256||
    s.certifiedExtractedTextSha256!==trace.parentTextSha256||
    s.parentExternalId!==trace.parentExternalId||
    JSON.stringify(s.xmlPartSha256)!==JSON.stringify(trace.xmlPartSha256))
    return reject('DOU_REVIEW_PUBLICATION_BINDING_MISMATCH');
  const keyPem=trust.publicKeysById.get(signed.keyId);
  if(!keyPem)return reject('DOU_UNTRUSTED_INDEPENDENT_KEY');
  const sig=Buffer.from(signed.signatureBase64,'base64');
  if(sig.length!==64||sig.toString('base64')!==signed.signatureBase64)
    return reject('DOU_INVALID_SIGNATURE_ENCODING');
  if(!verifySignature(null,Buffer.from(raw,'utf8'),createPublicKey(keyPem),sig))
    return reject('DOU_INDEPENDENT_REVIEW_SIGNATURE_INVALID');
  return {reviewSignatureAuthenticated:true,authenticatedOfficialPublication:false,
   grantsLegalCurrent:false,
   reason:'SIGNED_REVIEW_ONLY_CERTIFIED_PDF_VALIDATION_AND_LEGAL_EFFECTIVITY_STILL_REQUIRED'};
 }catch{return reject('DOU_REVIEW_MALFORMED_OR_UNTRUSTED');}
}
