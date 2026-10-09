/**
 * TAX13-R8-02. DOU/INLABS XML provenance preflight, READ ONLY.
 * These metadata hashes can be fabricated. This module MUST NEVER attest
 * official authenticity, legal vigency, produce receipts, or admit CURRENT.
 * Certified Imprensa Nacional publication + independent custody are pending.
 */
import {createHash} from 'node:crypto';
import type {ConnectorPublication} from '../../collection/connector.contract.js';
import {extractEmbeddedConfazPublications} from '../../collection/dou.parser.js';

const hex=/^[a-f0-9]{64}$/;
const sections=new Set(['DO1','DO1E','DO3','DO3E']);
const families=new Set(['CONVÊNIO ICMS','AJUSTE SINIEF','ATO COTEPE/ICMS','PROTOCOLO ICMS']);
type Obj=Record<string,unknown>;
const obj=(x:unknown):Obj|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Obj:null;
const str=(x:unknown):string=>typeof x==='string'?x:'';
function certifiedPage(url:string,date:string):boolean{
 try{
  const u=new URL(url);
  return u.protocol==='https:'&&u.hostname==='pesquisa.in.gov.br'&&!u.port&&
   !u.username&&!u.password&&!u.hash&&
   u.pathname==='/imprensa/jsp/visualiza/index.jsp'&&
   u.searchParams.get('data')===date.split('-').reverse().join('/')&&
   /^\d+$/.test(u.searchParams.get('jornal')??'')&&
   /^\d+$/.test(u.searchParams.get('pagina')??'')&&
   [...u.searchParams.keys()].every(k=>['data','jornal','pagina'].includes(k));
 }catch{return false;}
}
function officialZip(url:string,date:string,filename:string):boolean{
 try{
  const u=new URL(url);
  return u.protocol==='https:'&&u.hostname==='inlabs.in.gov.br'&&!u.port&&
   !u.username&&!u.password&&!u.hash&&u.pathname==='/index.php'&&
   u.searchParams.get('p')===date&&u.searchParams.get('dl')===filename&&
   [...u.searchParams.keys()].every(k=>['p','dl'].includes(k));
 }catch{return false;}
}
export interface DouConfazTrace {
 readonly status:'DOU_XML_TRACE_ONLY';
 readonly authenticatedOfficialPublication:false;
 readonly grantsLegalCurrent:false;
 readonly sourceCode:'dou';
 readonly edition:string;
 readonly section:string;
 readonly publicationDate:string;
 readonly officialMatterId:string;
 readonly certifiedPageUrl:string;
 readonly archiveUrl:string;
 readonly archiveSha256:string;
 readonly xmlPartSha256:readonly string[];
 readonly embedded:boolean;
 readonly parentExternalId:string;
 readonly parentTextSha256:string;
 readonly outstandingGates:readonly string[];
}
export type DouConfazTraceResult=DouConfazTrace|{
 readonly status:'UNVERIFIED';
 readonly authenticatedOfficialPublication:false;
 readonly grantsLegalCurrent:false;
 readonly reason:string;
};
const deny=(reason:string):DouConfazTraceResult=>({
 status:'UNVERIFIED',authenticatedOfficialPublication:false,
 grantsLegalCurrent:false,reason
});
export function preflightDouConfazTrace(input:{
 sourceCode:string;publication:ConnectorPublication;parent?:ConnectorPublication;
}):DouConfazTraceResult{
 const p=input.publication;
 if(input.sourceCode!=='dou'||p.agency!=='CONFAZ'||p.sphere!=='FEDERAL'||
   !families.has(p.actType??'')||!p.actNumber||!p.content||!p.officialUrl)
   return deny('NOT_DOU_CONFAZ_ACT');
 const m=obj(p.metadata),d=obj(m?.dou);
 if(m?.ingestionChannel!=='INLABS'||!d)
   return deny('DOU_METADATA_MISSING');
 const embedded=d.embeddedAct===true;
 if(d.embeddedAct!==undefined&&!embedded)
   return deny('DOU_EMBEDDED_FLAG_INVALID');
 const parent=embedded?input.parent:p;
 const pm=obj(parent?.metadata),pd=obj(pm?.dou);
 if(!parent||!parent.content||!parent.externalId||
   parent.agency!=='CONFAZ'||parent.sphere!=='FEDERAL'||
   pm?.ingestionChannel!=='INLABS'||!pd)
   return deny('DOU_DISPATCH_PARENT_REQUIRED');
 if(embedded&&(
   parent.actType?.toUpperCase()!=='DESPACHO'||pd.embeddedAct===true||
   d.parentMatterExternalId!==parent.externalId||
   d.embeddedHeading!==p.title||!Number.isSafeInteger(d.embeddedIndex)||
   Number(d.embeddedIndex)<1||
   p.externalId!==parent.externalId+':embedded:'+p.actType+':'+p.actNumber||
   !parent.content.includes(p.content)||!p.content.startsWith(p.title)
 )) return deny('DOU_PARENT_CHILD_MISMATCH');
 // Do not trust a caller's hand-cut child span, even if it is a substring of
 // the official-looking dispatch. Reparse the complete parent under the same
 // deterministic rules as ingestion and compare *every* boundary and field.
 if(embedded){
  const derived=extractEmbeddedConfazPublications(parent).find(item=>
   item.externalId===p.externalId);
  const dm=obj(derived?.metadata),dd=obj(dm?.dou);
  if(!derived||derived.title!==p.title||derived.content!==p.content||
    derived.actNumber!==p.actNumber||derived.actType!==p.actType||
    derived.publishedAt?.toISOString()!==p.publishedAt?.toISOString()||
    dd?.embeddedIndex!==d.embeddedIndex||dd?.parentMatterExternalId!==d.parentMatterExternalId)
   return deny('DOU_EMBEDDED_EXACT_REPARSE_MISMATCH');
 }
 const date=str(pd.publicationDate),section=str(pd.section),
  edition=str(pd.edition),matter=str(pd.officialMatterId);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||
   Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||
   !sections.has(section)||!/^\d+$/.test(edition)||!/^\d+$/.test(matter)||
   parent.externalId!==date+':'+section+':'+edition+':'+matter)
   return deny('DOU_EDITION_IDENTITY_INVALID');
 if(embedded&&(d.publicationDate!==date||d.section!==section||
    d.edition!==edition||d.officialMatterId!==matter||
    JSON.stringify(d.archive)!==JSON.stringify(pd.archive)))
   return deny('DOU_EMBEDDED_ARCHIVE_NOT_BOUND');
 const archive=obj(pd.archive),filename=date+'-'+section+'.zip';
 if(!archive||archive.date!==date||archive.section!==section||
   archive.filename!==filename||!hex.test(str(archive.rawSha256))||
   !officialZip(str(archive.officialUrl),date,filename))
   return deny('DOU_ARCHIVE_REFERENCE_INVALID');
 const pages=pd.certifiedPageUrls;
 if(!Array.isArray(pages)||!pages.length||
   pages.some(url=>typeof url!=='string'||!certifiedPage(url,date))||
   !pages.includes(parent.officialUrl)||p.officialUrl!==parent.officialUrl)
   return deny('DOU_CERTIFIED_PAGE_REFERENCE_INVALID');
 const parts=pd.parts;
 if(!Array.isArray(parts)||parts.length<1||parts.length>48)
   return deny('DOU_XML_PARTS_MISSING');
 const digests:string[]=[];
 const seen=new Set<string>();
 for(const part of parts){
  const entry=obj(part),attrs=obj(entry?.attributes);
  const name=str(entry?.filename);
  const strictFilename=new RegExp('^[0-9]+_'+date.replaceAll('-','')+'_'+matter+'(?:-[0-9]+)?\\.xml$');
  if(!entry||!attrs||!hex.test(str(entry.rawSha256))||
    !Number.isSafeInteger(entry.sizeBytes)||Number(entry.sizeBytes)<1||
    !strictFilename.test(name)||seen.has(name)||
    attrs.idMateria!==matter||attrs.pubName!==section||
    attrs.pubDate!==date.split('-').reverse().join('/')||
    attrs.editionNumber!==edition||!pages.includes(attrs.pdfPage)||
    new URL(str(attrs.pdfPage)).searchParams.get('jornal')!==name.split('_')[0])
    return deny('DOU_XML_PART_IDENTITY_INVALID');
  seen.add(name);digests.push(str(entry.rawSha256));
 }
 return {
  status:'DOU_XML_TRACE_ONLY',authenticatedOfficialPublication:false,
  grantsLegalCurrent:false,sourceCode:'dou',publicationDate:date,
  section,edition,officialMatterId:matter,
  certifiedPageUrl:parent.officialUrl,archiveUrl:str(archive.officialUrl),
  archiveSha256:str(archive.rawSha256),xmlPartSha256:digests,
  embedded,parentExternalId:parent.externalId,
  parentTextSha256:createHash('sha256').update(parent.content,'utf8').digest('hex'),
  outstandingGates:[
   'INDEPENDENT_CERTIFIED_DOU_PUBLICATION_VALIDATION',
   'AUTHENTICATED_XML_TO_CERTIFIED_TEXT_CORRESPONDENCE',
   'INDEPENDENT_LEGAL_EFFECTIVITY_ATTESTATION'
  ]
 };
}
