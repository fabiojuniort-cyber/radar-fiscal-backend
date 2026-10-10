/**
 * Fully synthetic born-digital, 1-page PDF with wrapped WinAnsi text.
 * Keeps all glyphs inside the page instead of placing a 300-char run beyond
 * the printable right margin. No DOU or externally downloaded bytes included.
 */
export function syntheticWrappedOnePagePdf(text:string):Uint8Array{
 const lines:string[]=[];
 const words=text.replace(/\s+/g,' ').trim().split(' ');
 let line='';
 for(const word of words){
  if(line&&(line.length+word.length+1)>65){
   lines.push(line);line='';
  }
  line=line?line+' '+word:word;
 }
 if(line)lines.push(line);
 if(!lines.length||lines.length>49)throw new Error('PDF_SYNTHETIC_LINES_OUT_OF_BOUNDS');
 const objs:Buffer[]=[];
 const add=(body:string|Buffer):number=>{
  objs.push(Buffer.isBuffer(body)?body:Buffer.from(body,'latin1'));
  return objs.length;
 };
 const esc=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
 add('<< /Type /Catalog /Pages 2 0 R >>');
 add('<< /Type /Pages /Count 1 /Kids [5 0 R] >>');
 add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
 const instructions=['BT /F1 10 Tf 20 800 Td',
  ...lines.flatMap((s)=>[`(${esc(s)}) Tj`,'0 -14 Td']),'ET'].join('\n');
 const stream=Buffer.from(instructions,'latin1');
 add(Buffer.concat([
  Buffer.from(`<< /Length ${stream.length} >>\nstream\n`,'latin1'),
  stream,Buffer.from('\nendstream','latin1'),
 ]));
 add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>');
 const parts=[Buffer.from('%PDF-1.4\n','latin1')];
 let total=parts[0]!.length;
 const offsets=[0];
 for(let i=0;i<objs.length;i++){
  offsets.push(total);
  const item=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`,'latin1'),objs[i]!,Buffer.from('\nendobj\n','latin1')]);
  parts.push(item);total+=item.length;
 }
 parts.push(Buffer.from(`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(off=>String(off).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${total}\n%%EOF\n`,'latin1'));
 return new Uint8Array(Buffer.concat(parts));
}
