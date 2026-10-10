/**
 * Trifaros: direct, bounded official DOU PDF page fetch.
 * No signing certificate / ICP-Brasil / OCSP checks by product policy.
 * A successful HTTPS government-source download is a source-of-publication
 * receipt, NOT a conclusion about legal effectivity or CURRENT status.
 * The received data never goes into PostgreSQL or tenant-specific copies.
 */
import type {DouConfazTrace} from './dou-source-custody-preflight.js';
import {preflightContemporaryDouPdfBytes, type ContemporaryDouPdfBytePreflight}
 from './dou-pdf-byte-preflight.js';

const MAX_PDF_BYTES=20*1024*1024;
type Denied={readonly status:'UNVERIFIED';readonly reason:string;
 readonly grantsLegalCurrent:false};
export type OfficialDouPdfSourceCapture=Denied|{
 readonly status:'OFFICIAL_DOU_PDF_SOURCE_CAPTURED';
 readonly grantsLegalCurrent:false;
 readonly fetchedAt:string;
 readonly requestUrl:string;
 readonly httpStatus:200;
 readonly contentType:string;
 readonly preflight:ContemporaryDouPdfBytePreflight;
};
const deny=(reason:string):Denied=>({status:'UNVERIFIED',reason,grantsLegalCurrent:false});

/**
 * Construct the PDF request from our already parsed DOU XML trace rather than
 * accepting an arbitrary user-entered URL. No third-party redirects or HTML
 * responses are accepted as PDF evidence.
 */
export async function fetchOfficialDouPdfPage(
 trace:DouConfazTrace,
):Promise<OfficialDouPdfSourceCapture>{
 if(!trace||trace.status!=='DOU_XML_TRACE_ONLY')return deny('DOU_VALID_XML_TRACE_REQUIRED');
 let pdfUrl:string;
 try{
  const ref=new URL(trace.certifiedPageUrl);
  if(ref.protocol!=='https:'||ref.hostname!=='pesquisa.in.gov.br'||
    ref.port||ref.username||ref.password||ref.hash||
    ref.pathname!=='/imprensa/jsp/visualiza/index.jsp')return deny('DOU_VIEWER_REFERENCE_INVALID');
  const fields=[...ref.searchParams.keys()];
  if(fields.length!==3||new Set(fields).size!==3||
   fields.some(k=>!['data','jornal','pagina'].includes(k)))return deny('DOU_VIEWER_QUERY_INVALID');
  const date=ref.searchParams.get('data');
  const journal=ref.searchParams.get('jornal');
  const page=ref.searchParams.get('pagina');
  if(date!==trace.publicationDate.split('-').reverse().join('/')||
    !journal||!/^[0-9]{1,4}$/.test(journal)||
    !page||!/^[1-9][0-9]{0,6}$/.test(page))return deny('DOU_VIEWER_EDITION_INVALID');
  const url=new URL('https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer');
  url.searchParams.set('data',date);
  url.searchParams.set('jornal',journal);
  url.searchParams.set('pagina',page);
  pdfUrl=url.toString();
 }catch{return deny('DOU_VIEWER_REFERENCE_INVALID');}
 try{
  const resp=await fetch(pdfUrl,{
   method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),
   headers:{Accept:'application/pdf'},
  });
  if(resp.status!==200)return deny('DOU_OFFICIAL_SOURCE_HTTP_NON_200');
  const mime=(resp.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
  if(!['application/pdf','application/octet-stream'].includes(mime))
   return deny('DOU_OFFICIAL_SOURCE_NOT_PDF');
  const len=resp.headers.get('content-length');
  if(len!==null&&(!/^[0-9]+$/.test(len)||Number(len)>MAX_PDF_BYTES))
   return deny('DOU_OFFICIAL_SOURCE_TOO_LARGE');
  if(!resp.body)return deny('DOU_OFFICIAL_SOURCE_EMPTY');
  const parts:Uint8Array[]=[];let total=0;
  const reader=resp.body.getReader();
  try{
   for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    total+=value.byteLength;
    if(total>MAX_PDF_BYTES)return deny('DOU_OFFICIAL_SOURCE_TOO_LARGE');
    parts.push(value);
   }
  }finally{
   reader.releaseLock();
  }
  const bytes=Buffer.concat(parts,total);
  const preflight=preflightContemporaryDouPdfBytes({trace,pdfUrl,pdfBytes:bytes});
  if(preflight.status!=='DOU_PDF_BYTES_BOUND_ONLY')
   return deny('DOU_OFFICIAL_PDF_PREFLIGHT_REJECTED');
  return {
   status:'OFFICIAL_DOU_PDF_SOURCE_CAPTURED',grantsLegalCurrent:false,
   fetchedAt:new Date().toISOString(),requestUrl:pdfUrl,
   httpStatus:200,contentType:mime,preflight,
  };
 }catch{
  return deny('DOU_OFFICIAL_SOURCE_FETCH_FAILED');
 }
}
