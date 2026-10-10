import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fetchOfficialDouPdfPage} from '../src/modules/taxonomy/legal-scope/dou-official-http-pdf-capture.js';
import type {DouConfazTrace} from '../src/modules/taxonomy/legal-scope/dou-source-custody-preflight.js';

/**
 * SYNTHETIC NETWORK ONLY. These tests NEVER claim real government download,
 * official authenticity, certification, legal CURRENT, or act effectivity.
 */
const trace:DouConfazTrace={
 status:'DOU_XML_TRACE_ONLY',
 authenticatedOfficialPublication:false,
 grantsLegalCurrent:false,
 sourceCode:'dou',
 edition:'80',
 section:'DO1E',
 publicationDate:'2024-04-25',
 officialMatterId:'12345678',
 certifiedPageUrl:'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=601&pagina=1',
 archiveUrl:'https://inlabs.in.gov.br/index.php?p=2024-04-25&dl=2024-04-25-DO1E.zip',
 archiveSha256:'a'.repeat(64),
 xmlPartSha256:['b'.repeat(64)],
 embedded:true,
 parentExternalId:'2024-04-25:DO1E:80:12345678',
 parentTextSha256:'c'.repeat(64),
 outstandingGates:['OFFICIAL_HTTPS_PDF_SOURCE_CAPTURE'],
};
const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
const official='https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=25%2F04%2F2024&jornal=601&pagina=1';

test('TAX13 DOU synthetic fetch: official URL derived from trace, PDF bytes hashed, no CURRENT',async t=>{
 const seen:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,options?:RequestInit)=>{
  seen.push(String(input));
  assert.equal(options?.method,'GET');
  assert.equal(options?.redirect,'error');
  assert.equal(new Headers(options?.headers).get('accept'),'application/pdf');
  return new Response(pdf,{status:200,headers:{'content-type':'application/pdf'}});
 });
 const result=await fetchOfficialDouPdfPage(trace);
 assert.equal(result.status,'OFFICIAL_DOU_PDF_SOURCE_CAPTURED',JSON.stringify(result));
 assert.deepEqual(seen,[official]);
 assert.equal(result.grantsLegalCurrent,false);
 if(result.status!=='OFFICIAL_DOU_PDF_SOURCE_CAPTURED')return;
 assert.equal(result.requestUrl,official);
 assert.equal(result.httpStatus,200);
 assert.equal(result.preflight.authenticatedOfficialPublication,false);
 assert.equal(result.preflight.legalEffectivity,'UNVERIFIED');
 assert.equal(result.preflight.candidate?.pdfSha256,createHash('sha256').update(pdf).digest('hex'));
 assert.equal(result.preflight.candidate?.byteLength,pdf.length);
});

test('TAX13 DOU synthetic fetch: HTML login, redirect, response errors never become publication',async t=>{
 let current=new Response('<html>Captcha</html>',{status:200,headers:{'content-type':'text/html'}});
 t.mock.method(globalThis,'fetch',async()=>current);
 for(const [response,reason] of [
  [new Response('<html>Captcha</html>',{status:200,headers:{'content-type':'text/html'}}),'DOU_OFFICIAL_SOURCE_NOT_PDF'],
  [new Response(null,{status:302,headers:{location:'https://example.invalid'}}),'DOU_OFFICIAL_SOURCE_HTTP_NON_200'],
  [new Response(null,{status:503}),'DOU_OFFICIAL_SOURCE_HTTP_NON_200'],
  [new Response(pdf,{status:200,headers:{'content-type':'application/pdf','content-length':String(20*1024*1024+1)}}),'DOU_OFFICIAL_SOURCE_TOO_LARGE'],
  [new Response('<html>invalid body</html>',{status:200,headers:{'content-type':'application/pdf'}}),'DOU_OFFICIAL_PDF_PREFLIGHT_REJECTED'],
 ] as const){
  current=response;
  const result=await fetchOfficialDouPdfPage(trace);
  assert.equal(result.status,'UNVERIFIED',reason);
  if(result.status==='UNVERIFIED')assert.equal(result.reason,reason);
  assert.equal(result.grantsLegalCurrent,false);
 }
});
test('TAX13 DOU synthetic fetch: forged host, user info and different edition fail before fetching',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{
  calls++;
  return new Response(pdf,{status:200,headers:{'content-type':'application/pdf'}});
 });
 const attacks=[
  'https://pesquisa.in.gov.br.evil.invalid/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=601&pagina=1',
  'https://example.invalid/',
  'http://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=601&pagina=1',
  'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=601&pagina=1&pagina=2',
  'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=602&pagina=1&redirect=1',
  'https://user@pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=25/04/2024&jornal=601&pagina=1'
 ];
 for(const url of attacks){
  const result=await fetchOfficialDouPdfPage({...trace,certifiedPageUrl:url});
  assert.equal(result.status,'UNVERIFIED',url);
  assert.equal(result.grantsLegalCurrent,false);
 }
 assert.equal(calls,0,'invalid viewer references must not cause network requests');
});

test('TAX13 DOU synthetic fetch: network unavailable is an ERROR not empty publication',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('OFFLINE_TEST_ONLY')});
 const result=await fetchOfficialDouPdfPage(trace);
 assert.equal(result.status,'UNVERIFIED');
 if(result.status==='UNVERIFIED')assert.equal(result.reason,'DOU_OFFICIAL_SOURCE_FETCH_FAILED');
 assert.equal(result.grantsLegalCurrent,false);
});

test('TAX13 DOU synthetic fetch: misleading Content-Length and compressed body are rejected',async t=>{
 let response=new Response(pdf,{status:200,
  headers:{'content-type':'application/pdf','content-length':String(pdf.length+8)}});
 t.mock.method(globalThis,'fetch',async()=>response);
 const wrongLength=await fetchOfficialDouPdfPage(trace);
 assert.equal(wrongLength.status,'UNVERIFIED');
 if(wrongLength.status==='UNVERIFIED')assert.equal(wrongLength.reason,'DOU_OFFICIAL_SOURCE_LENGTH_MISMATCH');
 response=new Response(pdf,{status:200,
  headers:{'content-type':'application/pdf','content-encoding':'gzip'}});
 const compressed=await fetchOfficialDouPdfPage(trace);
 assert.equal(compressed.status,'UNVERIFIED');
 if(compressed.status==='UNVERIFIED')assert.equal(compressed.reason,'DOU_OFFICIAL_SOURCE_ENCODING_UNSUPPORTED');
});

test('TAX13 DOU synthetic fetch: streaming overflow cancels the response body',async t=>{
 let cancelled=false;
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream<Uint8Array>({
  start(controller){controller.enqueue(new Uint8Array(20*1024*1024+1));},
  cancel(){cancelled=true;}
 }),{status:200,headers:{'content-type':'application/pdf'}}));
 const result=await fetchOfficialDouPdfPage(trace);
 assert.equal(result.status,'UNVERIFIED');
 if(result.status==='UNVERIFIED')assert.equal(result.reason,'DOU_OFFICIAL_SOURCE_TOO_LARGE');
 assert.equal(cancelled,true);
});
