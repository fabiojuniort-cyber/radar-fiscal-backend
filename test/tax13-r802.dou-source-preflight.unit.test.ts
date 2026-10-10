import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {parseDouEntries} from '../src/modules/collection/dou.parser.js';
import {preflightDouConfazTrace} from '../src/modules/taxonomy/legal-scope/dou-source-custody-preflight.js';
import {preflightContemporaryDouPdfBytes} from '../src/modules/taxonomy/legal-scope/dou-pdf-byte-preflight.js';
import {correlateOfficialDouPdfActText} from '../src/modules/taxonomy/legal-scope/dou-official-text-correspondence.js';
import {douHtmlText} from '../src/modules/collection/dou.parser.js';
import {fetchOfficialDouPdfPage,fetchAndMatchOfficialDouPdfAct} from '../src/modules/taxonomy/legal-scope/dou-official-http-pdf-capture.js';
import {syntheticWrappedOnePagePdf} from './dou-one-page.pdf-fixtures.js';
import type {ConnectorPublication} from '../src/modules/collection/connector.contract.js';
import {archiveContext} from './dou.fixtures.js';

/** Local bytes are deliberately synthetic and NEVER certified DOU evidence. */
function syntheticPublications():ConnectorPublication[]{
 const body=[
  '<p>Publica os convênios firmados.</p>',
  '<p>CONVÊNIO ICMS Nº 63, DE 17 DE SETEMBRO DE 2026</p>',
  '<p>Altera o Convênio ICMS anterior e define condições específicas para as operações tributárias indicadas em cada cláusula, com os respectivos limites de aplicação.</p>',
  '<p>CONVÊNIO ICMS Nº 64, DE 17 DE SETEMBRO DE 2026</p>',
  '<p>Autoriza os estados conforme especificado.</p>'
 ].join('');
 const xml='<xml><article id="123456781" idMateria="12345678" '+
  'pubDate="18/09/2026" pubName="DO1" editionNumber="180" '+
  'artCategory="Ministério da Fazenda/Conselho Nacional de Política Fazendária" '+
  'artType="DESPACHO" numberPage="1" '+
  'pdfPage="https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&amp;jornal=515&amp;pagina=1">'+
  '<body><Identifica><![CDATA[DESPACHO Nº 28, DE 17 DE SETEMBRO DE 2026]]></Identifica>'+
  '<Ementa><![CDATA[]]></Ementa><Texto><![CDATA['+body+']]></Texto></body></article></xml>';
 const parsed=parseDouEntries([{name:'515_20260918_12345678.xml',bytes:Buffer.from(xml)}],archiveContext('DO1'));
 assert.equal(parsed.partialFailures.length,0);
 assert.equal(parsed.publications.length,3);
 return parsed.publications;
}
const copy=(p:ConnectorPublication):ConnectorPublication=>structuredClone(p);

test('R802 DOU synthetic XML creates TRACE ONLY, never an authenticated source or legal CURRENT',()=>{
 const [parent,child,other]=syntheticPublications();
 assert.ok(parent&&child&&other);
 for(const act of [child,other]){
  const c=preflightDouConfazTrace({sourceCode:'dou',publication:act,parent});
  assert.equal(c.status,'DOU_XML_TRACE_ONLY');
  assert.equal(c.authenticatedOfficialPublication,false);
  assert.equal(c.grantsLegalCurrent,false);
  if(c.status==='DOU_XML_TRACE_ONLY'){
   assert.equal(c.sourceCode,'dou');
   assert.equal(c.section,'DO1');
   assert.equal(c.edition,'180');
   assert.equal(c.officialMatterId,'12345678');
   assert.match(c.archiveSha256,/^[a-f0-9]{64}$/);
   assert.equal(c.xmlPartSha256.length,1);
   assert.ok(c.outstandingGates.includes('OFFICIAL_HTTPS_PDF_SOURCE_CAPTURE'));
  }
 }
});
test('R802 DOU missing parent, false source, fabricated archive and foreign page fail closed',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const inp=(p:ConnectorPublication,base:ConnectorPublication|undefined=parent,sourceCode='dou')=>
  preflightDouConfazTrace({sourceCode,publication:p,...(base?{parent:base}:{})});
 assert.equal(preflightDouConfazTrace({sourceCode:'dou',publication:child}).status,'UNVERIFIED');
 assert.equal(inp(child,parent,'confaz').status,'UNVERIFIED');
 let forged=copy(child);
 (forged.metadata!.dou as any).archive.rawSha256='0'.repeat(64);
 assert.equal(inp(forged).status,'UNVERIFIED','child source metadata cannot diverge from parent');
 forged=copy(parent);(forged.metadata!.dou as any).archive.officialUrl=
   'https://evil.example/index.php?p=2026-09-18&dl=2026-09-18-DO1.zip';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);forged.officialUrl='https://evil.example/materia';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);(forged.metadata!.dou as any).parts[0].rawSha256='1234';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);(forged.metadata!.dou as any).edition='181';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);forged.externalId='2026-09-18:DO1:180:99999999';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(child);forged.content='Conteúdo fabricado e não publicado';
 assert.equal(inp(forged).status,'UNVERIFIED');
 forged=copy(child);(forged.metadata!.dou as any).parentMatterExternalId='bogus';
 assert.equal(inp(forged).status,'UNVERIFIED');
 // A truncated child is still an exact substring of the parent dispatch but
 // loses normative text: reject by fully re-deriving act boundaries.
 forged=copy(child);forged.content=forged.content!.slice(0,-5);
 assert.equal(inp(forged).status,'UNVERIFIED');
 forged=copy(child);forged.content=forged.content!.split('\n')[0]!;
 assert.equal(inp(forged).status,'UNVERIFIED');
 forged=copy(child);(forged.metadata!.dou as any).embeddedIndex=2;
 assert.equal(inp(forged).status,'UNVERIFIED');
 forged=copy(parent);(forged.metadata!.dou as any).parts[0].filename='515_20260918_123456789.xml';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);(forged.metadata!.dou as any).parts[0].attributes.pdfPage='https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=18/09/2026&jornal=515&pagina=99';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
 forged=copy(parent);(forged.metadata!.dou as any).parts[0].attributes.editionNumber='181';
 assert.equal(inp(child,forged).status,'UNVERIFIED');
});
test('R802 DOU user supplied hash alone is NEVER authenticity; no evidence means no green',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 let c=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(c.grantsLegalCurrent,false);
 // Remove the actual XML entry identifiers. A string digest alone cannot
 // demonstrate which page, journal, matter or signed edition was published.
 const altered=copy(parent);
 (altered.metadata!.dou as any).parts=[];
 c=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent:altered});
 assert.equal(c.status,'UNVERIFIED');
 assert.equal(c.grantsLegalCurrent,false);
});

test('R802 DOU 1991 and 1997 cannot be misrepresented as INLABS XML captures',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 for(const year of ['1991','1997']){
  const historical=copy(parent);
  (historical.metadata!.dou as any).publicationDate=year+'-09-30';
  const result=preflightDouConfazTrace({
   sourceCode:'dou',publication:child,parent:historical
  });
  assert.equal(result.status,'UNVERIFIED');
  assert.equal(result.authenticatedOfficialPublication,false);
  assert.equal(result.grantsLegalCurrent,false);
  if(result.status==='UNVERIFIED')
   assert.equal(result.reason,'INLABS_XML_HISTORICAL_PERIOD_NOT_SUPPORTED');
 }
});

test('Trifaros R802: contemporaneous PDF bytes are SHA-bound only, NEVER official proof',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const trace=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(trace.status,'DOU_XML_TRACE_ONLY');
 if(trace.status!=='DOU_XML_TRACE_ONLY')return;
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const pdfUrl='https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?captchafield=firstAccess&data=18%2F09%2F2026&jornal=515&pagina=1';
 const result=preflightContemporaryDouPdfBytes({trace,pdfUrl,pdfBytes:pdf});
 assert.equal(result.status,'DOU_PDF_BYTES_BOUND_ONLY');
 assert.equal(result.authenticatedOfficialPublication,false);
 assert.equal(result.grantsLegalCurrent,false);
 assert.equal(result.legalEffectivity,'UNVERIFIED');
 assert.equal(result.candidate?.pdfSha256,createHash('sha256').update(pdf).digest('hex'));
 assert.equal(result.candidate?.journal,'515');
 assert.equal(result.candidate?.page,'1');
 assert.equal(result.candidate?.referenceDate,'2026-09-18');
 assert.equal(result.candidate?.officialMatterId,'12345678');
 assert.ok(result.candidate?.outstandingGates.includes('DIRECT_OFFICIAL_HTTPS_SOURCE_FETCH'));
 assert.equal(JSON.stringify(result).includes('1 0 obj'),false,
   'do not return raw PDF bytes/text in lightweight evidence');
});
test('Trifaros R802: wrong edition/page/host, forgery and extra query fail closed',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const trace=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(trace.status,'DOU_XML_TRACE_ONLY');
 if(trace.status!=='DOU_XML_TRACE_ONLY')return;
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const base='https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?data=18%2F09%2F2026&jornal=515&pagina=1';
 const attacks=[
  base.replace('pesquisa.in.gov.br','pesquisa.in.gov.br.evil.example'),
  base.replace('https:','http:'),
  base.replace('jornal=515','jornal=530'),
  base.replace('pagina=1','pagina=2'),
  base.replace('18%2F09%2F2026','19%2F09%2F2026'),
  base+'&pagina=1',
  base+'&redirect=https://evil.example',
  base+'#malicious',
  base.replace('INPDFViewer','visualiza'),
  base.replace('https://','https://any@'),
  base.replace('2026','1997'),
  base.replace('2026','2027'),
 ];
 for(const pdfUrl of attacks){
  const result=preflightContemporaryDouPdfBytes({trace,pdfUrl,pdfBytes:pdf});
  assert.equal(result.status,'UNVERIFIED',pdfUrl);
  assert.equal(result.authenticatedOfficialPublication,false);
  assert.equal(result.grantsLegalCurrent,false);
 }
 const noPdf=preflightContemporaryDouPdfBytes({trace,pdfUrl:base,
  pdfBytes:Buffer.from('<html>not a real PDF</html>')});
 assert.equal(noPdf.reason,'DOU_PDF_FORMAT_UNVERIFIED');
 const bogus=preflightContemporaryDouPdfBytes({trace,pdfUrl:base,
  pdfBytes:Buffer.from('%PDF-1.7\n/ByteRange [0 1 2 3] but no EOF')});
 assert.equal(bogus.status,'UNVERIFIED',
   'a claimed embedded signature marker does not qualify');
 const large=preflightContemporaryDouPdfBytes({trace,pdfUrl:base,
  pdfBytes:Buffer.alloc(20*1024*1024+1)});
 assert.equal(large.reason,'DOU_PDF_BYTES_SIZE_INVALID');
});

test('R802 policy: PDF metadata and hash never require signature validation or issue legal CURRENT',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const trace=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(trace.status,'DOU_XML_TRACE_ONLY');
 if(trace.status!=='DOU_XML_TRACE_ONLY')return;
 const url='https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?data=18%2F09%2F2026&jornal=515&pagina=1';
 // No /ByteRange, cryptographic signature, certificate policy, ICP or OCSP
 // metadata: a source document can still be traced and hashed.
 const plainPdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const result=preflightContemporaryDouPdfBytes({trace,pdfUrl:url,pdfBytes:plainPdf});
 assert.equal(result.status,'DOU_PDF_BYTES_BOUND_ONLY');
 assert.equal(result.candidate?.outstandingGates.includes('DIRECT_OFFICIAL_HTTPS_SOURCE_FETCH'),true);
 assert.equal(result.candidate?.outstandingGates.some(g=>/CERTIFICATE|ICP|OCSP|REVOCATION/.test(g)),false);
 assert.equal(result.grantsLegalCurrent,false);
});

test('R802 official fetch rejects invalid trace without network and never grants legal CURRENT',async()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const t=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(t.status,'DOU_XML_TRACE_ONLY');
 if(t.status!=='DOU_XML_TRACE_ONLY')return;
 const altered={...t,certifiedPageUrl:'https://example.invalid/'};
 const result=await fetchOfficialDouPdfPage(altered);
 assert.equal(result.status,'UNVERIFIED');
 assert.equal(result.grantsLegalCurrent,false);
});

test('R802 text correspondence: whole synthetic act matches PDF and dispatch, never legal CURRENT',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const trace=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(trace.status,'DOU_XML_TRACE_ONLY');
 if(trace.status!=='DOU_XML_TRACE_ONLY')return;
 const pdfUrl='https://pesquisa.in.gov.br/imprensa/servlet/INPDFViewer?data=18%2F09%2F2026&jornal=515&pagina=1';
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
 const preflight=preflightContemporaryDouPdfBytes({trace,pdfUrl,pdfBytes:pdf});
 assert.equal(preflight.status,'DOU_PDF_BYTES_BOUND_ONLY');
 const capture={
  status:'OFFICIAL_DOU_PDF_SOURCE_CAPTURED' as const,
  grantsLegalCurrent:false as const,preflight,
  fetchedAt:'2026-10-10T00:00:00.000Z',requestUrl:pdfUrl,
  httpStatus:200 as const,contentType:'application/pdf',
 };
 const pdfExtractedText='DIÁRIO OFICIAL DA UNIÃO Nº 180 Brasília, 18 de setembro de 2026 '+
  parent.title+' '+douHtmlText(child.content!);
 const good=correlateOfficialDouPdfActText({
  trace,sourceCapture:capture,parent,act:child,pdfExtractedText,printedEdition:'180',
 });
 assert.equal(good.status,'DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY',JSON.stringify(good));
 assert.equal(good.grantsLegalCurrent,false);
 if(good.status==='DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY')
  assert.equal(good.legalEffectivity,'UNVERIFIED');
 for(const [variant,reason] of [
  [pdfExtractedText.replace('Nº 180','Nº 181'),'DOU_WRONG_PRINTED_EDITION'],
  [pdfExtractedText.replace(parent.title,'ANOTHER DESPACHO'),'DOU_DISPATCH_OR_ACT_HEADING_MISSING'],
  [pdfExtractedText.replace('condições específicas','condições outras'),'DOU_WHOLE_ACT_TEXT_MISMATCH'],
  [pdfExtractedText.slice(0,90),'DOU_PDF_TEXT_OR_EDITION_INVALID'],
 ] as const){
  const rejected=correlateOfficialDouPdfActText({
   trace,sourceCapture:capture,parent,act:child,
   pdfExtractedText:variant,printedEdition:'180',
  });
  assert.equal(rejected.status,'UNVERIFIED',reason);
  if(rejected.status==='UNVERIFIED')assert.equal(rejected.reason,reason);
 }
});

test('R802 one same-buffer official PDF download and text extraction: synthetic complete act only',async t=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const trace=preflightDouConfazTrace({sourceCode:'dou',publication:child,parent});
 assert.equal(trace.status,'DOU_XML_TRACE_ONLY');
 if(trace.status!=='DOU_XML_TRACE_ONLY')return;
 const pdfText='DIÁRIO OFICIAL DA UNIÃO Nº 180 '+
  parent.title+' '+douHtmlText(child.content!);
 const bytes=syntheticWrappedOnePagePdf(pdfText);
 t.mock.method(globalThis,'fetch',async()=>new Response(bytes,{
  status:200,headers:{'content-type':'application/pdf'}
 }));
 const result=await fetchAndMatchOfficialDouPdfAct({
  trace,parent,act:child,printedEdition:'180',
 });
 assert.equal(result.status,'DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY',JSON.stringify(result));
 assert.equal(result.grantsLegalCurrent,false);
});
