import { createHash } from 'node:crypto';
import { readAnatomyInput, type AnatomyReaderResult } from './readers.js';

/**
 * ANAT-L2/L12 (decisão do Fábio, tribusca-control#116 c.6673604188; desenho #293 §13.2/§14.2).
 *
 * Some RFB acts carry an attachment's content INSIDE the official JSON (`arquivoBinario.arquivoBinario`, base64).
 * This module reads such an attachment as a SEPARATE resource:
 *  - the main RFB preparation (json-preparation.ts, rfb-api-original/0.2.0) is NOT touched: its HTML, pieces and
 *    hashes stay identical, so the reconciliation chain 0.1.0 →(D04)→ 0.2.0 of every captured act stays valid;
 *  - each attachment gets its own resourceId `rfb:<idAto>:anexo:<idArquivoBinario>` and its own reader pass, so a
 *    malformed attachment (unclosed tags, a stray `</section>`, an open comment) can never alter the act's tree,
 *    text or source map;
 *  - the decoded bytes are kept as they are (SHA-256), decoded with the charset the attachment itself declares
 *    (windows-1252 / iso-8859-1 / utf-8 only), never normalised or repaired; UTF-16 offsets map back to bytes;
 *  - size limits: 512 KiB decoded per attachment, 1 MiB per act. PDFs (or any non-HTML content) stay `missing`.
 * Nothing is fetched. legalStatus stays unknown (the reader never sets it).
 */
export const RFB_INLINE_ATTACHMENT_VERSION = 'rfb-inline-attachment/0.1.0-provisional' as const;
export const RFB_INLINE_ATTACHMENT_LIMITS = Object.freeze({ maxBytesPerAttachment: 512 * 1024, maxBytesPerAct: 1024 * 1024 });

export type InlineAttachmentState = 'read' | 'unreadable' | 'missing_no_content' | 'invalid_base64' | 'not_html'
  | 'charset_undeclared' | 'charset_unsupported' | 'attachment_too_large' | 'act_attachments_too_large';
type Charset = 'windows-1252' | 'utf-8';

export interface InlineAttachment {
  version: typeof RFB_INLINE_ATTACHMENT_VERSION;
  idAto: number;
  idArquivoBinario: number;
  name: string | null;
  idTipoArquivo: number | null;
  /** JSON pointer of the base64 payload inside the official resource. */
  pointer: string;
  /** Segment that references the attachment (its position in the act). */
  segmentOrder: number;
  resourceId: string;
  state: InlineAttachmentState;
  reason: string | null;
  /** Decoded bytes (only when the payload was valid base64). */
  byteLength: number | null;
  sha256: string | null;
  charset: Charset | null;
  /** The decoded HTML (state 'read' only), verbatim. */
  html: string | null;
  /** The separate reader pass (state 'read' only). */
  reading: AnatomyReaderResult | null;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const B64 = /^[A-Za-z0-9+/]*={0,2}$/u;

function declaredCharset(bytes: Uint8Array): string | null {
  // The declaration is ASCII in every accepted charset; read only the head of the document.
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)/iu.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}
function charsetOf(label: string): Charset | null {
  if (['windows-1252', 'cp1252', 'iso-8859-1', 'latin1', 'us-ascii'].includes(label)) return 'windows-1252'; // WHATWG: latin1 → windows-1252
  if (['utf-8', 'utf8'].includes(label)) return 'utf-8';
  return null;
}

/** Byte offset (in the decoded attachment bytes) of a UTF-16 offset of `att.html`. */
export function attachmentByteOffset(att: Pick<InlineAttachment, 'charset' | 'html'>, utf16Offset: number): number {
  if (att.html === null || att.charset === null) throw new TypeError('attachment was not read');
  if (utf16Offset < 0 || utf16Offset > att.html.length) throw new RangeError('offset outside the attachment');
  // windows-1252 (WHATWG) maps every byte to exactly one BMP code point: byte offset = UTF-16 offset.
  if (att.charset === 'windows-1252') return utf16Offset;
  return Buffer.byteLength(att.html.slice(0, utf16Offset), 'utf8');
}

export function readRfbInlineAttachments(bytes: Uint8Array, expectedIdAto: number): InlineAttachment[] {
  const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/u, '')) as Record<string, unknown>;
  if (root.idAto !== expectedIdAto) throw new TypeError('RFB idAto differs from the expected act');
  const out: InlineAttachment[] = []; let actBytes = 0;
  for (const key of ['ementas', 'outrosSegmentos'] as const) {
    const list = Array.isArray(root[key]) ? root[key] as Record<string, unknown>[] : [];
    list.forEach((seg, i) => {
      const file = seg?.arquivoBinario as Record<string, unknown> | undefined;
      if (!file || typeof file !== 'object' || typeof file.idArquivoBinario !== 'number') return;
      const id = file.idArquivoBinario;
      const base: InlineAttachment = { version: RFB_INLINE_ATTACHMENT_VERSION, idAto: expectedIdAto, idArquivoBinario: id,
        name: typeof file.nomeArquivoBinario === 'string' ? file.nomeArquivoBinario : null,
        idTipoArquivo: typeof file.idTipoArquivo === 'number' ? file.idTipoArquivo : null,
        pointer: `/${key}/${i}/arquivoBinario/arquivoBinario`, segmentOrder: typeof seg.ordemSegmentoAto === 'number' ? seg.ordemSegmentoAto : -1,
        resourceId: `rfb:${expectedIdAto}:anexo:${id}`, state: 'missing_no_content', reason: 'no embedded content in the official JSON',
        byteLength: null, sha256: null, charset: null, html: null, reading: null };
      const done = (state: InlineAttachmentState, reason: string, extra: Partial<InlineAttachment> = {}) => { out.push(Object.freeze({ ...base, ...extra, state, reason })); };
      const payload = file.arquivoBinario;
      if (typeof payload !== 'string' || !payload.length) return done('missing_no_content', 'no embedded content in the official JSON');
      const compact = payload.replace(/\s+/gu, '');
      if (compact.length % 4 !== 0 || !B64.test(compact)) return done('invalid_base64', 'payload is not valid base64');
      const decoded = new Uint8Array(Buffer.from(compact, 'base64'));
      const meta = { byteLength: decoded.byteLength, sha256: sha(decoded) };
      if (decoded.byteLength > RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAttachment) return done('attachment_too_large', `> ${RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAttachment} bytes`, meta);
      if (actBytes + decoded.byteLength > RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAct) return done('act_attachments_too_large', `> ${RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAct} bytes in this act`, meta);
      const head = Buffer.from(decoded.subarray(0, 512)).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/u, '').trimStart();
      if (!/^<(!doctype\s+html|html)[\s>]/iu.test(head)) return done('not_html', 'content is not an HTML document', meta);
      const label = declaredCharset(decoded);
      if (!label) return done('charset_undeclared', 'the attachment declares no charset', meta);
      const charset = charsetOf(label);
      if (!charset) return done('charset_unsupported', `charset ${label} is not supported`, meta);
      let html: string;
      try { html = new TextDecoder(charset, { fatal: charset === 'utf-8' }).decode(decoded); }
      catch { return done('charset_unsupported', `bytes are not valid ${charset}`, { ...meta, charset }); }
      actBytes += decoded.byteLength;
      let reading: AnatomyReaderResult;
      try { reading = readAnatomyInput({ source: 'RFB', representationId: base.resourceId, html }); }
      catch (e) { return done('unreadable', `reader refused the attachment: ${(e as Error).message}`, { ...meta, charset }); }
      done('read', null as unknown as string, { ...meta, charset, html, reading });
    });
  }
  return out.map((a) => (a.state === 'read' ? Object.freeze({ ...a, reason: null }) : a));
}
