/*
 * Shared pdf.js entry point.
 *
 * Loading pdf.js is expensive and every connector that reads a PDF pays it,
 * so the module is imported once per process and shared. Kept separate from
 * any one connector's extraction rules, which differ by source.
 */
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

export interface LoadedPdfJs {
  getDocument: PdfJs['getDocument'];
  /** Operators that paint a raster, used to tell a scanned page apart. */
  imageOps: Set<number>;
}

let pdfJsPromise: Promise<LoadedPdfJs> | undefined;

export function loadPdfJs(): Promise<LoadedPdfJs> {
  // Cache the in-flight promise as well as the resolved module: concurrent
  // first extractions share one initialization, and non-PDF processes pay none.
  return pdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
    .then(({ getDocument, OPS }) => ({
      getDocument,
      imageOps: new Set<number>([
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
      ]),
    }))
    .catch((error) => {
      // Coalesce a failed first wave, but let a later call retry a transient
      // resolver/loader failure instead of caching its rejection permanently.
      pdfJsPromise = undefined;
      throw error;
    });
}
