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
