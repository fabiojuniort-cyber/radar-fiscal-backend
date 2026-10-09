import assert from 'node:assert/strict';
import test from 'node:test';
import {parseDouEntries} from '../src/modules/collection/dou.parser.js';
import {preflightDouConfazTrace} from '../src/modules/taxonomy/legal-scope/dou-source-custody-preflight.js';
import type {ConnectorPublication} from '../src/modules/collection/connector.contract.js';
import {archiveContext} from './dou.fixtures.js';

/** Local bytes are deliberately synthetic and NEVER certified DOU evidence. */
function syntheticPublications():ConnectorPublication[]{
 const body=[
  '<p>Publica os convênios firmados.</p>',
  '<p>CONVÊNIO ICMS Nº 63, DE 17 DE SETEMBRO DE 2026</p>',
  '<p>Altera o Convênio ICMS anterior e define condições.</p>',
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
   assert.ok(c.outstandingGates.includes('INDEPENDENT_CERTIFIED_DOU_PUBLICATION_VALIDATION'));
  }
 }
});
test('R802 DOU missing parent, false source, fabricated archive and foreign page fail closed',()=>{
 const [parent,child]=syntheticPublications();assert.ok(parent&&child);
 const inp=(p:ConnectorPublication,base:ConnectorPublication|undefined=parent,sourceCode='dou')=>
  preflightDouConfazTrace({sourceCode,publication:p,...(base?{parent:base}:{})});
 assert.equal(inp(child,undefined).status,'UNVERIFIED');
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
