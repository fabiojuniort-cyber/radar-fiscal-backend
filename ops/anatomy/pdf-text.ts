/**
 * ANAT-OFFICIAL-01 R2-04: traceable text of a PDF snapshot, for binding an official sample to its binary original.
 * Same reading order and joining rule as src/modules/anatomy/pdf-reader.ts (R2): baseline tolerance 2pt, top→bottom,
 * left→right; one space inserted between runs only when neither side already has whitespace; lines joined by "\n". The binary hash stays the identity of the original; this text is
 * a derived, re-computable view whose hash is recorded as `extraction.textSha256` in the snapshot metadata.
 */
export const PDF_TEXT_TOOL = 'pdfjs-dist@6.3.289/lines-v2';

interface TextItem { str: string; transform: number[] }

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const out: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const items = ((await page.getTextContent()).items as TextItem[]).filter((i) => typeof i.str === 'string' && i.str.length > 0);
      const rows: { y: number; runs: { x: number; str: string }[] }[] = [];
      for (const it of items) {
        const x = it.transform[4] ?? 0; const y = it.transform[5] ?? 0;
        const row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (row) row.runs.push({ x, str: it.str }); else rows.push({ y, runs: [{ x, str: it.str }] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) { const t = r.runs.sort((a, b) => a.x - b.x).map((run) => run.str).reduce((acc, run) => (acc && !/\s$/u.test(acc) && !/^\s/u.test(run) ? `${acc} ${run}` : acc + run), ''); if (t.trim()) out.push(t); }
      page.cleanup();
    }
  } finally { await doc.cleanup(); }
  return out.join('\n');
}
