/**
 * TAX13 R8-02: isolated historical DOU import intake, pre-database.
 *
 * Operator-uploaded files, transcriptions and third-party links are UNTRUSTED.
 * This component computes checksums, bounds memory and checks identity fields;
 * it NEVER verifies historical custody, authenticates the DOU, determines
 * vigency, creates signed receipts or grants legal CURRENT.
 *
 * An administrator can submit the SAME candidate through automatic acquisition
 * or manual upload; neither channel gains extra evidentiary authority.
 * No raw files are returned for database persistence. Callers must pass
 * a separate, versioned, reviewed workflow before storing anything.
 */
import { createHash } from 'node:crypto';

export type HistoricalAcquisitionChannel = 'AUTO' | 'MANUAL';
export type HistoricalMaterialKind = 'DOU_HISTORICAL_SCAN' | 'TEXT_TRANSCRIPTION' | 'OFFICIAL_TEXT_MIRROR';
export type HistoricalMediaType = 'application/pdf' | 'text/plain' | 'text/html' | 'image/png' | 'image/jpeg';
export interface HistoricalDouIntakeInput {
  acquisitionChannel: HistoricalAcquisitionChannel;
  materialKind: HistoricalMaterialKind;
  mediaType: HistoricalMediaType;
  actFamily: 'CONVÊNIO ICMS' | 'AJUSTE SINIEF' | 'PROTOCOLO ICMS' | 'ATO COTEPE/ICMS';
  /** e.g. "52/91" or "100/1997". */
  actNumber: string;
  douPublishedOn: string;
  section: 'DO1' | 'DO1E';
  page?: number;
  /**
   * A user-observed historic archive pointer, not proof of the actual edition.
   * Index links are allowed for triage but explicitly remain INDEX_ONLY.
   */
  sourceUrl?: string;
  /** Original file bytes supplied to this bounded intake (never persisted here). */
  fileBytes?: Uint8Array;
  /** A typed legal transcription; not interchangeable with official source bytes. */
  transcription?: string;
  originalFilename?: string;
}
export type HistoricalDouIntakeResult = {
  readonly status: 'HISTORICAL_SOURCE_CANDIDATE' | 'UNVERIFIED';
  readonly authenticatedOfficialPublication: false;
  readonly grantsLegalCurrent: false;
  readonly legalVigency: 'UNVERIFIED';
  readonly reason: string;
  readonly candidate?: {
    readonly acquisitionChannel: HistoricalAcquisitionChannel;
    readonly materialKind: HistoricalMaterialKind;
    readonly mediaType: HistoricalMediaType;
    readonly actFamily: HistoricalDouIntakeInput['actFamily'];
    readonly canonicalActNumber: string;
    readonly douPublishedOn: string;
    readonly section: 'DO1' | 'DO1E';
    readonly page: number | null;
    readonly sourceUrl: string | null;
    readonly sourceReferenceLevel: 'MISSING' | 'INDEX_ONLY' | 'DOCUMENT_POINTER_UNVERIFIED';
    readonly fileSha256: string | null;
    readonly fileSizeBytes: number | null;
    readonly transcriptionSha256: string | null;
    readonly transcriptionLength: number;
    readonly outstandingGates: readonly string[];
  };
};
const fail=(reason:string):HistoricalDouIntakeResult=>({
  status:'UNVERIFIED',authenticatedOfficialPublication:false,
  grantsLegalCurrent:false,legalVigency:'UNVERIFIED',reason
});
const TYPES:Readonly<Record<HistoricalMaterialKind,readonly HistoricalMediaType[]>>={
  DOU_HISTORICAL_SCAN:['application/pdf','image/png','image/jpeg'],
  TEXT_TRANSCRIPTION:['text/plain','text/html'],
  OFFICIAL_TEXT_MIRROR:['text/plain','text/html']
};
const MAX_FILE_BYTES=16*1024*1024;
const MAX_TRANSCRIPTION_CHARS=200_000;
function validDate(value:string):boolean{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const dt=new Date(value+'T00:00:00.000Z');
  return !Number.isNaN(dt.getTime())&&dt.toISOString().slice(0,10)===value;
}
function sourceReference(urlText:string|undefined):{
  url:string|null;level:'MISSING'|'INDEX_ONLY'|'DOCUMENT_POINTER_UNVERIFIED';
}|null{
  if(urlText===undefined||urlText==='')return {url:null,level:'MISSING'};
  try{
    if(urlText.length>2048)return null;
    const u=new URL(urlText);
    const allow=['incombeta.in.gov.br','imprensa2.in.gov.br','pesquisa.in.gov.br','www.in.gov.br'];
    if(u.protocol!=='https:'||!allow.includes(u.hostname)||
      !!u.username||!!u.password||!!u.port||!!u.hash) return null;
    const normalized=u.toString();
    const indexOnly=['/diario-oficial-da-uniao','/web/dou/dou','/inicio','/'].includes(u.pathname)||
      u.pathname.endsWith('/diario-oficial-da-uniao');
    return {url:normalized,level:indexOnly?'INDEX_ONLY':'DOCUMENT_POINTER_UNVERIFIED'};
  }catch{return null;}
}
export function preflightHistoricalDouIntake(input:HistoricalDouIntakeInput):HistoricalDouIntakeResult{
  if(!input||!['AUTO','MANUAL'].includes(input.acquisitionChannel)||
    !Object.prototype.hasOwnProperty.call(TYPES,input.materialKind)||
    !TYPES[input.materialKind].includes(input.mediaType)||
    !['CONVÊNIO ICMS','AJUSTE SINIEF','PROTOCOLO ICMS','ATO COTEPE/ICMS'].includes(input.actFamily)||
    !['DO1','DO1E'].includes(input.section))
    return fail('HISTORICAL_INTAKE_UNSUPPORTED_TYPE');
  const m=/^([1-9]\d{0,5})\/(\d{2}|\d{4})$/.exec(input.actNumber);
  if(!m)return fail('HISTORICAL_INTAKE_ACT_NUMBER_INVALID');
  const yearText=m[2]!;
  const publishedYear=Number(String(input.douPublishedOn).slice(0,4));
  const resolvedTwoDigitYear=Math.floor(publishedYear/100)*100+Number(yearText);
  const year=yearText.length===2
    ? resolvedTwoDigitYear>publishedYear?resolvedTwoDigitYear-100:resolvedTwoDigitYear
    : Number(yearText);
  if(year<1808||year>2001||!validDate(input.douPublishedOn)||
    input.douPublishedOn<'1808-01-01'||input.douPublishedOn>'2001-12-31'||
    year>Number(input.douPublishedOn.slice(0,4)))
    return fail('HISTORICAL_INTAKE_DATE_OR_YEAR_INVALID');
  if(input.page!==undefined&&(!Number.isSafeInteger(input.page)||input.page<1||input.page>1_000_000))
    return fail('HISTORICAL_INTAKE_PAGE_INVALID');
  if(input.originalFilename!==undefined&&(
     input.originalFilename.length>180||
     /[/\\\u0000-\u001f\u007f\u202a-\u202e]/.test(input.originalFilename)))
    return fail('HISTORICAL_INTAKE_FILENAME_INVALID');
  const source=sourceReference(input.sourceUrl);
  if(!source)return fail('HISTORICAL_INTAKE_SOURCE_URL_REJECTED');
  const hasBytes=input.fileBytes!==undefined;
  const bytes=input.fileBytes;
  if(hasBytes&&(!(bytes instanceof Uint8Array)||bytes!.byteLength===0||
     bytes!.byteLength>MAX_FILE_BYTES))
    return fail('HISTORICAL_INTAKE_FILE_SIZE_INVALID');
  const transcript=input.transcription;
  if(transcript!==undefined&&(!transcript.trim()||transcript.length>MAX_TRANSCRIPTION_CHARS||
    /\u0000/.test(transcript)))
    return fail('HISTORICAL_INTAKE_TRANSCRIPTION_INVALID');
  if(!hasBytes&&transcript===undefined&&!source.url)
    return fail('HISTORICAL_INTAKE_NO_EVIDENCE_REFERENCE');
  if(input.materialKind==='DOU_HISTORICAL_SCAN'&&!hasBytes&&!source.url)
    return fail('HISTORICAL_INTAKE_SCAN_FILE_OR_REFERENCE_REQUIRED');
  if(input.materialKind!=='DOU_HISTORICAL_SCAN'&&!transcript)
    return fail('HISTORICAL_INTAKE_TEXT_REQUIRED');
  // Magic-byte check is only basic format hygiene, never signature validation.
  if(hasBytes&&input.mediaType==='application/pdf'&&
    Buffer.from(bytes!).subarray(0,5).toString('ascii')!=='%PDF-')
    return fail('HISTORICAL_INTAKE_NOT_PDF');
  if(hasBytes&&input.mediaType==='image/png'&&
    Buffer.from(bytes!).subarray(0,8).toString('hex')!=='89504e470d0a1a0a')
    return fail('HISTORICAL_INTAKE_NOT_PNG');
  if(hasBytes&&input.mediaType==='image/jpeg'&&
    !(bytes![0]===0xff&&bytes![1]===0xd8&&bytes![2]===0xff))
    return fail('HISTORICAL_INTAKE_NOT_JPEG');
  const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
  return {
    status:'HISTORICAL_SOURCE_CANDIDATE',authenticatedOfficialPublication:false,
    grantsLegalCurrent:false,legalVigency:'UNVERIFIED',
    reason:'HISTORICAL_DOCUMENT_NEEDS_INDEPENDENT_ARCHIVE_AUTHENTICATION',
    candidate:{
      acquisitionChannel:input.acquisitionChannel,materialKind:input.materialKind,
      mediaType:input.mediaType,actFamily:input.actFamily,
      canonicalActNumber:Number(m[1])+'/'+year,douPublishedOn:input.douPublishedOn,
      section:input.section,page:input.page??null,sourceUrl:source.url,
      sourceReferenceLevel:source.level,
      fileSha256:bytes?sha(bytes):null,fileSizeBytes:bytes?.byteLength??null,
      transcriptionSha256:transcript?sha(transcript):null,
      transcriptionLength:transcript?.length??0,
      outstandingGates:[
        'OFFICIAL_HISTORICAL_DOU_EDITION_LOCATED',
        'INDEPENDENT_ARCHIVAL_CUSTODY_AUTHENTICATION',
        'PRECISE_DOCUMENT_TO_ACT_TEXT_MATCH',
        'INDEPENDENT_LEGAL_EFFECTIVITY_REVIEW'
      ]
    }
  };
}
