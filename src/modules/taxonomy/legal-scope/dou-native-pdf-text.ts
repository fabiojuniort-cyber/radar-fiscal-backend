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
};

const fail=(reason:string):DouOnePageNativePdfText=>({status:'UNVERIFIED',reason});
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
  let text='';
  for(const item of tc.items){
   if(!('str' in item))continue;
   text+=item.str+(item.hasEOL?'\n':'');
   if(text.length>MAX_NATIVE_TEXT_CHARS)return fail('DOU_PDF_TEXT_TOO_LARGE');
  }
  page.cleanup();
  text=text.replace(/\r/g,'').replace(/[\t\u00a0]+/g,' ').trim();
  if(text.length<120)return fail('DOU_PDF_TEXT_EMPTY_OR_INCOMPLETE');
  return {status:'PDF_NATIVE_TEXT_EXTRACTED',text,reason:'DOU_NATIVE_TEXT_ONLY',pageCount:1};
 }catch{
  return fail('DOU_PDF_NATIVE_TEXT_EXTRACTION_FAILED');
 }finally{
  if(task)await task.destroy().catch(()=>undefined);
 }
}
