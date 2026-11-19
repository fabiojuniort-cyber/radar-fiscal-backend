import { createHash } from 'node:crypto';
import { readAnatomyInput, type AnatomyReaderInput, type AnatomyReaderResult } from './readers.js';

/**
 * ANAT-PDF-01: read a PDF with a text layer into the anatomy. The PDF text is extracted line by line in reading order
 * (top→bottom, left→right per page). The reader itself edits nothing: no hyphen joining, no whitespace collapsing, no
 * trimming. The only text it adds is ONE space between two runs of the same line, and only when neither side already
 * has whitespace at that boundary. Fidelity limit (R2, measured): pdfjs-dist's text layer itself reports a run of
 * spaces inside the drawn text as a single space ("A  B" → "A B"), so repeated spaces of the original drawing are NOT
 * preserved by this reader; this is documented and tested, not hidden. Lines are handed to the structural reader. Every source pointer is
 * rewritten to the PDF origin: representation 'attachment', locator `pdf:sha256=<file>;page=<n>;line=<m>`, so each
 * passage is traceable to page and line without a contract change. A PDF without a text layer (scanned) yields no
 * invented text: the result carries the limitation `pdf_without_text_layer` (OCR is outside this reader).
 * R2-05 (R3): coverage is assessed PER PAGE from the page's operator list, never from the text alone. Visual content is
 * any image paint, shading fill, or path that is actually painted (fill/stroke; a clip-only path is not). States:
 *   `text`              text and no visual content: complete;
 *   `text_with_visual`  text AND visual content: the visual part is unread → limitation `pdf_page_visual_not_read`;
 *   `no_text_layer`     visual content and no text: nothing read → limitation `pdf_page_without_text_layer`;
 *   `empty`             neither text nor any painted content: proven empty, reported, not a loss.
 * Any unread page makes the status `partial`. No OCR; visual content is never interpreted.
 */
export interface PdfLine { page: number; line: number; text: string; start: number; end: number }
export type PdfPageState = 'text' | 'text_with_visual' | 'no_text_layer' | 'empty';
export interface PdfReadResult extends AnatomyReaderResult { pdf: { sha256: string; pages: number; lines: PdfLine[]; pageCoverage: { page: number; state: PdfPageState }[] } }

interface TextItem { str: string; transform: number[]; width: number; hasEOL?: boolean }

/** Extract the text layer as lines, in reading order. Exported for tests. */
export async function extractPdfLines(bytes: Uint8Array): Promise<{ pages: number; lines: Omit<PdfLine, 'start' | 'end'>[]; pageCoverage: { page: number; state: PdfPageState }[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const lines: Omit<PdfLine, 'start' | 'end'>[] = [];
  const pageCoverage: { page: number; state: PdfPageState }[] = [];
  const O = pdfjs.OPS as Record<string, number>;
  const PAINT = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageXObjectRepeat', 'paintImageMaskXObjectGroup',
    'paintImageMaskXObjectRepeat', 'paintInlineImageXObjectGroup', 'paintSolidColorImageMask', 'shadingFill', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke',
    'closeFillStroke', 'closeEOFillStroke', 'stroke', 'closeStroke'].map((k) => O[k]).filter((v): v is number => typeof v === 'number'));
  const hasVisual = (fnArray: number[], argsArray: unknown[]): boolean => fnArray.some((f, i) =>
    PAINT.has(f) || (f === O.constructPath && (argsArray[i] as unknown[] | undefined)?.[0] !== O.endPath));
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = (content.items as TextItem[]).filter((i) => typeof i.str === 'string' && i.str.length > 0);
      // Group runs by baseline (y), tolerance 2pt; order lines top→bottom and runs left→right.
      const rows: { y: number; runs: { x: number; str: string }[] }[] = [];
      for (const it of items) {
        const x = it.transform[4] ?? 0; const y = it.transform[5] ?? 0;
        const row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (row) row.runs.push({ x, str: it.str }); else rows.push({ y, runs: [{ x, str: it.str }] });
      }
      rows.sort((a, b) => b.y - a.y);
      let m = 0;
      for (const r of rows) {
        const runs = r.runs.sort((a, b) => a.x - b.x).map((run) => run.str);
        const text = runs.reduce((acc, run) => (acc && !/\s$/u.test(acc) && !/^\s/u.test(run) ? `${acc} ${run}` : acc + run), '');
        if (text.trim()) lines.push({ page: n, line: ++m, text });
      }
      const ops = await page.getOperatorList();
      const visual = hasVisual(ops.fnArray, ops.argsArray);
      pageCoverage.push({ page: n, state: m > 0 ? (visual ? 'text_with_visual' : 'text') : (visual ? 'no_text_layer' : 'empty') });
      page.cleanup();
    }
    return { pages: doc.numPages, lines, pageCoverage };
  } finally { await doc.cleanup(); }
}

const escapeHtml = (t: string) => t.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export async function readPdfInput(bytes: Uint8Array, input: Omit<AnatomyReaderInput, 'html' | 'text'>): Promise<PdfReadResult> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { pages, lines, pageCoverage } = await extractPdfLines(bytes);
  // Each extracted line becomes one block, so the existing structural grammar applies; the text is escaped, not edited.
  const html = lines.length ? `<html><body>${lines.map((l) => `<p>${escapeHtml(l.text)}</p>`).join('')}</body></html>` : '';
  const result = (html ? readAnatomyInput({ ...input, html }) : readAnatomyInput({ ...input, text: '' })) as PdfReadResult;
  // Locate each PDF line in the canonical text (sequential, exact match), so page/line ↔ offsets are verifiable.
  const mapped: PdfLine[] = []; let cursor = 0;
  for (const l of lines) {
    const start = result.canonicalText.indexOf(l.text, cursor);
    if (start < 0) { result.limitations.push({ code: 'pdf_line_not_located', message: `PDF page ${l.page} line ${l.line} not found verbatim in the canonical text.`, partId: null, span: null }); continue; }
    mapped.push({ ...l, start, end: start + l.text.length }); cursor = start + l.text.length;
  }
  const lineAt = (offset: number) => {
    let lo = 0, hi = mapped.length - 1, found = mapped[0];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (mapped[mid]!.start <= offset) { found = mapped[mid]; lo = mid + 1; } else hi = mid - 1; }
    return found;
  };
  // PDF origin pointer: file hash + page + line of the first character of the span (no character offsets in a PDF).
  const toPdf = <T extends { representation: string; locator: string; sourceSpan: { start: number; end: number } | null }>(ptr: T, at: number): T => {
    const l = mapped.length ? lineAt(at) : undefined;
    return { ...ptr, representation: 'attachment', sourceSpan: null, locator: `pdf:sha256=${sha256};${l ? `page=${l.page};line=${l.line}` : 'page=?'}` };
  };
  for (const part of result.parts) part.sourcePointers = part.sourcePointers.map((ptr) => toPdf(ptr, part.span.start));
  for (const m of result.sourceMap) m.pointer = toPdf(m.pointer, m.span.start);
  if (!lines.length) result.limitations.push({ code: 'pdf_without_text_layer', message: `PDF with ${pages} page(s) and no extractable text layer; OCR is outside this reader, no text was invented.`, partId: null, span: null });
  else for (const pc of pageCoverage) {
    if (pc.state === 'no_text_layer') result.limitations.push({ code: 'pdf_page_without_text_layer', message: `PDF page ${pc.page} has visual content but no extractable text layer; its content was not read (OCR is outside this reader).`, partId: null, span: null });
    else if (pc.state === 'text_with_visual') result.limitations.push({ code: 'pdf_page_visual_not_read', message: `PDF page ${pc.page} has text and also visual content (image or drawing) that was not read; only its text layer is covered.`, partId: null, span: null });
    else continue;
    result.status = 'partial';
  }
  if (!lines.length) result.status = 'partial';
  result.pdf = { sha256, pages, lines: mapped, pageCoverage };
  return result;
}
