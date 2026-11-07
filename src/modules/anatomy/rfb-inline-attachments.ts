import { createHash } from 'node:crypto';
import type { AnatomyPart } from './contract.js';
import { prepareRfbRepresentation, type JsonPreparation } from './json-preparation.js';
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
 *
 * R2 (COORD #300): (1) a UTF-8 BOM is KEPT in `html` (decoded with ignoreBOM), so UTF-16 offsets of the reader's own
 * sourcePointers map to the original bytes including the 3 BOM bytes; (2) an offset inside a surrogate pair (non-BMP
 * character) is refused; (3) the attachment inherits the protected context of the segment that references it in the
 * act: quotation/prohibited → prohibited, tachado/historical → historical, undetermined → prohibited (conservative).
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
  /** The separate reader pass (state 'read' only), with the referencing segment's protected context applied. */
  reading: AnatomyReaderResult | null;
  /** Context of the segment that references the attachment in the act (R2). */
  referenceContext: AnatomyPart['context'];
  referenceContextEvidence: string;
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
  // R2: never split a surrogate pair (characters outside the BMP take 2 UTF-16 units and 4 UTF-8 bytes).
  const prev = att.html.charCodeAt(utf16Offset - 1);
  if (utf16Offset > 0 && utf16Offset < att.html.length && prev >= 0xd800 && prev <= 0xdbff) throw new RangeError('offset splits a surrogate pair');
  // The BOM, when present, is part of `html` (decoded with ignoreBOM), so it is counted like any other character.
  return Buffer.byteLength(att.html.slice(0, utf16Offset), 'utf8');
}

const RESTRICT: Record<AnatomyPart['context'], number> = { operative_candidate: 0, unknown: 1, historical: 2, prohibited: 3 };
/** Most restrictive context of the act's parts that cover the referencing segment's text (R2). */
type MainAct = { prep: Pick<JsonPreparation, 'pieces'>; parts: readonly AnatomyPart[] };
type Piece = JsonPreparation['pieces'][number];
const coveringOf = (main: MainAct, piece: Piece) => main.parts.filter((x) => x.type !== 'document' && x.type !== 'caput'
  && x.sourcePointers.some((sp) => sp.sourceSpan && sp.sourceSpan.start < piece.htmlSpan.end && sp.sourceSpan.end > piece.htmlSpan.start));
const strictest = (parts: readonly AnatomyPart[]): AnatomyPart['context'] => {
  let ctx: AnatomyPart['context'] = 'operative_candidate';
  for (const x of parts) if (RESTRICT[x.context] > RESTRICT[ctx]) ctx = x.context;
  return ctx;
};
/**
 * Most restrictive context of the act at the referencing segment (R2/R3).
 * - Segment with text: the strictest context of the act's parts covering it (unknown → prohibited).
 * - R3: segment WITHOUT text: decided from the nearest text segments before and after it in segment order. A
 *   quotation (prohibited) on either side prevails over tachado; a missing or undetermined neighbour → prohibited;
 *   only with both neighbours determined and not prohibited does tachado give historical (else prohibited).
 */
function referenceContextOf(main: MainAct, pointer: string, tachado: boolean, order: number, pieceOrder: Map<string, number>):
  { context: AnatomyPart['context']; evidence: string } {
  const piece = main.prep.pieces.find((x) => x.pointer === `${pointer}/textoIntegra`);
  if (piece) {
    const covering = coveringOf(main, piece);
    if (!covering.length) return { context: 'prohibited', evidence: 'no act part covers the referencing segment: conservative prohibited' };
    let ctx = strictest(covering); if (ctx === 'unknown') ctx = 'prohibited';
    return { context: ctx, evidence: `context of ${covering.length} act part(s) covering ${pointer}` };
  }
  const ordered = main.prep.pieces.map((x) => ({ x, o: pieceOrder.get(x.pointer) })).filter((e): e is { x: Piece; o: number } => typeof e.o === 'number');
  const before = ordered.filter((e) => e.o < order).sort((a, b) => b.o - a.o)[0];
  const after = ordered.filter((e) => e.o > order).sort((a, b) => a.o - b.o)[0];
  if (!before || !after) return { context: 'prohibited', evidence: 'segment has no text and lacks a text neighbour on one side: context undetermined, prohibited' };
  // the part at the END of the previous segment and at the START of the next one decide whether a quotation spans the gap
  const lastOf = (ps: AnatomyPart[]) => ps.sort((a, b) => b.span.start - a.span.start)[0];
  const firstOf = (ps: AnatomyPart[]) => ps.sort((a, b) => a.span.start - b.span.start)[0];
  const prevPart = lastOf(coveringOf(main, before.x)); const nextPart = firstOf(coveringOf(main, after.x));
  if (!prevPart || !nextPart) return { context: 'prohibited', evidence: 'segment has no text and a neighbour has no act part: context undetermined, prohibited' };
  if (prevPart.context === 'prohibited' || nextPart.context === 'prohibited') {
    return { context: 'prohibited', evidence: `segment has no text; neighbour segment ${prevPart.context === 'prohibited' ? before.o : after.o} is prohibited (quotation prevails over tachado)` };
  }
  if (prevPart.context === 'unknown' || nextPart.context === 'unknown') return { context: 'prohibited', evidence: 'segment has no text; a neighbour is undetermined: prohibited' };
  if (tachado) return { context: 'historical', evidence: `segment has no text; source marks it tachado; neighbours ${before.o}/${after.o} are not quoted` };
  return { context: 'prohibited', evidence: 'segment has no text and is not tachado: context undetermined, prohibited' };
}

export function readRfbInlineAttachments(bytes: Uint8Array, expectedIdAto: number,
  main?: { prep: Pick<JsonPreparation, 'pieces'>; parts: readonly AnatomyPart[] }): InlineAttachment[] {
  // R2: the referencing segment's context comes from the act itself; without a supplied reading it is computed here.
  const act = main ?? (() => { const prep = prepareRfbRepresentation({ resourceId: `rfb:${expectedIdAto}`, bytes }, expectedIdAto);
    return { prep, parts: readAnatomyInput({ source: 'RFB', representationId: `rfb:${expectedIdAto}`, html: prep.html }).parts }; })();
  const root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/u, '')) as Record<string, unknown>;
  if (root.idAto !== expectedIdAto) throw new TypeError('RFB idAto differs from the expected act');
  const out: InlineAttachment[] = []; let actBytes = 0;
  // R3: segment order of every piece, so a text-less referencing segment can be placed between its neighbours.
  const pieceOrder = new Map<string, number>();
  for (const key of ['ementas', 'outrosSegmentos'] as const) (Array.isArray(root[key]) ? root[key] as Record<string, unknown>[] : [])
    .forEach((seg, i) => { if (typeof seg?.ordemSegmentoAto === 'number') pieceOrder.set(`/${key}/${i}/textoIntegra`, seg.ordemSegmentoAto); });
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
        byteLength: null, sha256: null, charset: null, html: null, reading: null, referenceContext: 'operative_candidate', referenceContextEvidence: '' };
      const rc = referenceContextOf(act, `/${key}/${i}`, seg.tachado === true, typeof seg.ordemSegmentoAto === 'number' ? seg.ordemSegmentoAto : -1, pieceOrder);
      base.referenceContext = rc.context; base.referenceContextEvidence = rc.evidence;
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
      // R2: ignoreBOM keeps a UTF-8 BOM as U+FEFF in `html`, so offsets stay aligned with the original bytes.
      try { html = new TextDecoder(charset, { fatal: charset === 'utf-8', ignoreBOM: true }).decode(decoded); }
      catch { return done('charset_unsupported', `bytes are not valid ${charset}`, { ...meta, charset }); }
      actBytes += decoded.byteLength;
      let reading: AnatomyReaderResult;
      try { reading = readAnatomyInput({ source: 'RFB', representationId: base.resourceId, html }); }
      catch (e) { return done('unreadable', `reader refused the attachment: ${(e as Error).message}`, { ...meta, charset }); }
      // R2: the attachment never becomes more permissive than the segment that references it.
      if (base.referenceContext !== 'operative_candidate') for (const x of reading.parts) {
        if (RESTRICT[x.context] < RESTRICT[base.referenceContext] && x.type !== 'unidentified') { x.context = base.referenceContext; x.contextReasons.push('rfb_inline_attachment_reference_context'); }
      }
      done('read', null as unknown as string, { ...meta, charset, html, reading });
    });
  }
  return out.map((a) => (a.state === 'read' ? Object.freeze({ ...a, reason: null }) : a));
}
