/**
 * Trifaros TAX13-R8-02: lightweight DOU PDF source-document checks.
 * Policy: PDF fetched by our connector over HTTPS from a government host is
 * sufficient as publication SOURCE (no digital-certificate/ICP checking).
 * Hash is for traceability/deduplication, never itself proof of origin.
 * Content and legal effectivity remain independent decisions. READ ONLY.
 */
import {createHash} from 'node:crypto';
import type {DouConfazTrace} from './dou-source-custody-preflight.js';

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
  reason:'DOU_PDF_BYTES_PENDING_OFFICIAL_SOURCE_FETCH',
  candidate:{
   pdfSha256:sha,byteLength:bytes.length,sourceUrl:page.canonicalUrl,
   referenceDate:page.date,journal:page.journal,page:page.page,
   parentExternalId:trace.parentExternalId,
   officialMatterId:trace.officialMatterId,
   archiveSha256:trace.archiveSha256,
   outstandingGates:[
    'DIRECT_OFFICIAL_HTTPS_SOURCE_FETCH',
    'EXACT_EDITION_PAGE_AND_ACT_CONTENT_MATCH',
    'DOU_XML_DISPATCH_ACT_TEXT_CORRESPONDENCE',
    'RATIFICATION_AND_LEGAL_EFFECTIVITY_BY_SEGMENT',
    'INDEPENDENT_R9_REVIEW',
   ],
  }
 };
}
