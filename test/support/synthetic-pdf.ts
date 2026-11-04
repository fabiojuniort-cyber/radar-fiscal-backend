/**
 * ANAT-PDF-01 test helper: build a minimal, valid PDF from synthetic lines (Helvetica, WinAnsiEncoding, so Portuguese
 * accents are single Latin-1 bytes). Each line is drawn at an explicit (x, y) so tests can scramble the drawing order
 * and check that the reader restores reading order. `pages: []` (or a page with no lines) gives a PDF without text.
 * Synthetic content only; never official text.
 */
export interface SyntheticLine { text: string; x?: number; y: number }

const esc = (s: string) => s.replace(/[\\()]/gu, (c) => `\\${c}`);

/** `imagePages` (0-based) also paint a 1×1 gray image XObject on those pages (an image without a text layer). */
export function buildSyntheticPdf(pages: SyntheticLine[][], opts: { imagePages?: number[] } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const image = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream');
  const pagesId = objects.length + 1 + pages.length * 2 + 0; // placeholder, fixed below
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  pages.forEach((lines, index) => {
    const img = opts.imagePages?.includes(index) ? ['q 200 0 0 200 72 400 cm /Im1 Do Q'] : [];
    const stream = [...img, ...lines.map((l) => `BT /F1 11 Tf ${l.x ?? 72} ${l.y} Td (${esc(l.text)}) Tj ET`)].join('\n');
    const bytes = Buffer.from(stream, 'latin1');
    contentIds.push(add(`<< /Length ${bytes.length} >>\nstream\n${stream}\nendstream`));
    pageIds.push(add('PAGE'));
  });
  const pagesObj = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach((pid, i) => {
    objects[pid - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
  });
  void pagesId;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
