/*
 * Text of a CGIBS document.
 *
 * The committee publishes its acts as files (mostly PDF) linked from catalog
 * pages, so without this the publication carries a title and a link and no
 * body: the act is unreadable in the Acervo and invisible to content search.
 * Only the text is kept; the file itself is never persisted.
 *
 * Extraction never throws for a document that merely cannot be read. A
 * damaged, encrypted or image-only file yields an empty text with the reason,
 * which the connector records, because one unreadable attachment must not
 * fail the other acts of the run.
 */
import { loadPdfJs } from './pdf.loader.js';

export type CgibsTextExtraction =
  /** Native text layer read from the PDF. */
  | 'PDF_TEXT'
  /** A valid PDF carrying no extractable text (image-only scan without OCR). */
  | 'PDF_WITHOUT_TEXT'
  /** The bytes are not a PDF (zip, spreadsheet, XML...). */
  | 'UNSUPPORTED_MEDIA'
  /** Beyond the extraction limits; the file stays linked, only unread. */
  | 'TOO_LARGE'
  /** Present but unreadable (damaged or encrypted). */
  | 'UNREADABLE';

export interface CgibsExtractedText {
  text: string;
  pageCount: number;
  extraction: CgibsTextExtraction;
  /** Pages past the limit that were not read, so truncation is never silent. */
  pagesSkipped: number;
}

/** Extraction limits: a catalog file is an act, not a bulk archive. */
const MAX_PDF_BYTES = 48 * 1024 * 1024;
const MAX_PAGES = 600;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function isPdf(bytes: Uint8Array, mimeType: string): boolean {
  if (/^application\/pdf\b/i.test(mimeType)) return true;
  // The portal serves some attachments as octet-stream; trust the bytes.
  return bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

function normalize(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/­/g, '')
    .replace(/[\t  ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function empty(extraction: CgibsTextExtraction): CgibsExtractedText {
  return { text: '', pageCount: 0, extraction, pagesSkipped: 0 };
}

export async function extractCgibsText(
  bytes: Uint8Array,
  mimeType: string,
): Promise<CgibsExtractedText> {
  if (!isPdf(bytes, mimeType)) return empty('UNSUPPORTED_MEDIA');
  if (bytes.byteLength > MAX_PDF_BYTES) return empty('TOO_LARGE');

  const { getDocument } = await loadPdfJs();
  // pdf.js transfers (detaches) the buffer it receives.
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch {
      return empty('UNREADABLE');
    }

    const readable = Math.min(doc.numPages, MAX_PAGES);
    const parts: string[] = [];
    let chars = 0;
    let read = 0;

    for (let pageNumber = 1; pageNumber <= readable; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        parts.push(
          content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
            .join(''),
        );
        chars += parts[parts.length - 1]!.length;
        read = pageNumber;
      } finally {
        page.cleanup();
      }
      if (chars >= MAX_TEXT_CHARS) break;
    }

    const text = normalize(parts.join('\n')).slice(0, MAX_TEXT_CHARS);
    return {
      text,
      pageCount: doc.numPages,
      extraction: text ? 'PDF_TEXT' : 'PDF_WITHOUT_TEXT',
      pagesSkipped: Math.max(0, doc.numPages - read),
    };
  } finally {
    await task.destroy();
  }
}
