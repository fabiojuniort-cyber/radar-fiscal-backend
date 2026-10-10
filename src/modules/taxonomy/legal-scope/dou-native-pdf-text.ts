/**
 * Trifaros: bounded native-text extraction from the SAME official DOU PDF
 * bytes previously checked by the official HTTPS collector. No ICP/cert
 * validation; no OCR, browser, filesystem or network. Exactly one page.
 */
const MAX_PDF_BYTES=20*1024*1024;
const MAX_NATIVE_TEXT_CHARS=300_000;
let pdfJsPromise:Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>|undefined;
const getPdfJs=()=>pdfJsPromise ??=
 import('pdfjs-dist/legacy/build/pdf.mjs').catch(e=>{pdfJsPromise=undefined;throw e;});

export type DouOnePageNativePdfText={
 readonly status:'PDF_NATIVE_TEXT_EXTRACTED'|'UNVERIFIED';
 readonly text?:string;
 readonly reason:string;
 readonly pageCount?:number;
 readonly extractorVersion?:'PDFJS_NATIVE_SPATIAL_V2';
};

const fail=(reason:string):DouOnePageNativePdfText=>({status:'UNVERIFIED',reason});

/**
 * Native PDF text order is NOT guaranteed by pdf.js. Merge text fragments
 * using their physical positions. Ambiguous backwards/upward ordering
 * fails closed instead of silently asserting legal textual completeness.
 * This is a synthetic-testable layout heuristic, not a legal proof.
 */
export type DouPdfTextItem={
 readonly str:string; readonly hasEOL?:boolean;
 readonly transform?:readonly number[]; readonly width?:number;
};
export function assembleDouPdfTextItems(items:readonly DouPdfTextItem[]):
 {status:'TEXT_ASSEMBLED';text:string}|{status:'UNVERIFIED';reason:string}{
 let text='';
 let previous:{x:number;y:number;right:number}|null=null;
 let previousEndedLine=false;
 for(const item of items){
  if(typeof item.str!=='string')return {status:'UNVERIFIED',reason:'DOU_PDF_TEXT_ITEM_INVALID'};
  const t=item.transform;
  const located=Array.isArray(t)&&t.length>=6&&
   Number.isFinite(t[4])&&Number.isFinite(t[5])&&
   Number.isFinite(item.width)&&item.width!>=0;
  const current=located?{x:t![4]!,y:t![5]!,right:t![4]!+item.width!}:null;
  if(text.length&&item.str){
   let separator='';
   if(previousEndedLine)separator='';
   else if(current&&previous){
    if(current.y>previous.y+3||
       (Math.abs(current.y-previous.y)<=3&&current.x<previous.x-3))
      return {status:'UNVERIFIED',reason:'DOU_PDF_TEXT_ORDER_AMBIGUOUS'};
    if(current.y<previous.y-3)separator='\n';
    else if(current.x-previous.right>1.5)separator=' ';
    else if(current.x-previous.right<-25)
      return {status:'UNVERIFIED',reason:'DOU_PDF_TEXT_OVERLAP_AMBIGUOUS'};
   }else if(!/\s$/.test(text)&&!/^\s/.test(item.str))separator=' ';
   text+=separator;
  }
  text+=item.str+(item.hasEOL?'\n':'');
  if(text.length>MAX_NATIVE_TEXT_CHARS)
   return {status:'UNVERIFIED',reason:'DOU_PDF_TEXT_TOO_LARGE'};
  previous=item.hasEOL?null:current;
  previousEndedLine=Boolean(item.hasEOL);
 }
 return {status:'TEXT_ASSEMBLED',text};
}
export async function extractDouOnePageNativePdfText(
 bytes:Uint8Array,
):Promise<DouOnePageNativePdfText>{
 if(!(bytes instanceof Uint8Array)||bytes.length<16||
   bytes.length>MAX_PDF_BYTES)return fail('DOU_PDF_TEXT_INPUT_BOUNDS');
 let task;
 try{
  const {getDocument}=await getPdfJs();
  // pdf.js transfers its input: copy to prevent mutation of the source
  // buffer used to compute SHA256 for the original government download.
  task=getDocument({
   data:new Uint8Array(bytes),disableFontFace:true,useSystemFonts:false,
   stopAtErrors:true,verbosity:0,
  });
  const doc=await task.promise;
  if(doc.numPages!==1)return fail('DOU_PDF_TEXT_ONE_PAGE_REQUIRED');
  const page=await doc.getPage(1);
  const tc=await page.getTextContent();
  const items:DouPdfTextItem[]=[];
  for(const item of tc.items){
   if(!('str' in item))continue;
   items.push({str:item.str,hasEOL:item.hasEOL,
    transform:item.transform,width:item.width});
  }
  const result=assembleDouPdfTextItems(items);
  page.cleanup();
  if(result.status!=='TEXT_ASSEMBLED')return fail(result.reason);
  const text=result.text.replace(/\r/g,'').replace(/[\t\u00a0]+/g,' ').trim();
  if(text.length<120)return fail('DOU_PDF_TEXT_EMPTY_OR_INCOMPLETE');
  return {status:'PDF_NATIVE_TEXT_EXTRACTED',text,reason:'DOU_NATIVE_TEXT_ONLY',pageCount:1,
   extractorVersion:'PDFJS_NATIVE_SPATIAL_V2'};
 }catch{
  return fail('DOU_PDF_NATIVE_TEXT_EXTRACTION_FAILED');
 }finally{
  if(task)await task.destroy().catch(()=>undefined);
 }
}
