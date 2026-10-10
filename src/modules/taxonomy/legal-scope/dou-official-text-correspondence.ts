/**
 * Trifaros TAX13-R8-02: deterministic, bounded PDF text vs INLABS act match.
 *
 * Checks input CONTENT, not PDF signing certificates. This module does not
 * extract PDF text or fetch a URL: caller must use bytes from the controlled
 * official HTTPS DOU collector and a deterministic PDF text extractor.
 * Even complete identity match NEVER proves legal vigency or CURRENT.
 */
import type {ConnectorPublication} from '../../collection/connector.contract.js';
import {douHtmlText} from '../../collection/dou.parser.js';
import {preflightDouConfazTrace,type DouConfazTrace} from './dou-source-custody-preflight.js';
import type {OfficialDouPdfSourceCapture} from './dou-official-http-pdf-capture.js';

const MAX_PDF_TEXT_CHARS=300_000;
const MAX_ACT_TEXT_CHARS=120_000;
type Rejected={readonly status:'UNVERIFIED';readonly reason:string;readonly grantsLegalCurrent:false};
export type DouPdfActTextCorrelation=Rejected|{
 readonly status:'DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY';
 readonly grantsLegalCurrent:false;
 readonly legalEffectivity:'UNVERIFIED';
 readonly actType:string;
 readonly actNumber:string;
 readonly parentExternalId:string;
 readonly editionPrinted:string;
 readonly officialMatterId:string;
 readonly originalPdfSha256:string;
};
const reject=(reason:string):Rejected=>({status:'UNVERIFIED',reason,grantsLegalCurrent:false});
function normalized(input:string):string{
 return input.replace(/N[º°o]\.?\s*(?=\d)/gi,'N ')
  .normalize('NFKC')
  .replace(/\u00a0/g,' ')
  .replace(/N[º°]\.?\s*/gi,'N ')
  .replace(/[‐‑‒–—]/g,'-')
  .replace(/\s+/g,' ').trim().toLocaleUpperCase('pt-BR');
}
function legalText(value:string):string{
 if(/<\/?[a-z][\s>]/i.test(value))return douHtmlText(value);
 return value;
}
/** Only exact full act text, never an incidental title/citation, can match. */
export function correlateOfficialDouPdfActText(input:{
 trace:DouConfazTrace;
 sourceCapture:OfficialDouPdfSourceCapture;
 parent:ConnectorPublication;
 act:ConnectorPublication;
 pdfExtractedText:string;
 printedEdition:string;
}):DouPdfActTextCorrelation{
 if(!input||input.trace?.status!=='DOU_XML_TRACE_ONLY'||
   input.sourceCapture?.status!=='OFFICIAL_DOU_PDF_SOURCE_CAPTURED'||
   input.sourceCapture.grantsLegalCurrent!==false)
  return reject('DOU_OFFICIAL_SOURCE_CAPTURE_REQUIRED');
 const {trace,sourceCapture,parent,act,pdfExtractedText,printedEdition}=input;
 const cand=sourceCapture.preflight.candidate;
 if(sourceCapture.preflight.status!=='DOU_PDF_BYTES_BOUND_ONLY'||
    !cand||sourceCapture.preflight.grantsLegalCurrent!==false||
    !/^[a-f0-9]{64}$/.test(cand.pdfSha256)||
    cand.parentExternalId!==trace.parentExternalId||
    cand.officialMatterId!==trace.officialMatterId||
    cand.referenceDate!==trace.publicationDate||
    cand.archiveSha256!==trace.archiveSha256||
    cand.sourceUrl!==sourceCapture.requestUrl)
  return reject('DOU_PDF_SOURCE_TRACE_MISMATCH');
 const derived=preflightDouConfazTrace({sourceCode:'dou',publication:act,parent});
 if(derived.status!=='DOU_XML_TRACE_ONLY'||
    !derived.embedded||!trace.embedded||
    derived.parentExternalId!==trace.parentExternalId||
    derived.parentTextSha256!==trace.parentTextSha256||
    derived.archiveSha256!==trace.archiveSha256||
    derived.section!==trace.section||derived.edition!==trace.edition||
    derived.publicationDate!==trace.publicationDate||
    derived.xmlPartSha256.join(',')!==trace.xmlPartSha256.join(',')||
    derived.officialMatterId!==trace.officialMatterId||
    derived.certifiedPageUrl!==trace.certifiedPageUrl)
  return reject('DOU_PARENT_ACT_TRACE_MISMATCH');
 if(typeof pdfExtractedText!=='string'||pdfExtractedText.length<160||
    pdfExtractedText.length>MAX_PDF_TEXT_CHARS||
    typeof printedEdition!=='string'||
    !/^[0-9]{1,4}(?:-[A-Z])?$/.test(printedEdition))
  return reject('DOU_PDF_TEXT_OR_EDITION_INVALID');
 // Numeric INLABS edition alone cannot distinguish regular from Extra A/B.
 // Require an explicit printed extra suffix; the index-to-suffix binding
 // remains a separate SOURCE gate, not inferred from the bare edition.
 const isExtra=trace.section.endsWith('E');
 if(isExtra ? !new RegExp('^'+trace.edition+'-[A-Z]$').test(printedEdition)
   : printedEdition!==trace.edition)
  return reject('DOU_PRINTED_EDITION_DIFFERS_FROM_INLABS');
 const text=normalized(pdfExtractedText);
 const section=trace.section;
 if(!text.includes('DIARIO OFICIAL')&&!text.includes('DIÁRIO OFICIAL'))
  return reject('DOU_PDF_MASTHEAD_MISSING');
 if(section.endsWith('E')&&!text.includes('EDIÇÃO EXTRA'))
  return reject('DOU_EXTRA_EDITION_MARKER_MISSING');
 // Read the *first* printed edition after the actual masthead, not a
 // second edition cited later in the dispatch or legal body.
 const mastheadAt=text.indexOf('DIÁRIO OFICIAL')>=0?
  text.indexOf('DIÁRIO OFICIAL'):text.indexOf('DIARIO OFICIAL');
 const parentHeadingInPdf=text.indexOf(normalized(parent.title),mastheadAt);
 const masthead=text.slice(mastheadAt,Math.min(
  mastheadAt+450,parentHeadingInPdf>=0?parentHeadingInPdf:mastheadAt+450,
 ));
 const firstEdition=masthead.match(/\bN\s+([0-9]{1,4}(?:-[A-Z])?)\b/);
 if(!firstEdition||firstEdition[1]!==printedEdition)
  return reject('DOU_WRONG_PRINTED_EDITION');
 // Edition date must be printed near the actual masthead, not cited inside
 // a later legal provision. INLABS date alone is not a PDF-content check.
 const [year,month,day]=trace.publicationDate.split('-');
 const monthNames=['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
  'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
 const longDate=new RegExp('\\b'+String(Number(day))+'\\s+DE\\s+'+
  monthNames[Number(month)-1]+'\\s+DE\\s+'+year+'\\b');
 const numericDate=new RegExp('\\b'+day+'\\s*[/.-]\\s*'+month+
  '\\s*[/.-]\\s*'+year+'\\b');
 if(!longDate.test(masthead)&&!numericDate.test(masthead))
  return reject('DOU_WRONG_PRINTED_DATE');
 const parentHeading=normalized(parent.title);
 const actHeading=normalized(act.title);
 const actContent=act.content?normalized(legalText(act.content)):'';
 if(!parentHeading||!actHeading||actContent.length<120||
    actContent.length>MAX_ACT_TEXT_CHARS||
    !actContent.includes(actHeading))
  return reject('DOU_NORMATIVE_ACT_TEXT_INCOMPLETE');
 const parentAt=text.indexOf(parentHeading);
 const actAt=text.indexOf(actHeading,parentAt<0?0:parentAt+parentHeading.length);
 if(parentAt<0||actAt<parentAt+parentHeading.length)
  return reject('DOU_DISPATCH_OR_ACT_HEADING_MISSING');
 if(!text.includes(actContent,actAt))
  return reject('DOU_WHOLE_ACT_TEXT_MISMATCH');
 return {
  status:'DOU_PDF_ACT_TEXT_CORRESPONDS_ONLY',grantsLegalCurrent:false,
  legalEffectivity:'UNVERIFIED',actType:act.actType??'',actNumber:act.actNumber??'',
  parentExternalId:trace.parentExternalId,editionPrinted:printedEdition,
  officialMatterId:trace.officialMatterId,originalPdfSha256:cand.pdfSha256,
 };
}
