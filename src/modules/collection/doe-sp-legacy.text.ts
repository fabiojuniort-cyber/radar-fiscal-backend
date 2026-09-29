import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { ConnectorError } from './connector.error.js';

/*
 * Text of one page PDF of the legacy DOE-SP archive (Imprensa Oficial).
 * The PDF is only held in memory: the archive decision (Issue #20,
 * DOE-SP-LEGACY-03) is to persist the text, never the file.
 *
 * Pages from ~2002 on are born-digital (native text). Older pages are scans
 * that the archive already serves with an OCR text layer (ABBYY FineReader /
 * iTextSharp); both are read the same way here and told apart by the page
 * being painted by a full-page raster image.
 */

/** A raster at least this large (pixels) covers a whole scanned page. */
const SCANNED_PAGE_MIN_PIXELS = 2_000_000;

const IMAGE_OPS = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

/** Prodesp certification stamp of the certified download (not part of the page). */
const CERTIFICATION_STAMP = /P[áa]gina do Di[áa]rio Oficial certificada[\s\S]*$/i;

export type DoeSpLegacyTextExtraction = 'PDF_NATIVE_TEXT' | 'PDF_EMBEDDED_OCR' | 'EMPTY';

export interface DoeSpLegacyPageText {
  text: string;
  pageCount: number;
  /** The page is a scan (full-page raster); its text comes from an OCR layer. */
  scanned: boolean;
  extraction: DoeSpLegacyTextExtraction;
  largestImagePixels: number;
}

function normalize(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[\t  ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDoeSpLegacyPdfText(bytes: Uint8Array): Promise<DoeSpLegacyPageText> {
  // pdf.js transfers (detaches) the buffer it receives.
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (error) {
      throw new ConnectorError('DOE_SP_LEGACY_INVALID_PDF', {
        code: 'DOE_SP_LEGACY_INVALID_PDF',
        kind: 'PROCESSING_ERROR',
        retryable: false,
        metadata: { cause: error instanceof Error ? error.name : 'unknown' },
      });
    }
    const parts: string[] = [];
    let largestImagePixels = 0;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''));
      const operators = await page.getOperatorList();
      operators.fnArray.forEach((fn, index) => {
        if (!IMAGE_OPS.has(fn)) return;
        const args = operators.argsArray[index] as unknown[] | undefined;
        const width = typeof args?.[1] === 'number' ? args[1] : 0;
        const height = typeof args?.[2] === 'number' ? args[2] : 0;
        largestImagePixels = Math.max(largestImagePixels, width * height);
      });
      page.cleanup();
    }
    const text = normalize(parts.join('\n').replace(CERTIFICATION_STAMP, ''));
    const scanned = largestImagePixels >= SCANNED_PAGE_MIN_PIXELS;
    return {
      text,
      pageCount: doc.numPages,
      scanned,
      extraction: !text ? 'EMPTY' : scanned ? 'PDF_EMBEDDED_OCR' : 'PDF_NATIVE_TEXT',
      largestImagePixels,
    };
  } finally {
    await task.destroy();
  }
}
