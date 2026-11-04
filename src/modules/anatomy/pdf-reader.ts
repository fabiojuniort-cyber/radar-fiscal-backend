import { createHash } from 'node:crypto';
import { readAnatomyInput, type AnatomyReaderInput, type AnatomyReaderResult } from './readers.js';

/**
 * ANAT-PDF-01: read a PDF with a text layer into the anatomy. The PDF text is extracted line by line in reading order
 * (top→bottom, left→right per page) WITHOUT editing it (no hyphen joining, no whitespace collapsing beyond the single
 * space that separates text runs on a line), then handed to the existing plain-text reader. Every source pointer is
 * rewritten to the PDF origin: representation 'attachment', locator `pdf:sha256=<file>;page=<n>;line=<m>`, so each
 * passage is traceable to page and line without a contract change. A PDF without a text layer (scanned) yields no
 * invented text: the result carries the limitation `pdf_without_text_layer` (OCR is outside this reader).
 */
export interface PdfLine { page: number; line: number; text: string; start: number; end: number }
export interface PdfReadResult extends AnatomyReaderResult { pdf: { sha256: string; pages: number; lines: PdfLine[] } }

interface TextItem { str: string; transform: number[]; width: number; hasEOL?: boolean }

/** Extract the text layer as lines, in reading order. Exported for tests. */
export async function extractPdfLines(bytes: Uint8Array): Promise<{ pages: number; lines: Omit<PdfLine, 'start' | 'end'>[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const lines: Omit<PdfLine, 'start' | 'end'>[] = [];
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
        const text = r.runs.sort((a, b) => a.x - b.x).map((run) => run.str).join(' ').replace(/ {2,}/gu, ' ').trimEnd();
        if (text.trim()) lines.push({ page: n, line: ++m, text });
      }
      page.cleanup();
    }
    return { pages: doc.numPages, lines };
  } finally { await doc.cleanup(); }
}

const escapeHtml = (t: string) => t.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export async function readPdfInput(bytes: Uint8Array, input: Omit<AnatomyReaderInput, 'html' | 'text'>): Promise<PdfReadResult> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { pages, lines } = await extractPdfLines(bytes);
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
  result.pdf = { sha256, pages, lines: mapped };
  return result;
}
