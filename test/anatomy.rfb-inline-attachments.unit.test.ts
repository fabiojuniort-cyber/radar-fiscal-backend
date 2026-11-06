import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { attachmentByteOffset, readRfbInlineAttachments, RFB_INLINE_ATTACHMENT_LIMITS } from '../src/modules/anatomy/rfb-inline-attachments.js';

// ANAT-L2/L12 (decisão do Fábio, tribusca-control#116 c.6673604188): embedded RFB attachment HTML read as a SEPARATE
// resource. Synthetic payloads + the official IN 2.121 (promoted:false).
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const enc8 = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const doc = (payload: string | undefined, extra: Record<string, unknown> = {}) => ({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [{ ordemSegmentoAto: 1, idTipoSegmento: 3, textoIntegra: '<p>Art. 1º Fica aprovado o Anexo I.</p>' },
    { ordemSegmentoAto: 2, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º Texto final.</p>',
      arquivoBinario: { idArquivoBinario: 77, idTipoArquivo: 5, nomeArquivoBinario: 'A1.html', ...(payload === undefined ? {} : { arquivoBinario: payload }), ...extra } }] });
const bytesOf = (d: unknown) => enc8(JSON.stringify(d));
const html = (body: string, charset = 'utf-8') => `<!DOCTYPE html><html><head><meta charset="${charset}"></head><body>${body}</body></html>`;

test('L2/L12: malformed attachment HTML never alters the main body, its pieces or its source map', () => {
  const evil = html('<table><tr><td>Célula</section></div></body></html><!-- comentário aberto <p>Art. 99 injetado');
  const withPayload = bytesOf(doc(b64(enc8(evil))));
  const without = bytesOf(doc(undefined));
  const p1 = prepareRfbRepresentation({ resourceId: 'x', bytes: withPayload }, 900004);
  const p0 = prepareRfbRepresentation({ resourceId: 'x', bytes: without }, 900004);
  assert.equal(p1.html, p0.html); assert.equal(p1.htmlSha256, p0.htmlSha256); assert.deepEqual(p1.pieces, p0.pieces);
  const r1 = readAnatomyInput({ source: 'RFB', representationId: 'rfb:900004', html: p1.html });
  const r0 = readAnatomyInput({ source: 'RFB', representationId: 'rfb:900004', html: p0.html });
  assert.equal(r1.canonicalText, r0.canonicalText); assert.deepEqual(r1.sourceMap, r0.sourceMap); assert.deepEqual(r1.parts, r0.parts);
  assert.ok(!r1.canonicalText.includes('Art. 99'), 'attachment text never enters the act');
  const [a] = readRfbInlineAttachments(withPayload, 900004);
  assert.ok(a!.state === 'read' || a!.state === 'unreadable');
  if (a!.state === 'read') {
    assert.equal(a!.resourceId, 'rfb:900004:anexo:77');
    for (const part of a!.reading!.parts) for (const ptr of part.sourcePointers) assert.equal(ptr.resourceId, 'rfb:900004:anexo:77');
    assert.equal(a!.html, evil, 'body kept verbatim');
  }
});

test('L2/L12: byte offsets map back exactly in each accepted charset', () => {
  const body = 'Tabela: ação — 1,5 × Rx';
  for (const [charset, encode] of [['utf-8', enc8], ['windows-1252', latin], ['iso-8859-1', latin]] as const) {
    const text = html(body.replace('—', '-').replace('×', 'x'), charset);
    const bytes = encode(text);
    const [a] = readRfbInlineAttachments(bytesOf(doc(b64(bytes))), 900004);
    assert.equal(a!.state, 'read', charset); assert.equal(a!.html, text); assert.equal(a!.sha256, sha(bytes)); assert.equal(a!.byteLength, bytes.byteLength);
    const at = a!.html!.indexOf('ação'); const end = at + 'ação'.length;
    const bs = attachmentByteOffset(a!, at); const be = attachmentByteOffset(a!, end);
    assert.equal(new TextDecoder(a!.charset!).decode(bytes.subarray(bs, be)), 'ação', `${charset}: bytes [${bs},${be}) decode back to the text`);
    assert.equal(be - bs, charset === 'utf-8' ? 6 : 4);
  }
});

test('L2/L12: failure states — no content, invalid base64, not HTML, charset undeclared/unsupported/invalid bytes', () => {
  const state = (payload: string | undefined) => readRfbInlineAttachments(bytesOf(doc(payload)), 900004)[0]!.state;
  assert.equal(state(undefined), 'missing_no_content');
  assert.equal(state('!!!não-base64!!!'), 'invalid_base64');
  assert.equal(state(b64(enc8('%PDF-1.7 binário'))), 'not_html');
  assert.equal(state(b64(enc8('<!DOCTYPE html><html><body>sem charset</body></html>'))), 'charset_undeclared');
  assert.equal(state(b64(enc8(html('x', 'shift_jis')))), 'charset_unsupported');
  assert.equal(state(b64(new Uint8Array([...enc8(html('x')), 0xff, 0xfe]))), 'charset_unsupported', 'invalid UTF-8 bytes are not repaired');
});

test('L2/L12: size limits per attachment and per act', () => {
  const big = (n: number) => b64(enc8(html('a'.repeat(n))));
  assert.equal(readRfbInlineAttachments(bytesOf(doc(big(RFB_INLINE_ATTACHMENT_LIMITS.maxBytesPerAttachment))), 900004)[0]!.state, 'attachment_too_large');
  const seg = (o: number, id: number) => ({ ordemSegmentoAto: o, idTipoSegmento: 3, textoIntegra: `<p>Art. ${o}º T.</p>`,
    arquivoBinario: { idArquivoBinario: id, idTipoArquivo: 5, arquivoBinario: big(400 * 1024) } });
  const d = { idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }], outrosSegmentos: [seg(1, 1), seg(2, 2), seg(3, 3)] };
  assert.deepEqual(readRfbInlineAttachments(bytesOf(d), 900004).map((a) => a.state), ['read', 'read', 'act_attachments_too_large']);
});

test('L2/L12 official IN 2.121 (127905, promoted:false): 1 embedded HTML read separately, 30 PDFs missing; main preparation and its reconciliation since 0.1.0 unchanged', () => {
  const dir = new URL('../ops/anatomy/official-identification/rfb-normasinternet2/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('127905.meta.json', dir), 'utf8')); assert.equal(meta.promoted, false);
  const bytes = new Uint8Array(readFileSync(new URL('127905.json', dir)));
  const all = readRfbInlineAttachments(bytes, 127905);
  assert.equal(all.length, 31); assert.equal(all.filter((a) => a.state === 'missing_no_content').length, 30);
  const [a] = all.filter((x) => x.state === 'read');
  assert.equal(a!.idArquivoBinario, 67992); assert.equal(a!.name, 'IN1.html'); assert.equal(a!.charset, 'windows-1252'); assert.equal(a!.byteLength, 5643);
  assert.equal(a!.segmentOrder, 702); assert.equal(a!.pointer.endsWith('/arquivoBinario/arquivoBinario'), true);
  assert.match(a!.reading!.canonicalText, /F\s*=\s*0,0365\s*×/u);
  assert.ok(a!.reading!.parts.every((p) => p.legalStatus === 'unknown'));
  // main preparation unchanged: same 0.2.0 hash as before L2/L12; captured 0.1.0 hash still reproduced by stripping D04
  const p = prepareRfbRepresentation({ resourceId: 'rfb:127905', bytes }, 127905);
  assert.equal(p.preparationVersion, 'rfb-api-original/0.2.0-provisional');
  assert.equal(p.htmlSha256, 'c223c99d03dc08bdcb53ddefbfc5e7624b011aa1c63aa21e93e0656a42455791');
  assert.equal(meta.preparation.preparationVersion, 'rfb-api-original/0.1.0-provisional');
  assert.equal(sha(p.html.replace(/ data-rfb-type="[^"]*"| data-rfb-type-issue="[^"]*"| data-rfb-tachado="true"/gu, '')), meta.preparation.htmlSha256);
});

// ---- R2 (COORD #300): BOM, non-BMP, the reader's real pointers against the original bytes, protected context ----
const readOnly = (bytes: Uint8Array) => readRfbInlineAttachments(bytesOf(doc(b64(bytes))), 900004)[0]!;
/** Every sourceSpan the reader produced, mapped to bytes, must decode back to the exact same text. */
function assertPointersMatchBytes(a: ReturnType<typeof readOnly>, bytes: Uint8Array) {
  let n = 0;
  for (const part of a.reading!.parts) for (const ptr of part.sourcePointers) {
    if (!ptr.sourceSpan) continue; n++;
    const bs = attachmentByteOffset(a, ptr.sourceSpan.start); const be = attachmentByteOffset(a, ptr.sourceSpan.end);
    assert.equal(new TextDecoder(a.charset!, { ignoreBOM: true }).decode(bytes.subarray(bs, be)), a.html!.slice(ptr.sourceSpan.start, ptr.sourceSpan.end), `${part.type} ${ptr.locator}`);
  }
  assert.ok(n > 0, 'the reader produced source spans');
}

test('R2: UTF-8 with BOM — BOM kept in the body, the reader\'s real pointers map to the original bytes', () => {
  const text = html('<p>Art. 1º Tabela ação: 1,5 × Rx.</p><table><tr><td>ção</td></tr></table>');
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc8(text)]);
  const a = readOnly(bytes);
  assert.equal(a.state, 'read'); assert.equal(a.html!.charCodeAt(0), 0xfeff, 'BOM kept as U+FEFF'); assert.equal(a.sha256, sha(bytes));
  assert.equal(attachmentByteOffset(a, 1), 3, 'the BOM is 3 bytes');
  assertPointersMatchBytes(a, bytes);
  const at = a.html!.indexOf('ação'); assert.equal(new TextDecoder().decode(bytes.subarray(attachmentByteOffset(a, at), attachmentByteOffset(a, at + 4))), 'ação');
});

test('R2: characters outside the BMP — pointers map exactly; an offset inside a surrogate pair is refused', () => {
  const text = html('<p>Art. 1º 𝔉 = 0,0365 × 𝑅𝑥 😀 fim.</p>');
  const bytes = enc8(text); const a = readOnly(bytes);
  assert.equal(a.state, 'read'); assertPointersMatchBytes(a, bytes);
  const at = a.html!.indexOf('𝔉'); assert.equal(attachmentByteOffset(a, at + 2) - attachmentByteOffset(a, at), 4, 'one non-BMP character = 4 bytes');
  assert.throws(() => attachmentByteOffset(a, at + 1), /surrogate/u);
  for (const charset of ['windows-1252', 'iso-8859-1'] as const) {
    const t = html('<p>Art. 1º Fórmula ação.</p><table><tr><td>célula</td></tr></table>', charset); const lb = latin(t);
    assertPointersMatchBytes(readOnly(lb), lb);
  }
});

const ctxDoc = (refSegment: Record<string, unknown>, pre: Record<string, unknown>[] = []) => ({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
  outrosSegmentos: [...pre, { ordemSegmentoAto: 9, idTipoSegmento: 3, arquivoBinario: { idArquivoBinario: 77, idTipoArquivo: 5, arquivoBinario: b64(enc8(html('<p>Art. 1º Texto do anexo.</p><table><tr><td>valor</td></tr></table>'))) }, ...refSegment }] });
const ctxOf = (d: unknown) => readRfbInlineAttachments(bytesOf(d), 900004)[0]!;

test('R2: the attachment inherits the protected context of the referencing segment (quotation, tachado), never becoming more permissive', () => {
  const op = ctxOf(ctxDoc({ textoIntegra: '<p>Art. 2º Fica aprovado o anexo.</p>' }));
  assert.equal(op.referenceContext, 'operative_candidate'); assert.ok(op.reading!.parts.some((x) => x.context === 'operative_candidate'));
  const st = ctxOf(ctxDoc({ textoIntegra: '<p>Art. 2º Redação antiga com anexo.</p>', tachado: true }));
  assert.equal(st.referenceContext, 'historical');
  assert.ok(st.reading!.parts.every((x) => x.context !== 'operative_candidate'), 'tachado reference: nothing operative in the attachment');
  assert.ok(st.reading!.parts.some((x) => x.contextReasons.includes('rfb_inline_attachment_reference_context')));
  const q = ctxOf(ctxDoc({ textoIntegra: '<p>“Art. 2º Texto citado com anexo”</p>' }));
  assert.equal(q.referenceContext, 'prohibited');
  assert.ok(q.reading!.parts.every((x) => x.context === 'prohibited' || x.type === 'unidentified' || x.type === 'document'), 'quoted reference: attachment prohibited');
  const open = ctxOf(ctxDoc({ textoIntegra: '<p>Art. 3º Texto dentro da citação aberta.</p>' }, [{ ordemSegmentoAto: 8, idTipoSegmento: 3, textoIntegra: '<p>Art. 2º O ato passa a vigorar:</p><p>“Art. 10. Texto citado</p>' }]));
  assert.equal(open.referenceContext, 'prohibited', 'inside an open quotation carried from a previous segment');
  const noText = ctxOf(ctxDoc({}, [{ ordemSegmentoAto: 8, idTipoSegmento: 3, textoIntegra: '<p>Art. 1º Texto.</p>' }]));
  assert.equal(noText.referenceContext, 'prohibited', 'undetermined → conservative prohibited');
  for (const a of [op, st, q, open, noText]) assert.ok(a.reading!.parts.every((x) => x.legalStatus === 'unknown'));
});

test('R2 official IN 2.121: the real attachment pointers map to its original bytes; referencing segment 702 (art. 137) is operative', () => {
  const dir = new URL('../ops/anatomy/official-identification/rfb-normasinternet2/', import.meta.url);
  const json = new Uint8Array(readFileSync(new URL('127905.json', dir)));
  const a = readRfbInlineAttachments(json, 127905).find((x) => x.state === 'read')!;
  const raw = JSON.parse(new TextDecoder().decode(json)) as { outrosSegmentos: { arquivoBinario?: { idArquivoBinario: number; arquivoBinario?: string } }[] };
  const original = new Uint8Array(Buffer.from(raw.outrosSegmentos.find((s) => s.arquivoBinario?.idArquivoBinario === 67992)!.arquivoBinario!.arquivoBinario!, 'base64'));
  assert.equal(sha(original), a.sha256);
  assertPointersMatchBytes(a, original);
  assert.equal(a.referenceContext, 'operative_candidate');
});

// ---- R3 (COORD #300 @b9ffa9d8): text-less referencing segment — quotation prevails over tachado; undetermined → prohibited ----
test('R3: text-less tachado segment referencing the attachment — inside an open quotation → prohibited; outside → historical; undetermined → prohibited', () => {
  const att = { idArquivoBinario: 77, idTipoArquivo: 5, arquivoBinario: b64(enc8(html('<p>Art. 1º Texto do anexo.</p>'))) };
  const run = (segs: Record<string, unknown>[]) => readRfbInlineAttachments(bytesOf({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }], outrosSegmentos: segs }), 900004)[0]!;
  const ref = (o: number, extra: Record<string, unknown> = {}) => ({ ordemSegmentoAto: o, idTipoSegmento: 3, tachado: true, arquivoBinario: att, ...extra });
  const txt = (o: number, t: string) => ({ ordemSegmentoAto: o, idTipoSegmento: 3, textoIntegra: t });
  const noOperative = (a: ReturnType<typeof run>) => a.reading!.parts.every((x) => x.context !== 'operative_candidate');
  // 1. inside an open quotation (opened in the previous segment, closed after): quotation prevails over tachado
  const inQuote = run([txt(1, '<p>Art. 1º O ato passa a vigorar:</p><p>“Art. 10. Texto citado</p>'), ref(2), txt(3, '<p>Art. 11. Continua citado.”</p>')]);
  assert.equal(inQuote.referenceContext, 'prohibited'); assert.match(inQuote.referenceContextEvidence, /quotation prevails over tachado/u);
  assert.ok(inQuote.reading!.parts.filter((x) => x.type !== 'document').every((x) => x.context === 'prohibited'));
  // 2. quotation opening right after the gap also prevails
  const quoteAfter = run([txt(1, '<p>Art. 1º Texto operativo.</p>'), ref(2), txt(3, '<p>“Art. 10. Citado”</p>')]);
  assert.equal(quoteAfter.referenceContext, 'prohibited');
  // 3. explicit expectation outside any quotation: tachado → historical, nothing operative
  const outside = run([txt(1, '<p>Art. 1º Texto operativo.</p>'), ref(2), txt(3, '<p>Art. 2º Texto operativo.</p>')]);
  assert.equal(outside.referenceContext, 'historical'); assert.ok(noOperative(outside));
  assert.ok(outside.reading!.parts.filter((x) => x.type !== 'document').every((x) => x.context === 'historical'));
  // 4. undetermined: no text neighbour on one side → prohibited (tachado alone is not enough)
  const atEnd = run([txt(1, '<p>Art. 1º Texto operativo.</p>'), ref(2)]);
  assert.equal(atEnd.referenceContext, 'prohibited');
  const atStart = run([ref(1), txt(2, '<p>Art. 2º Texto operativo.</p>')]);
  assert.equal(atStart.referenceContext, 'prohibited');
  // 5. text-less and NOT tachado, neighbours operative → still undetermined → prohibited
  const notStruck = run([txt(1, '<p>Art. 1º Texto.</p>'), ref(2, { tachado: false }), txt(3, '<p>Art. 2º Texto.</p>')]);
  assert.equal(notStruck.referenceContext, 'prohibited');
  for (const a of [inQuote, quoteAfter, outside, atEnd, atStart, notStruck]) assert.ok(a.reading!.parts.every((x) => x.legalStatus === 'unknown'));
});
