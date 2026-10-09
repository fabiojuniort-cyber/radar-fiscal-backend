/**
 * Trifaros TAX13-R8-02: BYTE-BOUND preflight for a contemporary official DOU
 * PDF page. A URL, apparent PDF file header, SHA256 and TLS hostname are
 * NOT official publication authenticity and NEVER prove legal CURRENT.
 *
 * Only the external independently administered certificate/trust-chain
 * verifier can assess actual official certification. This pure read-only
 * function does not fetch, persist, parse legal text, or approve proof.
 * Caller must download the PDF independently of user-submitted URLs and
 * enforce origin/redirect/network controls BEFORE passing the actual bytes.
 */
import {createHash} from 'node:crypto';
import type {DouConfazTrace} from './dou-source-custody-preflight.js';
import {verifyIndependentDouReview, type SignedDouCertifiedReview, type IndependentDouReviewKeyring} from './dou-certified-review-signature.js';

const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
const JOURNAL_RE=/^\d{1,4}$/;
const PAGE_RE=/^[1-9]\d{0,6}$/;
const MAX_BYTES=20*1024*1024;
const rePdfHeader=/^%PDF-1\.[0-9]$|^%PDF-2\.0$/;
export type ContemporaryDouPdfBytePreflight={
 readonly status:'DOU_PDF_BYTES_BOUND_ONLY'|'UNVERIFIED';
 readonly authenticatedOfficialPublication:false;
 readonly grantsLegalCurrent:false;
 readonly legalEffectivity:'UNVERIFIED';
 readonly reason:string;
 readonly candidate?:{
   readonly pdfSha256:string;
   readonly byteLength:number;
   readonly sourceUrl:string;
   readonly referenceDate:string;
   readonly journal:string;
   readonly page:string;
   readonly parentExternalId:string;
   readonly officialMatterId:string;
   readonly archiveSha256:string;
   readonly outstandingGates:readonly string[];
 };
};
const denied=(reason:string):ContemporaryDouPdfBytePreflight=>({
 status:'UNVERIFIED',authenticatedOfficialPublication:false,
 grantsLegalCurrent:false,legalEffectivity:'UNVERIFIED',reason,
});
/**
 * Strict browser-visible PDF URL lookup: not an allowlist for a downloader.
 * This accepts only the Imprensa Nacional's direct PDF viewer URL pattern.
 * An accepted URL string MUST NOT be equated to an authenticated HTTP
 * response — an attacker can forge both the URL and every supplied byte.
 */
function parsePdfPageUrl(value:string):{
 canonicalUrl:string;date:string;journal:string;page:string;
}|null{
 try{
  if(typeof value!=='string'||value.length>2048)return null;
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='pesquisa.in.gov.br'||
    url.port||url.username||url.password||url.hash||
    url.pathname!=='/imprensa/servlet/INPDFViewer')return null;
  const keys=[...url.searchParams.keys()];
  if(keys.length<3||keys.length>4||
     new Set(keys).size!==keys.length||
     keys.some(k=>!['data','jornal','pagina','captchafield'].includes(k)))return null;
  if(keys.includes('captchafield')&&
    url.searchParams.get('captchafield')!=='firstAccess')return null;
  const date=url.searchParams.get('data')??'';
  const journal=url.searchParams.get('jornal')??'';
  const page=url.searchParams.get('pagina')??'';
  if(!/^\d{2}\/\d{2}\/\d{4}$/.test(date)||
    !JOURNAL_RE.test(journal)||!PAGE_RE.test(page))return null;
  const iso=date.split('/').reverse().join('-');
  if(!DATE_RE.test(iso)||new Date(iso+'T00:00:00Z').toISOString().slice(0,10)!==iso||
    iso<'2020-01-01')return null;
  return {canonicalUrl:url.toString(),date:iso,journal,page};
 }catch{return null;}
}
function viewerReferencePage(value:string):{
 date:string;journal:string;page:string;
}|null{
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='pesquisa.in.gov.br'||
   url.username||url.password||url.port||url.hash||
   url.pathname!=='/imprensa/jsp/visualiza/index.jsp')return null;
  const keys=[...url.searchParams.keys()];
  if(keys.length!==3||new Set(keys).size!==3||
    keys.some(k=>!['data','jornal','pagina'].includes(k)))return null;
  const date=url.searchParams.get('data')??'';
  const journal=url.searchParams.get('jornal')??'';
  const page=url.searchParams.get('pagina')??'';
  return /^\d{2}\/\d{2}\/\d{4}$/.test(date)&&
    JOURNAL_RE.test(journal)&&PAGE_RE.test(page)?
    {date:date.split('/').reverse().join('-'),journal,page}:null;
 }catch{return null;}
}
export function preflightContemporaryDouPdfBytes(input:{
 trace:DouConfazTrace;
 pdfUrl:string;
 pdfBytes:Uint8Array;
}):ContemporaryDouPdfBytePreflight{
 if(!input||!input.trace||input.trace.status!=='DOU_XML_TRACE_ONLY'||
   input.trace.authenticatedOfficialPublication!==false||
   input.trace.grantsLegalCurrent!==false)
   return denied('DOU_UNTRUSTED_TRACE_REQUIRED');
 const {trace}=input;
 const page=parsePdfPageUrl(input.pdfUrl);
 if(!page)return denied('DOU_OFFICIAL_PDF_URL_INVALID');
 const parent=viewerReferencePage(trace.certifiedPageUrl);
 if(!parent||page.date!==trace.publicationDate||
   page.date!==parent.date||page.journal!==parent.journal||
   page.page!==parent.page)
   return denied('DOU_PDF_EDITION_PAGE_MISMATCH');
 const bytes=input.pdfBytes;
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<16||
    bytes.byteLength>MAX_BYTES)
   return denied('DOU_PDF_BYTES_SIZE_INVALID');
 // Basic format hygiene only; %PDF and %%EOF are easily forged. Do not
 // inspect/assume certificates based on the presence of marker strings.
 const head=Buffer.from(bytes.subarray(0,8)).toString('latin1');
 const end=Buffer.from(bytes.subarray(Math.max(0,bytes.length-2048))).toString('latin1');
 if(!rePdfHeader.test(head)||!/(?:^|\r|\n)%%EOF(?:\r?\n|[\t ]*)$/.test(end))
   return denied('DOU_PDF_FORMAT_UNVERIFIED');
 const sha=createHash('sha256').update(bytes).digest('hex');
 return {
  status:'DOU_PDF_BYTES_BOUND_ONLY',
  authenticatedOfficialPublication:false,grantsLegalCurrent:false,
  legalEffectivity:'UNVERIFIED',
  reason:'DOU_PDF_BYTES_WITHOUT_INDEPENDENT_OFFICIAL_CERTIFICATION',
  candidate:{
   pdfSha256:sha,byteLength:bytes.length,sourceUrl:page.canonicalUrl,
   referenceDate:page.date,journal:page.journal,page:page.page,
   parentExternalId:trace.parentExternalId,
   officialMatterId:trace.officialMatterId,
   archiveSha256:trace.archiveSha256,
   outstandingGates:[
    'INDEPENDENT_SIGNED_OFFICIAL_PDF_CUSTODY',
    'INDEPENDENT_ICP_BRASIL_SIGNATURE_CERT_CHAIN_AND_REVOCATION',
    'BOUNDED_EXACT_PDF_TEXT_TO_INLABS_XML_AND_CONF_AZ_ACT_MATCH',
    'OFFICIAL_AMENDMENTS_AND_EFFECTIVITY_BY_SEGMENT',
    'INDEPENDENT_R9_REVIEW',
   ],
  }
 };
}

/**
 * Bind actual (still untrusted) fetched PDF bytes to a signed independent
 * review assertion. This is NOT certificate validation or legal effectivity.
 * It proves at most consistency of a chosen byte string and an independently
 * signed claim. A dishonest reviewer or forged PDF will NOT be detected by
 * the digest equality itself.
 */
export function bindContemporaryDouPdfToIndependentReview(input:{
 trace:DouConfazTrace;
 pdf:ContemporaryDouPdfBytePreflight;
 review:SignedDouCertifiedReview;
 keyring:IndependentDouReviewKeyring;
 now:Date;
}):{
 readonly status:'DOU_SIGNED_REVIEW_BYTES_MATCH_ONLY'|'UNVERIFIED';
 readonly authenticatedOfficialPublication:false;
 readonly grantsLegalCurrent:false;
 readonly reason:string;
}{
 const reject=(reason:string)=>({
  status:'UNVERIFIED' as const,authenticatedOfficialPublication:false as const,
  grantsLegalCurrent:false as const,reason,
 });
 if(!input||input.pdf?.status!=='DOU_PDF_BYTES_BOUND_ONLY'||
    !input.pdf.candidate||!input.trace||input.trace.status!=='DOU_XML_TRACE_ONLY')
  return reject('DOU_PDF_REVIEW_BYTES_NOT_BOUND');
 const reviewResult=verifyIndependentDouReview(
  input.trace,input.review,input.keyring,input.now);
 if(!reviewResult.reviewSignatureAuthenticated)
  return reject('DOU_INDEPENDENT_REVIEW_NOT_AUTHENTICATED');
 const c=input.pdf.candidate;
 if(input.review.statement.certifiedPdfSha256!==c.pdfSha256||
    input.review.statement.publicationDate!==c.referenceDate||
    input.review.statement.parentExternalId!==c.parentExternalId||
    input.review.statement.officialMatterId!==c.officialMatterId||
    input.review.statement.archiveSha256!==c.archiveSha256)
  return reject('DOU_REVIEW_ACTUAL_PDF_BYTES_MISMATCH');
 return {
  status:'DOU_SIGNED_REVIEW_BYTES_MATCH_ONLY',
  authenticatedOfficialPublication:false,grantsLegalCurrent:false,
  reason:'SIGNED_BYTES_MATCH_ONLY_CERTIFICATE_CHAIN_TEXT_AND_VIGENCY_PENDING',
 };
}
