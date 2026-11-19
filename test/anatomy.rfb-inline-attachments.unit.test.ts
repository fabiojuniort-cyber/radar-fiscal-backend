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

// ---- E9 P2-c (COORD decision A on tribusca-control#116 c.6783692588): type-5 table fragment, strict UTF-8 fallback,
// association by EXPRESS normative reference; R3 kept for quoted, struck, ambiguous or unlinked content ----
const TABLE = '<table class="t"><tr><td>1) Importador</td><td>Empresa Sintética S.A.</td></tr><tr><td>2) País de destino</td><td>México</td></tr></table>';
const frag = (body: string, tipo = 5) => ({ idArquivoBinario: 88, idTipoArquivo: tipo, nomeArquivoBinario: '1.html', arquivoBinario: b64(enc8(body)) });
const runA = (segs: Record<string, unknown>[]) => readRfbInlineAttachments(bytesOf({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }], outrosSegmentos: segs }), 900004)[0]!;
const tx = (o: number, t: string) => ({ ordemSegmentoAto: o, idTipoSegmento: 3, textoIntegra: t });
const an = (o: number, att: Record<string, unknown> = frag(TABLE), extra: Record<string, unknown> = {}) => ({ ordemSegmentoAto: o, idTipoSegmento: 3, arquivoBinario: att, ...extra });
const ART1 = '<p>Art. 1º Fica a empresa autorizada a exportar, de acordo com as especificações descritas abaixo.</p>';
const ART2 = '<p>Art. 2º A autorização fica condicionada à comprovação.</p>';

test('E9-A1: a validated type-5 table fragment is read as a separate resource; charset evidence in its own field; reason stays null', () => {
  const a = runA([tx(1, ART1), an(2), tx(3, ART2)]);
  assert.deepEqual([a.state, a.reason, a.htmlForm, a.charset, a.charsetEvidence], ['read', null, 'table_fragment', 'utf-8', 'inferred_strict_utf8']);
  assert.equal(a.sha256, sha(enc8(TABLE)), 'bytes preserved verbatim'); assert.equal(a.html, TABLE);
  assert.ok(a.reading!.parts.some((x) => x.type === 'table') && a.reading!.parts.filter((x) => x.type === 'cell').length === 4);
  assertPointersMatchBytes(a, enc8(TABLE));
  for (const p of a.reading!.parts) for (const ptr of p.sourcePointers) assert.equal(ptr.resourceId, 'rfb:900004:anexo:88', 'never part of the act');
  // a declared document keeps 'declared'
  const d = runA([tx(1, ART1), an(2, frag(html(TABLE))), tx(3, ART2)]);
  assert.deepEqual([d.state, d.htmlForm, d.charsetEvidence], ['read', 'document', 'declared']);
});

test('E9-A2: fragment validation and the delimited fallback fail closed', () => {
  const st = (body: string | Uint8Array, tipo = 5) => runA([tx(1, ART1), an(2, typeof body === 'string' ? frag(body, tipo) : { ...frag('', tipo), arquivoBinario: b64(body) }), tx(3, ART2)]);
  const cases: [string, string | Uint8Array, number, string][] = [
    ['type 6 (PDF id) with a table', TABLE, 6, 'not_html'],
    ['script inside', '<table><tr><td>x</td></tr><script>alert(1)</script></table>', 5, 'not_html'],
    ['div wrapper', '<div><table><tr><td>x</td></tr></table></div>', 5, 'not_html'],
    ['two tables', '<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>', 5, 'not_html'],
    ['nested table', '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>', 5, 'not_html'],
    ['trailing text', `${TABLE} Art. 99 injetado`, 5, 'not_html'],
    ['no cell', '<table><tr></tr></table>', 5, 'not_html'],
    ['comment', '<table><!-- x --><tr><td>x</td></tr></table>', 5, 'not_html'],
    ['unclosed', '<table><tr><td>x</td></tr>', 5, 'not_html'],
    ['windows-1252 bytes, undeclared', latin('<table><tr><td>Exportação</td></tr></table>'), 5, 'charset_undeclared'],
  ];
  for (const [why, body, tipo, want] of cases) { const a = st(body, tipo); assert.equal(a.state, want, why); assert.equal(a.reading, null, why); }
  // an <html> document without a declaration keeps the original refusal (the fallback is ONLY for fragments)
  assert.equal(st('<!DOCTYPE html><html><body><table><tr><td>x</td></tr></table></body></html>').state, 'charset_undeclared');
});

test('E9-A3: express reference — the Art. 1 "descritas abaixo." immediately before links the table as operative; nothing else does', () => {
  const op = runA([tx(1, ART1), an(2), tx(3, ART2)]);
  assert.equal(op.referenceContext, 'operative_candidate'); assert.match(op.referenceContextEvidence, /express reference: segment 1 ends "descritas abaixo\."/u);
  assert.ok(op.reading!.parts.filter((x) => x.type !== 'document').every((x) => x.context === 'operative_candidate'));
  for (const [ref, ok] of [['conforme a tabela a seguir:', true], ['nos termos relacionados abaixo:', true], ['descritas abaixo, exceto as do art. 3º.', false],
    ['observadas as regras do Anexo I.', false], ['abaixo assinado.', false], ['descritas acima.', false]] as const) {
    const a = runA([tx(1, `<p>Art. 1º Fica autorizada a exportação ${ref}</p>`), an(2), tx(3, ART2)]);
    assert.equal(a.referenceContext, ok ? 'operative_candidate' : 'prohibited', ref);
  }
});

test('E9-A4: adversarial — R3 prevails for quoted, struck, ambiguous or unlinked content even with an express reference', () => {
  const expectCtx = (segs: Record<string, unknown>[], ctx: string, why: string) => {
    const a = runA(segs); assert.equal(a.referenceContext, ctx, why);
    assert.ok(a.reading!.parts.filter((x) => x.type !== 'document').every((x) => x.context === ctx), `${why}: parts follow`);
    assert.ok(a.reading!.parts.every((x) => x.legalStatus === 'unknown'), `${why}: legalStatus unknown`);
  };
  // quotation: the reference sits inside a quoted (amending) text
  expectCtx([tx(1, '<p>Art. 1º O art. 5º passa a vigorar com a seguinte redação:</p><p>“Art. 5º Ficam autorizadas as operações descritas abaixo.</p>'),
    an(2), tx(3, '<p>Parágrafo único. Texto citado.”</p>')], 'prohibited', 'reference inside a quotation');
  // quotation opening right after the attachment
  expectCtx([tx(1, ART1), an(2), tx(3, '<p>“Art. 10. Citado”</p>')], 'prohibited', 'next neighbour quoted');
  // struck attachment segment: R3 historical, never operative
  expectCtx([tx(1, ART1), an(2, frag(TABLE), { tachado: true }), tx(3, ART2)], 'historical', 'struck attachment segment');
  // unlinked: another text segment between the reference and the attachment
  expectCtx([tx(1, ART1), tx(2, '<p>Art. 2º Outro dispositivo.</p>'), an(3), tx(4, '<p>Art. 3º Fim.</p>')], 'prohibited', 'reference not immediately before');
  // ambiguous: no text neighbour after the attachment
  expectCtx([tx(1, ART1), an(2)], 'prohibited', 'no next neighbour');
  // no reference at all: R3 unchanged
  expectCtx([tx(1, '<p>Art. 1º Texto operativo.</p>'), an(2), tx(3, ART2)], 'prohibited', 'no express reference');
  // gap in segment order (2 → 4) is not "immediately after"
  expectCtx([tx(2, ART1), an(4), tx(5, ART2)], 'prohibited', 'non-adjacent order');
});

// ---- R2 (independent review c.6784793278, A-1/A-2/A-4): no promotion on struck text, on another norm's annex, on a
// negation/exclusion, on ementa text or without a demonstrable normative device. Real ADE Cofis must stay operative. ----
test('R2 A-1: an inline-struck reference (<strike>/<s>/<del>) in a non-tachado segment never promotes', () => {
  for (const tag of ['strike', 's', 'del']) {
    const a = runA([tx(1, `<p>Art. 1º Fica autorizada a exportação, <${tag}>de acordo com as especificações descritas abaixo.</${tag}></p>`), an(2), tx(3, ART2)]);
    assert.notEqual(a.referenceContext, 'operative_candidate', tag);
  }
});

test('R2 A-2: lexical reference alone never promotes — another norm\'s annex, negation/exclusion, ementa text, no device', () => {
  const cases: [string, Record<string, unknown>[]][] = [
    ['annex of another norm', [tx(1, '<p>Art. 1º Aplicam-se as alíquotas constantes do Anexo da IN RFB 2.121, descritas abaixo.</p>'), an(2), tx(3, ART2)]],
    ['table of another norm', [tx(1, '<p>Art. 1º Observar-se-ão os valores da tabela da Lei nº 10.833, de 2003, relacionados abaixo.</p>'), an(2), tx(3, ART2)]],
    ['negation', [tx(1, '<p>Art. 1º Fica autorizada a exportação, não se aplicando as condições descritas abaixo.</p>'), an(2), tx(3, ART2)]],
    ['exclusion', [tx(1, '<p>Art. 1º Fica autorizada a exportação, exceto quanto aos produtos relacionados abaixo.</p>'), an(2), tx(3, ART2)]],
    ['ementa text in an article-typed segment', [tx(1, '<p>Dispõe sobre as operações descritas abaixo.</p>'), an(2), tx(3, ART2)]],
    ['no normative device', [tx(1, '<p>Seguem as especificações descritas abaixo.</p>'), an(2), tx(3, ART2)]],
  ];
  for (const [why, segs] of cases) assert.notEqual(runA(segs).referenceContext, 'operative_candidate', why);
  // the reference in an EMENTA segment (source type), right before the attachment, never promotes
  const viaEmenta = readRfbInlineAttachments(bytesOf({ idAto: 900004, tiposSegmento: [{ idTipoSegmento: 1, siglaTipoSegmento: 'ementa' }, { idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }],
    ementas: [{ ordemSegmentoAto: 1, idTipoSegmento: 1, textoIntegra: '<p>Autoriza a exportação de acordo com as especificações descritas abaixo.</p>' }],
    outrosSegmentos: [an(2), tx(3, ART2)] }), 900004)[0]!;
  assert.notEqual(viaEmenta.referenceContext, 'operative_candidate', 'ementa segment');
  // the real-shape positive case stays operative (device + clause pointing to what follows)
  // R4 (COORD decision on A3-2, supersedes R3): the citation of IN 1.155 is ACCESSORY (a dispensation clause), not the
  // object of the reference → the real ADE Cofis shape is promoted again by the fine rule (not by the old lexical one)
  assert.equal(runA([tx(1, '<p>Art. 1º Fica a empresa autorizada a exportar, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.</p>'), an(2), tx(3, ART2)]).referenceContext, 'operative_candidate');
});

test('R2 A-4: attachment HTML is untrusted — attributes never reach the reading (no text, no pointer target)', () => {
  const evil = '<table onclick="alert(1)" style="background:url(javascript:alert(2))"><tr onmouseover="x()"><td title="EVIL">Cell</td></tr></table>';
  const a = runA([tx(1, ART1), an(2, frag(evil)), tx(3, ART2)]);
  assert.equal(a.state, 'read'); assert.equal(a.html, evil, 'kept verbatim (provenance), never rendered here');
  for (const w of ['alert', 'javascript', 'onclick', 'onmouseover', 'EVIL']) assert.ok(!a.reading!.canonicalText.includes(w), w);
  assert.equal(a.reading!.canonicalText.trim(), 'Cell');
});

// ---- R3 (independent review R2 c.6785660153): A2-1 struck structure, A2-2 entities / negation / other norms ----
const promotes = (art: string) => runA([tx(1, `<p>${art}</p>`), an(2), tx(3, ART2)]).referenceContext === 'operative_candidate';

test('R3 A2-1: nested, unclosed or malformed strike and line-through never leave historical text live (no promotion)', () => {
  const cases: [string, string][] = [
    ['nested strike', 'Art. 1º Fica autorizada <strike>a <strike>x</strike> exportação de acordo com as especificações descritas abaixo.</strike>'],
    ['unclosed strike', 'Art. 1º Fica autorizada a exportação <strike>de acordo com as especificações descritas abaixo.'],
    ['nested s in del', 'Art. 1º Fica autorizada <del>a <s>x</s> exportação conforme os itens relacionados abaixo.</del>'],
    ['malformed s (stray close)', 'Art. 1º Fica autorizada a exportação</s> de acordo com as especificações descritas abaixo.'],
    ['span line-through', 'Art. 1º Fica autorizada <span style="text-decoration: line-through">a exportação de acordo com as especificações descritas abaixo.</span>'],
    ['span line-through on part, reference live', 'Art. 1º <span style="text-decoration:line-through">Antigo texto.</span> Fica autorizada a exportação de acordo com as especificações descritas abaixo.'],
    ['self-closing strike', 'Art. 1º Fica autorizada a exportação<strike/> de acordo com as especificações descritas abaixo.'],
    ['struck operative text + live final reference', 'Art. 1º <strike>Fica autorizada a exportação</strike> de acordo com as especificações descritas abaixo.'],
  ];
  for (const [why, art] of cases) assert.equal(promotes(art), false, why);
});

test('R3 A2-2: entities decoded; negation/exclusion anywhere in the sentence; any identified norm in the device; mixed text → no promotion', () => {
  const cases: [string, string][] = [
    ['entity N&atilde;o', 'Art. 1º N&atilde;o fica autorizada a exportação, de acordo com as especificações descritas abaixo.'],
    ['numeric entity n&#227;o', 'Art. 1º Fica autorizada, n&#227;o se aplicando as condições, de acordo com as especificações descritas abaixo.'],
    ['negation before the last comma', 'Art. 1º Não ficam autorizadas as operações, nos termos do processo, descritas abaixo.'],
    ['exclusion early in the sentence', 'Art. 1º Ressalvadas as hipóteses legais, fica autorizada a exportação, conforme os itens relacionados abaixo.'],
    ['IN 2.121 without "anexo"', 'Art. 1º Aplicam-se as regras da Instrução Normativa RFB nº 2.121, de 2022, descritas abaixo.'],
    // R4: "other norm > 200 chars before" and the mixed ADE Cofis shape are ACCESSORY citations now (see R4 A3-2);
    // the distant-norm case that still blocks is a norm in the OBJECT of the reference:
    ['other norm > 200 chars before, in the object', `Art. 1º ${'Observadas as demais condições aplicáveis, '.repeat(6)}aplicam-se as regras da Lei nº 10.833, de 2003, relacionadas abaixo.`],
    ['unknown entity', 'Art. 1º Fica autorizada a exporta&ccedil;&atildx; de acordo com as especificações descritas abaixo.'],
  ];
  for (const [why, art] of cases) assert.equal(promotes(art), false, why);
  // clean device + clean reference still promotes
  assert.equal(promotes('Art. 1º Fica a empresa autoriza&ccedil;&atilde;o a exportar, de acordo com as especifica&ccedil;&otilde;es descritas abaixo.'), true, 'decoded entities, no negation, no norm');
  assert.equal(promotes('Art. 1º Fica a empresa autorizada a exportar, de acordo com as especificações descritas abaixo.'), true);
});

// ---- R4 (review R3 A3-1/A3-2, COORD decision): struck by explicit CSS class; accessory foundation ≠ the norm that
// defines the content referenced. Ambiguity keeps the conservative result. ----
test('R4 A3-1: an explicit strike CSS class (tachado, riscado, strike, line-through…) is struck text → no promotion', () => {
  for (const cls of ['tachado', 'texto-tachado', 'riscado', 'strike', 'strikethrough', 'line-through', 'Tachado'])
    assert.equal(promotes(`Art. 1º Fica autorizada <span class="${cls}">a exportação de acordo com as especificações descritas abaixo.</span>`), false, cls);
  assert.equal(promotes('Art. 1º Fica a empresa autorizada a exportar, <span class="destaque">de acordo com as especificações descritas abaixo.</span>'), true, 'a non-strike class changes nothing');
});

test('R4 A3-2: an ACCESSORY citation (foundation, dispensation) does not block; a norm tied to the OBJECT of the reference does', () => {
  const pos: [string, string][] = [
    ['ADE Cofis real shape (accessory "dispensadas … da IN 1.155")', 'Art. 1º Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
    ['COORD example 1 (dispensation, then own conditions)', 'Art. 1º Dispensadas as exigências previstas na Instrução Normativa RFB nº 1.155, de 2011, ficam estabelecidas as condições descritas abaixo.'],
    ['foundation "nos termos da Lei nº …" then own object', 'Art. 1º Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as especificações descritas abaixo.'],
    ['&nbsp; inside the reference', 'Art. 1º Fica autorizada a exportação de acordo com as especificações descritas&nbsp;abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(art), true, why);
  const neg: [string, string][] = [
    ['annex of another norm is the object', 'Art. 1º Aplicam-se as alíquotas constantes do Anexo da IN RFB 2.121, descritas abaixo.'],
    ['rules of another norm are the object (elliptical reference)', 'Art. 1º Aplicam-se as regras da Instrução Normativa RFB nº 2.121, de 2022, descritas abaixo.'],
    ['another norm inside the referenced noun phrase', 'Art. 1º Fica autorizada a exportação das mercadorias da Instrução Normativa RFB nº 2.121, de 2022 relacionadas abaixo.'],
    ['COORD example 2 (content of another act, no own reference)', 'Art. 1º Aplicam-se as condições constantes do Anexo I da Instrução Normativa RFB nº 1.155, de 2011.'],
    ['elliptical reference right after an accessory citation (ambiguous)', 'Art. 1º Fica autorizada a exportação, nos termos da Instrução Normativa RFB nº 1.155, de 2011, descritas abaixo.'],
    ['negation still sentence-wide', 'Art. 1º Não ficam autorizadas, nos termos da Instrução Normativa RFB nº 1.155, de 2011, as operações descritas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(art), false, why);
});

// ---- R5 (review R4 c.6796232552 + COORD decision): A4-1 remission connectors, A4-2 class forms, operative prohibition ----
test('R5 A4-1: a remission connector ties the reference to the ANTECEDENT clause; a norm there blocks unless that clause is accessory', () => {
  const neg: [string, string][] = [
    ['conforme + norm in antecedent', 'Art. 1º Aplicam-se as alíquotas previstas na IN RFB nº 2.121, de 2022, conforme especificações descritas abaixo.'],
    ['nos termos + annex of another norm', 'Art. 1º Ficam reproduzidos os valores do Anexo da IN RFB nº 2.121, nos termos indicados abaixo.'],
    ['cujos + norm in antecedent', 'Art. 1º Ficam mantidos os limites da Portaria RFB nº 10, de 2020, cujos valores atualizados estão descritos abaixo.'],
    ['norm kind without number in antecedent', 'Art. 1º Aplicam-se as regras da IN, conforme especificações descritas abaixo.'],
    ['na forma + norm', 'Art. 1º Observar-se-ão os prazos do Decreto nº 7.212, de 2010, na forma descrita abaixo.'],
    ['segundo + norm', 'Art. 1º Valem os coeficientes da Lei nº 10.833, de 2003, segundo os valores relacionados abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(art), false, why);
  const pos: [string, string][] = [
    ['ADE Cofis shape: antecedent is accessory ("dispensadas …")', 'Art. 1º Fica a empresa autorizada a exportar, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
    ['accessory "com fundamento em"', 'Art. 1º Fica aprovado o modelo, com fundamento na Lei nº 9.532, de 1997, conforme especificações descritas abaixo.'],
    ['accessory "observado"', 'Art. 1º Fica autorizada a operação, observado o Decreto nº 7.212, de 2010, de acordo com as condições descritas abaixo.'],
    ['connector without any norm', 'Art. 1º Fica autorizada a exportação, conforme as especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(art), true, why);
});

test('R5 A4-2: unquoted and camelCase strike classes are struck', () => {
  for (const attr of ['class=tachado', 'class=textoTachado', "class='TextoRiscado'", 'class="itemTachadoAntigo"', 'class=riscado'])
    assert.equal(promotes(`Art. 1º Fica autorizada <span ${attr}>a exportação de acordo com as especificações descritas abaixo.</span>`), false, attr);
});

test('R5 prohibition (COORD): an operative PROHIBITION whose object is the referenced content links the table; polarity is internal only', async () => {
  const { referencePolarity } = await import('../src/modules/anatomy/rfb-inline-attachments.js');
  const pos = ['Art. 1º Fica vedada a exportação das mercadorias relacionadas abaixo.', 'Art. 1º É vedada a aplicação das condições descritas abaixo.',
    'Art. 1º Fica proibida a importação dos produtos relacionados abaixo.'];
  for (const art of pos) { assert.equal(promotes(art), true, art); assert.equal(referencePolarity(art), 'prohibition', art); }
  // operative_candidate is NOT "permitted": permission / obligation are told apart, internally
  assert.equal(referencePolarity('Art. 1º Fica autorizada a exportação das mercadorias relacionadas abaixo.'), 'permission');
  assert.equal(referencePolarity('Art. 1º Os contribuintes deverão observar as condições descritas abaixo.'), 'obligation');
  // the polarity never becomes a persisted field or changes legalStatus
  const a = runA([tx(1, `<p>${pos[0]}</p>`), an(2), tx(3, ART2)]);
  assert.equal(a.referenceContext, 'operative_candidate'); assert.ok(!('referencePolarity' in a), 'no new field on the attachment');
  assert.ok(a.reading!.parts.every((x) => x.legalStatus === 'unknown'));
  const neg: [string, string][] = [
    ['negation of applicability', 'Art. 1º Não se aplicam as condições descritas abaixo.'],
    ['exclusion', 'Art. 1º Fica vedada a exportação, exceto das mercadorias relacionadas abaixo.'],
    ['prohibition not in the reference clause (elliptical)', 'Art. 1º Fica vedada a exportação, descritas abaixo.'],
    ['prohibition + another norm in the object', 'Art. 1º Fica vedada a aplicação das condições da IN RFB nº 2.121, de 2022 descritas abaixo.'],
    ['prohibition in an earlier clause, reference elsewhere', 'Art. 1º É vedado o uso do regime anterior; ficam estabelecidas as condições, conforme a IN RFB nº 2.121, de 2022, descritas abaixo.'],
    ['struck prohibition', 'Art. 1º <strike>Fica vedada</strike> a exportação das mercadorias relacionadas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(art), false, why);
});

// ---- R6 (review R5 c.6796999886 + COORD): A5-1 the governing clause CHAIN of a remission; A5-2 an elliptical
// remission needs a provable nominal antecedent. Ambiguity never promotes; nothing crosses a sentence/device. ----
test('R6 A5-1: a remission follows the clause chain back to the GOVERNING clause; a norm there blocks however far back (same sentence)', () => {
  const neg: [string, string][] = [
    ['reviewer A5-1 (norm two clauses before "conforme")', 'Aplicam-se os valores da Instrução Normativa RFB nº 2.121, de 2022, atualizados mensalmente, conforme especificações descritas abaixo.'],
    ['three modifier clauses', 'Aplicam-se os valores da Lei nº 10.833, de 2003, atualizados mensalmente, corrigidos anualmente, nos termos indicados abaixo.'],
    ['an intermediate connector clause is not a governing clause', 'Aplicam-se os valores da IN RFB nº 2.121, de 2022, conforme o caso, atualizados, conforme especificações descritas abaixo.'],
    ['na forma, two clauses back', 'Observar-se-ão os prazos do Decreto nº 7.212, de 2010, contados da ciência, na forma descrita abaixo.'],
    ['segundo, two clauses back', 'Valem os coeficientes da Lei nº 10.833, de 2003, revistos, segundo os valores relacionados abaixo.'],
    ['de acordo com, two clauses back', 'Aplicam-se as alíquotas do Anexo da IN RFB nº 2.121, vigentes, de acordo com as especificações descritas abaixo.'],
    ['cujos, two clauses back', 'Ficam mantidos os limites da Portaria RFB nº 10, de 2020, revisados, cujos valores estão descritos abaixo.'],
    ['bare norm kind two clauses back', 'Aplicam-se as regras da IN, atualizadas, conforme especificações descritas abaixo.'],
    ['"nº." and "arts." abbreviations never end the sentence', 'Aplicam-se os valores dos arts. 2º e 3º da IN RFB nº. 2.121, de 2022, atualizados, conforme especificações descritas abaixo.'],
    ['modifier clause holding a noun phrase is traversed', 'Aplicam-se os valores da Lei nº 10.833, de 2003, publicados no Diário Oficial, conforme especificações descritas abaixo.'],
    ['elliptical reference right after an ACCESSORY clause (nearest noun is the other norm\'s)', 'Fica autorizada a exportação, dispensadas as exigências da Instrução Normativa RFB nº 1.155, de 2011, descritas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['governing clause of the act itself, modifiers between', 'Ficam aprovados os modelos de declaração, atualizados anualmente, conforme especificações descritas abaixo.'],
    ['B: accessory foundation before the governing clause is not a block', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['B: accessory clause skipped, governing clause clean', 'Fica aprovado o modelo, com fundamento na Lei nº 9.532, de 1997, conforme especificações descritas abaixo.'],
    ['ADE Cofis real shape', 'Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
    ['E: a norm in an EARLIER sentence of the device is not inherited', 'Revoga-se a Lei nº 10.833, de 2003. Ficam aprovados os modelos, atualizados, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R6 A5-2: an elliptical remission without a provable nominal antecedent never promotes; a real antecedent still does', () => {
  const neg: [string, string][] = [
    ['reviewer A5-2', 'Art. 1º Conforme descritas abaixo.'],
    ['bare participle', 'Art. 1º Descritas abaixo.'],
    ['nos termos, nothing before', 'Art. 1º Nos termos relacionados abaixo.'],
    ['connector + own noun, no governing clause', 'Art. 1º Conforme especificações descritas abaixo.'],
    ['de acordo com, nothing before', 'Art. 1º De acordo com as especificações descritas abaixo.'],
    ['only modifiers before', 'Art. 1º Atualizados mensalmente, conforme especificações descritas abaixo.'],
    ['E: antecedent only in an EARLIER sentence', 'Art. 1º Ficam aprovados os modelos. Conforme descritos abaixo.'],
    ['E: antecedent only before a semicolon', 'Art. 1º Ficam aprovados os modelos; conforme descritos abaixo.'],
    ['paragraph label then elliptical', '§ 1º Conforme descritas abaixo.'],
    ['inciso label then elliptical', 'I - conforme relacionados abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(art), false, why);
  const pos: [string, string][] = [
    ['elliptical with a clean nominal antecedent', 'Art. 1º Ficam aprovados os modelos de declaração, descritos abaixo.'],
    ['connector with a clean nominal antecedent', 'Art. 1º Fica autorizada a exportação, conforme as especificações descritas abaixo.'],
    ['own clause with its own object (no remission)', 'Art. 1º Ficam aprovadas as tabelas descritas abaixo.'],
    ['paragraph with own object', '§ 1º Ficam aprovadas as tabelas descritas abaixo.'],
    ['inciso with own object', 'I - os modelos relacionados abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(art), true, why);
});

test('R6 G/H/I: negation, exclusion, prohibitions and strike classes keep their R5 outcome through the clause chain', async () => {
  const { referencePolarity } = await import('../src/modules/anatomy/rfb-inline-attachments.js');
  assert.equal(promotes('Art. 1º Fica vedada a exportação das mercadorias, conforme as especificações descritas abaixo.'), false, 'prohibition reached only via connector');
  assert.equal(promotes('Art. 1º Fica vedada a exportação das mercadorias relacionadas abaixo.'), true, 'prohibition in the same clause');
  assert.equal(referencePolarity('Art. 1º Fica vedada a exportação das mercadorias relacionadas abaixo.'), 'prohibition');
  assert.equal(promotes('Art. 1º Aplicam-se os valores, atualizados, exceto os relacionados abaixo.'), false, 'exclusion');
  assert.equal(promotes('Art. 1º Não se aplicam os valores, atualizados, conforme descritos abaixo.'), false, 'negation');
  assert.equal(promotes('Art. 1º Ficam aprovados os modelos, <span class=textoTachado>conforme especificações descritas abaixo.</span>'), false, 'strike class');
});

// ---- R7 (review R6 c.6878815016 + COORD): A6-1 an intermediate nominal clause never hides a non-accessory norm
// citation earlier in the same sentence; abbreviated norm kinds (Dec., Instr., Port., Res.) neither end a sentence nor
// escape the citation rules. ----
test('R7 A6-1: a non-accessory norm citation in ANY earlier clause of the same sentence blocks a remission', () => {
  const neg: [string, string][] = [
    ['reviewer 1 (nominal clause between)', 'Ficam mantidos os limites da Portaria RFB nº 10, de 2020, e os respectivos valores, conforme especificações descritas abaixo.'],
    ['reviewer 2', 'Aplicam-se as regras da Instrução Normativa RFB nº 2.121, de 2022, e os valores dela constantes, conforme especificações descritas abaixo.'],
    ['reviewer 3 (two nominal clauses between)', 'Observa-se o disposto na Lei nº 10.833, de 2003, quanto aos produtos, aos prazos nela previstos, conforme relação a seguir:'],
    ['reviewer 4 (embedded "por força da")', 'Aplicam-se, por força da Portaria Conjunta RFB nº 10, os valores atualizados, conforme especificações descritas abaixo.'],
    ['reviewer 5 (embedded "nos termos do")', 'Aplicam-se, nos termos do Decreto Federal nº 7.212, os valores atualizados, conforme especificações descritas abaixo.'],
    ['annex of another norm two clauses back', 'Aplicam-se as alíquotas constantes do Anexo da IN RFB, e os respectivos limites, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['ADE Cofis real shape (accessory "dispensadas … IN 1.155" skipped)', 'Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
    ['accessory "com fundamento na" between', 'Fica aprovado o modelo, com fundamento na Lei nº 9.532, de 1997, e os respectivos campos, conforme especificações descritas abaixo.'],
    ['fronted foundation "Nos termos da Lei …" opening the sentence', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['no norm anywhere, nominal clauses between', 'Ficam aprovados os modelos, e os respectivos campos, conforme especificações descritas abaixo.'],
    ['norm only in an earlier SENTENCE', 'Fica revogada a Portaria RFB nº 10, de 2020. Ficam aprovados os modelos, e os respectivos campos, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R7 abbreviations: Dec., Instr., Port. and Res. never end a sentence and cite a norm like the full forms; real sentence ends hold', () => {
  const pairs: [string, string, string][] = [
    ['Decreto', 'Aplicam-se os valores do Decreto Federal nº 7.212 aos produtos exportados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do Dec. Federal nº 7.212 aos produtos exportados, conforme especificações descritas abaixo.'],
    ['Instrução Normativa', 'Aplicam-se os valores da Instrução Normativa RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Instr. Normativa RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Portaria', 'Aplicam-se os valores da Portaria RFB nº 10 às operações indicadas, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Port. RFB nº 10 às operações indicadas, conforme especificações descritas abaixo.'],
    ['Resolução', 'Aplicam-se os valores da Resolução Gecex nº 272 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Res. Gecex nº 272 aos produtos listados, conforme especificações descritas abaixo.'],
  ];
  for (const [kind, full, abbr] of pairs) {
    assert.equal(promotes(`Art. 1º ${full}`), false, `${kind}: full form`);
    assert.equal(promotes(`Art. 1º ${abbr}`), false, `${kind}: abbreviated form behaves like the full form`);
  }
  // controls: a REAL sentence end (after a number, or after a word that is not an abbreviation) still isolates the norm
  const ends: [string, string][] = [
    ['ends after the act number', 'Fica revogada a Res. Gecex nº 272. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['ends after a year', 'Fica revogado o art. 2º do Dec. nº 7.212, de 2010. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['ends after a plain word', 'Fica revogada a Port. RFB nº 10 nesta data. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of ends) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

// ---- R8 (review R7 c.6879106553 + COORD): R7-ACC an accessory word only counts when it OPENS the clause; R7-FRONT a
// foundation citation is classified by its FUNCTION (accessory only when the main clause is constitutive — authorizes,
// approves, institutes — never when it applies or maintains content), the same at the start or in the middle;
// R7-ABBR a conservative sentence boundary near abbreviated citations, composite abbreviations cited like full forms. ----
test('R8 R7-ACC: "observados"/"dispensados" inside a clause never make it accessory; the citation counts', () => {
  const neg: [string, string][] = [
    ['reviewer ACC-1 (internal "observados na Portaria")', 'Aplicam-se os valores observados na Portaria RFB nº 10, de 2020, e os respectivos limites, conforme especificações descritas abaixo.'],
    ['reviewer ACC-2 (internal "dispensados pela IN")', 'Ficam mantidos os valores dispensados pela Instrução Normativa RFB nº 2.121, e as respectivas alíquotas, conforme especificações descritas abaixo.'],
    ['internal "observadas" with a Decreto', 'Ficam estabelecidas as condições observadas no Decreto nº 7.212, de 2010, e os prazos, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['control: "observada a Lei" opening its clause', 'Fica autorizada a operação, observada a Lei nº 9.532, de 1997, conforme especificações descritas abaixo.'],
    ['control: ADE Cofis real shape ("dispensadas" opening its clause)', 'Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R8 R7-FRONT: a foundation citation is judged by function — same result at the start and in the middle', () => {
  const neg: [string, string][] = [
    ['reviewer FRONT-1 (start, applies)', 'Nos termos da Portaria RFB nº 10, de 2020, aplicam-se os valores, conforme especificações descritas abaixo.'],
    ['reviewer FRONT-2 (start, applies)', 'Com base na Instrução Normativa RFB nº 2.121, aplicam-se as alíquotas, conforme especificações descritas abaixo.'],
    ['pair: applies, middle', 'Aplicam-se, nos termos da Portaria RFB nº 10, de 2020, os valores, conforme especificações descritas abaixo.'],
    ['pair: maintains, start', 'Com fundamento na Lei nº 10.833, de 2003, ficam mantidos os limites, conforme especificações descritas abaixo.'],
    ['pair: maintains, middle', 'Ficam mantidos, com fundamento na Lei nº 10.833, de 2003, os limites, conforme especificações descritas abaixo.'],
    ['pair: "observar-se-ão", start', 'Por força do Decreto nº 7.212, de 2010, observar-se-ão os prazos, conforme especificações descritas abaixo.'],
    ['pair: "observar-se-ão", middle', 'Observar-se-ão, por força do Decreto nº 7.212, de 2010, os prazos, conforme especificações descritas abaixo.'],
    ['ambiguous main clause (no constitutive verb) → no promotion', 'Nos termos da Lei nº 9.532, de 1997, os modelos, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['pair: authorizes, start', 'Nos termos da Lei nº 9.532, de 1997, fica a empresa autorizada a exportar, conforme especificações descritas abaixo.'],
    ['pair: authorizes, middle', 'Fica a empresa autorizada, nos termos da Lei nº 9.532, de 1997, a exportar, conforme especificações descritas abaixo.'],
    ['pair: approves, start', 'Com base na Lei nº 9.532, de 1997, ficam aprovados os modelos, conforme especificações descritas abaixo.'],
    ['pair: approves, middle', 'Ficam aprovados, com base na Lei nº 9.532, de 1997, os modelos, conforme especificações descritas abaixo.'],
    ['pair: institutes, start', 'Por força da Lei nº 9.532, de 1997, fica instituído o modelo, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R8 R7-ABBR: composite abbreviations cite like the full forms; a capitalized short token before "." never ends the sentence; real ends hold', () => {
  const pairs: [string, string, string][] = [
    ['Portaria Conjunta', 'Aplicam-se os valores da Portaria Conjunta RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Port. Conj. RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Ato Declaratório Interpretativo', 'Aplicam-se os valores do Ato Declaratório Interpretativo RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do Ato Decl. Interpr. RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Ato Declaratório Executivo', 'Aplicam-se os valores do Ato Declaratório Executivo Cosit nº 5 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do Ato Decl. Exec. Cosit nº 5 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Solução de Consulta', 'Aplicam-se os valores da Solução de Consulta Cosit nº 258 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Sol. de Consulta Cosit nº 258 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Instrução Normativa (Instr. Norm.)', 'Aplicam-se os valores da Instrução Normativa RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Instr. Norm. RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.'],
    // composite forms beyond the reviewer's examples
    ['Resolução Conjunta', 'Aplicam-se os valores da Resolução Conjunta RFB/PGFN nº 3 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Res. Conj. RFB/PGFN nº 3 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Decreto Legislativo', 'Aplicam-se os valores do Decreto Legislativo nº 186 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do Dec. Leg. nº 186 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Portaria Interministerial', 'Aplicam-se os valores da Portaria Interministerial MF/MDIC nº 4 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Port. Interm. MF/MDIC nº 4 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Solução de Consulta (Sol. Cons.)', 'Aplicam-se os valores da Solução de Consulta Cosit nº 9 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Sol. Cons. Cosit nº 9 aos produtos listados, conforme especificações descritas abaixo.'],
  ];
  for (const [kind, full, abbr] of pairs) {
    assert.equal(promotes(`Art. 1º ${full}`), false, `${kind}: full form`);
    assert.equal(promotes(`Art. 1º ${abbr}`), false, `${kind}: abbreviated form behaves like the full form`);
  }
  const ends: [string, string][] = [
    ['ends after a number', 'Fica revogada a Port. Conj. RFB/PGFN nº 1. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['ends after a year', 'Fica revogado o Ato Decl. Interpr. RFB nº 5, de 2019. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['ends after a lowercase word', 'Fica revogada a Sol. de Consulta Cosit nº 258 nesta data. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['";" still a boundary', 'Fica revogada a Instr. Norm. RFB nº 2.121; ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of ends) assert.equal(promotes(`Art. 1º ${art}`), true, why);
  // ":" and a new device still isolate (no inheritance across them)
  assert.equal(promotes('Art. 1º Fica revogada a Port. Conj. RFB/PGFN nº 1: ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'), true, '":" boundary');
  assert.equal(promotes('§ 1º Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'), true, 'new device');
});

// ---- R9 (review R8 c.6882637201 + COORD): R8-CST a cited norm whose content the object RESUMES ("nela previstas", "dela
// constantes", "previstos na referida …") governs even under a constitutive verb; R8-LOW abbreviated norms are recognized
// whatever the case; R8-MRG a following sentence that opens with a remission is never merged into the previous one. ----
test('R9 R8-CST: resumption of the cited norm makes it governing under a constitutive verb — start and middle; own content still promotes', () => {
  const neg: [string, string][] = [
    ['reviewer CST-1 (start, "nela previstas")', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas nela previstas, conforme tabela a seguir:'],
    ['reviewer CST-2 (middle, "nela previstas")', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas nela previstas, conforme tabela a seguir:'],
    ['reviewer CST-3 (middle, "dela constantes")', 'Ficam estabelecidos, por força da Portaria RFB nº 10, os valores dela constantes, conforme especificações descritas abaixo.'],
    ['start, "dela constantes"', 'Por força da Portaria RFB nº 10, ficam estabelecidos os valores dela constantes, conforme especificações descritas abaixo.'],
    ['start, explicit "previstos na referida"', 'Com base na Lei nº 10.833, de 2003, ficam aprovados os limites previstos na referida norma, conforme especificações descritas abaixo.'],
    ['middle, explicit "constantes da mesma"', 'Fica instituída, com fundamento na Lei nº 10.833, de 2003, a tabela de valores constantes da mesma, conforme especificações descritas abaixo.'],
    ['start, "neles previstos"', 'Nos termos dos Decretos nº 7.212 e nº 8.950, ficam aprovados os prazos neles previstos, conforme especificações descritas abaixo.'],
    ['accessory "observada" + resumption', 'Fica autorizada a operação, observada a Lei nº 9.532, de 1997, conforme os valores nela previstos, descritos abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['own content, start', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovados os modelos de declaração, conforme especificações descritas abaixo.'],
    ['own content, middle', 'Ficam aprovados, com fundamento na Lei nº 9.532, de 1997, os modelos de declaração, conforme especificações descritas abaixo.'],
    ['own content, authorization', 'Nos termos da Lei nº 9.532, de 1997, fica a empresa autorizada a exportar, conforme especificações descritas abaixo.'],
    ['"deste ato" is the act itself', 'Com base na Lei nº 9.532, de 1997, ficam aprovados os modelos deste ato, conforme especificações descritas abaixo.'],
    ['ADE Cofis real shape', 'Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R9 R8-LOW: abbreviated norms are recognized in lower, upper and mixed case; real boundaries hold', () => {
  const pairs: [string, string, string][] = [
    ['port. conj. (lower)', 'Aplicam-se os valores da Portaria Conjunta RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da port. conj. RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.'],
    ['instr. norm. (lower)', 'Aplicam-se os valores da Instrução Normativa RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da instr. norm. RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.'],
    ['ato decl. interpr. (lower)', 'Aplicam-se os valores do Ato Declaratório Interpretativo RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do ato decl. interpr. RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.'],
    ['PORT. CONJ. (upper)', 'Aplicam-se os valores da PORTARIA CONJUNTA RFB/PGFN Nº 1 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da PORT. CONJ. RFB/PGFN Nº 1 aos produtos listados, conforme especificações descritas abaixo.'],
    ['INSTR. NORM. (upper)', 'Aplicam-se os valores da INSTRUÇÃO NORMATIVA RFB Nº 2.121 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da INSTR. NORM. RFB Nº 2.121 aos produtos listados, conforme especificações descritas abaixo.'],
    ['ATO DECL. INTERPR. (upper)', 'Aplicam-se os valores do ATO DECLARATÓRIO INTERPRETATIVO RFB Nº 5 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do ATO DECL. INTERPR. RFB Nº 5 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Port. conj. (mixed)', 'Aplicam-se os valores da Portaria Conjunta RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Port. conj. RFB/PGFN nº 1 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Instr. norm. (mixed)', 'Aplicam-se os valores da Instrução Normativa RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores da Instr. norm. RFB nº 2.121 aos produtos listados, conforme especificações descritas abaixo.'],
    ['Ato decl. Interpr. (mixed)', 'Aplicam-se os valores do Ato Declaratório Interpretativo RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.', 'Aplicam-se os valores do Ato decl. Interpr. RFB nº 5 aos produtos listados, conforme especificações descritas abaixo.'],
  ];
  for (const [kind, full, abbr] of pairs) {
    assert.equal(promotes(`Art. 1º ${full}`), false, `${kind}: full form`);
    assert.equal(promotes(`Art. 1º ${abbr}`), false, `${kind}: abbreviated form behaves like the full form`);
  }
  const ends: [string, string][] = [
    ['lower abbreviation, sentence ends after the number', 'Fica revogada a port. conj. RFB/PGFN nº 1. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['lower abbreviation, sentence ends after the year', 'Fica revogado o ato decl. interpr. RFB nº 5, de 2019. Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['lower abbreviation, ";"', 'Fica revogada a instr. norm. RFB nº 2.121; ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
    ['lower abbreviation, ":"', 'Fica revogada a instr. norm. RFB nº 2.121: ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of ends) assert.equal(promotes(`Art. 1º ${art}`), true, why);
  assert.equal(promotes('§ 1º Ficam aprovados os modelos, revisados, conforme especificações descritas abaixo.'), true, 'new device');
});

test('R9 R8-MRG: a sentence that opens with a remission is never merged into the previous one (unresolved → no promotion)', () => {
  const neg: [string, string][] = [
    ['reviewer MRG-1 (after "RFB.")', 'Fica aprovado o modelo pela RFB. Conforme especificações descritas abaixo.'],
    ['after a lower abbreviation', 'Fica aprovado o modelo pela port. Conforme especificações descritas abaixo.'],
    ['"Nos termos" after "Cosit."', 'Fica aprovado o modelo pela Cosit. Nos termos indicados abaixo.'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
});

// ---- R10 (review R9 c.6883978202 + COORD): R9-RES the ORIGIN of the approved object under a constitutive verb — any
// provision participle or locative/anaphoric/possessive marker resumes the cited norm unless an express self-reference
// names the act itself; R9-ANA a sentence opening with a resumption needs its own evidence of origin (no inheritance)
test('R10 R9-RES: an object that resumes the cited norm never promotes — reviewer cases and novel variants, start and middle; own content promotes', () => {
  const neg: [string, string][] = [
    ['R9 case start: previstas no ato acima citado', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no ato acima citado, conforme tabela a seguir:'],
    ['R9 case middle: previstas no ato acima citado', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no ato acima citado, conforme tabela a seguir:'],
    ['R9 case start: previstas no supracitado ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no supracitado ato, conforme tabela a seguir:'],
    ['R9 case middle: previstas no supracitado ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no supracitado ato, conforme tabela a seguir:'],
    ['R9 case start: previstas no aludido diploma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no aludido diploma, conforme tabela a seguir:'],
    ['R9 case middle: previstas no aludido diploma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no aludido diploma, conforme tabela a seguir:'],
    ['R9 case start: previstas naquele diploma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas naquele diploma, conforme tabela a seguir:'],
    ['R9 case middle: previstas naquele diploma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas naquele diploma, conforme tabela a seguir:'],
    ['R9 case start: previstas no diploma referido', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no diploma referido, conforme tabela a seguir:'],
    ['R9 case middle: previstas no diploma referido', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no diploma referido, conforme tabela a seguir:'],
    ['R9 case start: ali previstas', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:'],
    ['R9 case middle: ali previstas', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas ali previstas, conforme tabela a seguir:'],
    ['R9 case start: lá estabelecidas', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas lá estabelecidas, conforme tabela a seguir:'],
    ['R9 case middle: lá estabelecidas', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas lá estabelecidas, conforme tabela a seguir:'],
    ['R9 case start: previstas na norma em referência', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas na norma em referência, conforme tabela a seguir:'],
    ['R9 case middle: previstas na norma em referência', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas na norma em referência, conforme tabela a seguir:'],
    ['R9 case start: previstas no mencionado diploma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no mencionado diploma, conforme tabela a seguir:'],
    ['R9 case middle: previstas no mencionado diploma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no mencionado diploma, conforme tabela a seguir:'],
    ['R9 case start: previstas no ato mencionado', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no ato mencionado, conforme tabela a seguir:'],
    ['R9 case middle: previstas no ato mencionado', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no ato mencionado, conforme tabela a seguir:'],
    ['R9 case start: constantes de seu Anexo', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas constantes de seu Anexo, conforme tabela a seguir:'],
    ['R9 case middle: constantes de seu Anexo', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas constantes de seu Anexo, conforme tabela a seguir:'],
    ['R9 case start: fixadas pela IN acima', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas fixadas pela IN acima, conforme tabela a seguir:'],
    ['R9 case middle: fixadas pela IN acima', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas fixadas pela IN acima, conforme tabela a seguir:'],
    ['R9 case start: previstas no citado ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no citado ato, conforme tabela a seguir:'],
    ['R9 case middle: previstas no citado ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no citado ato, conforme tabela a seguir:'],
    ['novel start: nela fixadas', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas nela fixadas, conforme tabela a seguir:'],
    ['novel middle: nela fixadas', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas nela fixadas, conforme tabela a seguir:'],
    ['novel start: constantes do ato supra', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas constantes do ato supra, conforme tabela a seguir:'],
    ['novel middle: constantes do ato supra', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas constantes do ato supra, conforme tabela a seguir:'],
    ['novel start: definidas no precitado diploma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas definidas no precitado diploma, conforme tabela a seguir:'],
    ['novel middle: definidas no precitado diploma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas definidas no precitado diploma, conforme tabela a seguir:'],
    ['novel start: estabelecidas pelo retrocitado ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas estabelecidas pelo retrocitado ato, conforme tabela a seguir:'],
    ['novel middle: estabelecidas pelo retrocitado ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas estabelecidas pelo retrocitado ato, conforme tabela a seguir:'],
    ['novel start: previstas nos seus anexos', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas nos seus anexos, conforme tabela a seguir:'],
    ['novel middle: previstas nos seus anexos', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas nos seus anexos, conforme tabela a seguir:'],
    ['novel start: dele constantes', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas dele constantes, conforme tabela a seguir:'],
    ['novel middle: dele constantes', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas dele constantes, conforme tabela a seguir:'],
    ['novel start: previstas', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas, conforme tabela a seguir:'],
    ['novel middle: previstas', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas, conforme tabela a seguir:'],
    ['novel start: fixadas na mesma norma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas fixadas na mesma norma, conforme tabela a seguir:'],
    ['novel middle: fixadas na mesma norma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas fixadas na mesma norma, conforme tabela a seguir:'],
    ['novel start: previstas em tal ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas em tal ato, conforme tabela a seguir:'],
    ['novel middle: previstas em tal ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas em tal ato, conforme tabela a seguir:'],
    ['novel start: previstas nessa norma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas nessa norma, conforme tabela a seguir:'],
    ['novel middle: previstas nessa norma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas nessa norma, conforme tabela a seguir:'],
    ['novel start: contidas no Anexo daquela Instrução', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas contidas no Anexo daquela Instrução, conforme tabela a seguir:'],
    ['novel middle: contidas no Anexo daquela Instrução', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas contidas no Anexo daquela Instrução, conforme tabela a seguir:'],
    ['novel start: previstas nesta e na Instrução Normativa RFB nº 1.155', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas nesta e na Instrução Normativa RFB nº 1.155, conforme tabela a seguir:'],
    ['novel middle: previstas nesta e na Instrução Normativa RFB nº 1.155', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas nesta e na Instrução Normativa RFB nº 1.155, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['own start: previstas nesta Portaria', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas nesta Portaria, conforme tabela a seguir:'],
    ['own middle: previstas nesta Portaria', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas nesta Portaria, conforme tabela a seguir:'],
    ['own start: previstas no Anexo desta Portaria', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas no Anexo desta Portaria, conforme tabela a seguir:'],
    ['own middle: previstas no Anexo desta Portaria', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no Anexo desta Portaria, conforme tabela a seguir:'],
    ['own start: previstas neste ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas neste ato, conforme tabela a seguir:'],
    ['own middle: previstas neste ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas neste ato, conforme tabela a seguir:'],
    ['own start: fixadas pela presente Portaria', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas fixadas pela presente Portaria, conforme tabela a seguir:'],
    ['own middle: fixadas pela presente Portaria', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas fixadas pela presente Portaria, conforme tabela a seguir:'],
    ['own start: de referência', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['own middle: de referência', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas de referência, conforme tabela a seguir:'],
    ['own start: de referência para 2023', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas de referência para 2023, conforme tabela a seguir:'],
    ['own middle: de referência para 2023', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas de referência para 2023, conforme tabela a seguir:'],
    ['own start: aplicáveis aos cigarros', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas aplicáveis aos cigarros, conforme tabela a seguir:'],
    ['own middle: aplicáveis aos cigarros', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas aplicáveis aos cigarros, conforme tabela a seguir:'],
    ['own, foundation at the start, Lei, "nesta Portaria"', 'Nos termos da Lei nº 9.532, de 1997, ficam instituídas as alíquotas previstas nesta Portaria, conforme tabela a seguir:'],
    ['own, Cofis-like accessory dispensation', 'Fica a empresa autorizada a exportar cigarros, dispensadas as exigências dos arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
    ['own, foundation + authorization', 'Nos termos da Lei nº 9.532, de 1997, fica a empresa autorizada a exportar os produtos, conforme especificações descritas abaixo.'],
    ['own, models, start', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovados os modelos de declaração, conforme especificações descritas abaixo.'],
    ['own, models, middle', 'Ficam aprovados, nos termos da Lei nº 9.532, de 1997, os modelos de declaração, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R10 R9-ANA: a sentence opening with a resumption never inherits across the sentence boundary; controls without resumption promote', () => {
  const neg: [string, string][] = [
    ['reviewer P2 (abbreviated norm, "Os mesmos")', 'Aplicam-se os valores da instr. norm. RFB nº 2.121. Os mesmos valores, conforme especificações descritas abaixo.'],
    ['"Tais"', 'Aplicam-se os valores da IN RFB nº 2.121. Tais valores, conforme especificações descritas abaixo.'],
    ['"Esses"', 'Aplicam-se os valores da IN RFB nº 2.121. Esses produtos ficam sujeitos aos valores, conforme especificações descritas abaixo.'],
    ['"Os referidos"', 'Aplicam-se os valores da IN RFB nº 2.121. Os referidos itens ficam sujeitos aos valores, conforme especificações descritas abaixo.'],
    ['"Aqueles"', 'Aplicam-se os valores da IN RFB nº 2.121. Aqueles valores, conforme especificações descritas abaixo.'],
    ['"As mesmas"', 'Revoga-se a IN RFB nº 2.121. As mesmas alíquotas ficam mantidas, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['resumption with its own express self-reference', 'Revoga-se a IN RFB nº 2.121. Os mesmos valores previstos nesta Portaria, conforme especificações descritas abaixo.'],
    ['no resumption: "Os valores"', 'Revoga-se a IN RFB nº 2.121. Os valores aplicáveis aos produtos, conforme especificações descritas abaixo.'],
    ['no resumption: "Ficam aprovados"', 'Revoga-se a IN RFB nº 2.121. Ficam aprovados os modelos de declaração, conforme especificações descritas abaixo.'],
    ['real end after an acronym ("da RFB.")', 'Revoga-se a IN nº 5 da RFB. Fica a empresa autorizada a exportar os produtos, conforme especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

// ---- R11 (review R10 c.6924070158 + COORD): a resumption marker ("ali", "lá", "nela", "sobredita", "daquele", …) in a sentence
// that cites no norm of its own has its antecedent outside the sentence → unresolved (never promoted); the opening set takes
// "Estes/Estas", "demais", "ditos", "sobreditas"; "diploma" is a self-reference kind ("neste/deste diploma"), "naquele/aludido diploma" are foreign
test('R11 resumption without own antecedent: a marker in a sentence with no norm citation never promotes; own content still does', () => {
  const neg: [string, string][] = [
    ['reviewer: IN da SRF. + ali previstas', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:'],
    ['reviewer: art. da IN. + lá previstas', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas lá previstas, conforme tabela a seguir:'],
    ['reviewer: Anexo da IN da RFB. + nela previstas', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas nela previstas, conforme tabela a seguir:'],
    ['reviewer: IN SRF nº 52, de 2000. + ali previstas', 'Aplica-se a Instrução Normativa SRF nº 52, de 2000. Ficam aprovadas as alíquotas ali previstas, conforme tabela a seguir:'],
    ['reviewer: Lei nº 9.532. + nela previstas', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas nela previstas, conforme tabela a seguir:'],
    ['reviewer: da sobredita norma', 'Ficam aprovadas as alíquotas da sobredita norma, conforme tabela a seguir:'],
    ['novel: daquele ato', 'Ficam aprovados os valores constantes daquele ato, conforme tabela a seguir:'],
    ['novel: acima referidas', 'Ficam instituídas as alíquotas acima referidas, conforme tabela a seguir:'],
    ['novel: no ato retrocitado', 'Ficam aprovadas as alíquotas previstas no ato retrocitado, conforme tabela a seguir:'],
    ['novel: Portaria. + nela fixados', 'Fica revogada a Portaria nº 10. Ficam estabelecidos os prazos nela fixados, conforme tabela a seguir:'],
    ['novel: Portaria. + dessa norma', 'Fica revogada a Portaria nº 10. Ficam aprovados os valores dessa norma, conforme tabela a seguir:'],
    ['novel: em referência', 'Ficam aprovados os limites em referência, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['own: "de referência" is not "em referência"', 'Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['own: models', 'Ficam aprovados os modelos de declaração, conforme tabela a seguir:'],
    ['own: foundation Lei + "neste diploma"', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas fixadas neste diploma, conforme tabela a seguir:'],
    ['own: "previstas deste diploma"', 'Ficam aprovadas as alíquotas previstas deste diploma, conforme tabela a seguir:'],
    ['own: "nesta data"', 'Ficam aprovadas nesta data as alíquotas de referência, conforme tabela a seguir:'],
    ['own: model published in the D.O.U.', 'Fica aprovado o modelo publicado no D.O.U. de 2 de janeiro de 2024, conforme tabela a seguir:'],
    ['ADE Cofis real shape', 'Fica o estabelecimento da empresa X, inscrito no CNPJ nº 04.041.933/0013-11, autorizado a exportar cigarros, dispensadas as exigências de que tratam os arts. 3º e 4º da Instrução Normativa RFB nº 1.155, de 2011, de acordo com as especificações descritas abaixo.'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R11 opening resumption: Estes/Estas, demais, ditos/ditas, sobreditas open a sentence without own origin', () => {
  const neg: [string, string][] = [
    ['"Estes valores"', 'Estes valores ficam aprovados, conforme tabela a seguir:'],
    ['"Estas alíquotas"', 'Estas alíquotas ficam aprovadas, conforme tabela a seguir:'],
    ['"Os demais valores"', 'Os demais valores ficam aprovados, conforme tabela a seguir:'],
    ['"As demais alíquotas"', 'As demais alíquotas ficam aprovadas, conforme tabela a seguir:'],
    ['"Ditas alíquotas"', 'Ditas alíquotas ficam aprovadas conforme tabela a seguir:'],
    ['"Ditos valores"', 'Ditos valores ficam aprovados, conforme tabela a seguir:'],
    ['"As ditas alíquotas"', 'As ditas alíquotas ficam aprovadas, conforme tabela a seguir:'],
    ['"Sobreditas alíquotas"', 'Sobreditas alíquotas ficam aprovadas, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['self-reference in the same sentence: "por esta Portaria"', 'Ficam aprovadas por esta Portaria as alíquotas de referência, conforme tabela a seguir:'],
    ['opening "Estes" with its own self-reference', 'Estes modelos, instituídos nesta Portaria, ficam aprovados, conforme tabela a seguir:'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R11 self-reference diploma and foreign diploma: "neste/deste diploma" is the act itself; "naquele/aludido diploma" is another norm', () => {
  const pos: [string, string][] = [
    ['start: fixadas neste diploma', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas fixadas neste diploma, conforme tabela a seguir:'],
    ['middle: fixadas neste diploma', 'Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas fixadas neste diploma, conforme tabela a seguir:'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
  const neg: [string, string][] = [
    ['start: previstas naquele diploma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas previstas naquele diploma, conforme tabela a seguir:'],
    ['middle: previstas no aludido diploma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, as alíquotas previstas no aludido diploma, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
});

// ---- R12 (review R11 c.6930078953 + COORD): one shared marker vocabulary for FOREIGN_ORIGIN and RESUMPTION; sobredito/susodito/em tela/em comento/<ato> anterior ----
test('R12 marker families in the SAME sentence as the citation: a marker after a cited norm means the table is another norm\'s, never promoted', () => {
  const neg: [string, string][] = [
    ['start: da sobredita norma', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da sobredita norma, conforme tabela a seguir:'],
    ['middle: da sobredita norma', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da sobredita norma, conforme tabela a seguir:'],
    ['start: do susodito ato', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['middle: do susodito ato', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['start: da norma em tela', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['middle: da norma em tela', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['start: do ato em comento', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['middle: do ato em comento', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['start: do ato anterior', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['middle: do ato anterior', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['start: da Portaria anterior', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da Portaria anterior, conforme tabela a seguir:'],
    ['middle: da Portaria anterior', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da Portaria anterior, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['middle: own, no marker', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas de referência, conforme tabela a seguir:'],
    ['start: temporal "exercício anterior" is not a marker', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas de referência do exercício anterior, conforme tabela a seguir:'],
    ['middle: "previstas nesta Portaria" is the act itself', 'Ficam aprovadas, nos termos da Lei nº 9.532, de 1997, as alíquotas previstas nesta Portaria, conforme tabela a seguir:'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R12 marker families after a real sentence boundary: no own citation + marker → unresolved, never promoted; own content still promotes', () => {
  const neg: [string, string][] = [
    ['Fica revogada a Instrução No… + da norma em tela', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['Fica revogada a Instrução No… + do ato em comento', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['Fica revogada a Instrução No… + do susodito ato', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['Fica revogada a Instrução No… + do ato anterior', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['Fica revogado o Anexo III da… + da norma em tela', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['Fica revogado o Anexo III da… + do ato em comento', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['Fica revogado o Anexo III da… + do susodito ato', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['Fica revogado o Anexo III da… + do ato anterior', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['Fica revogado o art. 3º da I… + da norma em tela', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['Fica revogado o art. 3º da I… + do ato em comento', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['Fica revogado o art. 3º da I… + do susodito ato', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['Fica revogado o art. 3º da I… + do ato anterior', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['Aplica-se a Lei nº 9.532, de… + da norma em tela', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['Aplica-se a Lei nº 9.532, de… + do ato em comento', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['Aplica-se a Lei nº 9.532, de… + do susodito ato', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['Aplica-se a Lei nº 9.532, de… + do ato anterior', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
    ['Fica revogada a Portaria Con… + da norma em tela', 'Fica revogada a Portaria Conjunta nº 1 da PGFN. Ficam aprovadas as alíquotas da norma em tela, conforme tabela a seguir:'],
    ['Fica revogada a Portaria Con… + do ato em comento', 'Fica revogada a Portaria Conjunta nº 1 da PGFN. Ficam aprovadas as alíquotas do ato em comento, conforme tabela a seguir:'],
    ['Fica revogada a Portaria Con… + do susodito ato', 'Fica revogada a Portaria Conjunta nº 1 da PGFN. Ficam aprovadas as alíquotas do susodito ato, conforme tabela a seguir:'],
    ['Fica revogada a Portaria Con… + do ato anterior', 'Fica revogada a Portaria Conjunta nº 1 da PGFN. Ficam aprovadas as alíquotas do ato anterior, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['Fica revogada a Instrução No… + de referência', 'Fica revogada a Instrução Normativa nº 52 da SRF. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['Fica revogado o Anexo III da… + de referência', 'Fica revogado o Anexo III da Instrução Normativa nº 2.121 da RFB. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['Fica revogado o art. 3º da I… + de referência', 'Fica revogado o art. 3º da IN. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['Aplica-se a Lei nº 9.532, de… + de referência', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['Fica revogada a Portaria Con… + de referência', 'Fica revogada a Portaria Conjunta nº 1 da PGFN. Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});

test('R12 opening susodito: "Susoditas/As susoditas" open a sentence without own origin', () => {
  const neg: [string, string][] = [
    ['"Susoditas alíquotas"', 'Susoditas alíquotas ficam aprovadas conforme tabela a seguir:'],
    ['"As susoditas alíquotas"', 'As susoditas alíquotas ficam aprovadas conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
});

// ---- R13 (review R12 c.6933422896 + COORD): synonyms of the resumption vocabulary (multicitado, em epígrafe, em questão, em causa) ----
test('R13 synonyms of the resumption vocabulary', () => {
  const neg: [string, string][] = [
    ['do multicitado ato — citation middle', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do multicitado ato, conforme tabela a seguir:'],
    ['do multicitado ato — citation start', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
    ['do multicitado ato — no citation, after sentence end', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
    ['do multicitado ato — no citation at all', 'Ficam aprovadas as alíquotas do multicitado ato, conforme tabela a seguir:'],
    ['da norma em epígrafe — citation middle', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
    ['da norma em epígrafe — citation start', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
    ['da norma em epígrafe — no citation, after sentence end', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
    ['da norma em epígrafe — no citation at all', 'Ficam aprovadas as alíquotas da norma em epígrafe, conforme tabela a seguir:'],
    ['do ato em questão — citation middle', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas do ato em questão, conforme tabela a seguir:'],
    ['do ato em questão — citation start', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
    ['do ato em questão — no citation, after sentence end', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
    ['do ato em questão — no citation at all', 'Ficam aprovadas as alíquotas do ato em questão, conforme tabela a seguir:'],
    ['da norma em causa — citation middle', 'Ficam aprovadas, nos termos da Instrução Normativa RFB nº 2.121, de 2022, as alíquotas da norma em causa, conforme tabela a seguir:'],
    ['da norma em causa — citation start', 'Nos termos da Instrução Normativa RFB nº 2.121, de 2022, ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
    ['da norma em causa — no citation, after sentence end', 'Aplica-se a Lei nº 9.532, de 1997. Ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
    ['da norma em causa — no citation at all', 'Ficam aprovadas as alíquotas da norma em causa, conforme tabela a seguir:'],
  ];
  for (const [why, art] of neg) assert.equal(promotes(`Art. 1º ${art}`), false, why);
  const pos: [string, string][] = [
    ['plain', 'Ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['Lei citation', 'Nos termos da Lei nº 9.532, de 1997, ficam aprovadas as alíquotas de referência, conforme tabela a seguir:'],
    ['bare epígrafe', 'Ficam aprovadas as alíquotas de referência indicadas na epígrafe desta Portaria, conforme tabela a seguir:'],
    ['bare questão', 'Ficam aprovadas as alíquotas de referência para a questão tarifária, conforme tabela a seguir:'],
    ['bare causa', 'Ficam aprovadas as alíquotas de referência, por causa da demanda sazonal, conforme tabela a seguir:'],
  ];
  for (const [why, art] of pos) assert.equal(promotes(`Art. 1º ${art}`), true, why);
});
