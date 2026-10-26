import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DOE_SP_PREPARATION_VERSION, JsonPreparationError, locateJsonHtmlSpan, prepareDoeSpRepresentation, prepareRfbRepresentation,
  RFB_PREPARATION_VERSION } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';

// SYNTHETIC FIXTURES ONLY. Shapes follow the existing DOE-SP/RFB connectors; no original capture, official request
// or reserved entry is used. Every resourceId starts with synthetic:// to make that explicit.
const sha = (v: string | Uint8Array): string => createHash('sha256').update(v).digest('hex');
const bytes = (s: string, bom = false): Uint8Array => new Uint8Array(Buffer.from((bom ? '﻿' : '') + s, 'utf8'));
const GUID = '9716c5c2-7f22-46eb-a80d-000000000001';
const doe = (over: Record<string, unknown> = {}) => JSON.stringify({ id: GUID, title: 'RESOLUÇÃO SINTÉTICA 1', slug: 'resolucao-sintetica-1', date: '2026-09-03',
  journal: 'Executivo', content: '<p>RESOLUÇÃO SINTÉTICA 1</p><p>Artigo 1º - Texto sintético.</p>', ...over });
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof JsonPreparationError, String(e)); return e.code; } return 'no-error'; };

test('DOE-SP: content copied verbatim with provenance, BOM recorded, title excluded by hash only', () => {
  const content = '<p>Ação — “aspas” é 😀 &amp; código 8471.30.12</p>';
  const raw = doe({ content, attachments: [{ id: '9716c5c2-7f22-46eb-a80d-000000000003', name: 'b.pdf', position: 2 }, { id: '9716C5C2-7F22-46EB-A80D-000000000002', name: 'a.pdf', position: 1 }] });
  const p = prepareDoeSpRepresentation({ resourceId: 'synthetic://doe/1.json', bytes: bytes(raw, true) }, GUID.toUpperCase());
  assert.equal(p.preparationVersion, DOE_SP_PREPARATION_VERSION); assert.equal(p.provisional, true);
  assert.equal(p.html, content); assert.equal(p.resource.bomPresent, true); assert.equal(p.resource.sha256, sha(bytes(raw, true)));
  assert.deepEqual(p.pieces, [{ pointer: '/content', sha256: sha(content), htmlSpan: { start: 0, end: content.length } }]);
  assert.deepEqual(p.attachments.map((a) => [a.id, a.position, a.status]), [['9716c5c2-7f22-46eb-a80d-000000000002', 1, 'missing'], ['9716c5c2-7f22-46eb-a80d-000000000003', 2, 'missing']]);
  assert.deepEqual(p.excluded, [{ pointer: '/title', sha256: sha('RESOLUÇÃO SINTÉTICA 1'), length: 'RESOLUÇÃO SINTÉTICA 1'.length, reason: 'metadata' }]);
  assert.ok(!JSON.stringify(p.excluded).includes('RESOLUÇÃO'));
  const at = content.indexOf('😀');
  assert.deepEqual(locateJsonHtmlSpan(p, { start: at, end: at + 2 }), { pointer: '/content', offset: { start: at, end: at + 2 } });
  // The reader consumes the prepared HTML; supplementary characters and combining marks survive unchanged.
  const r = readAnatomyInput({ source: 'DOE-SP', representationId: p.preparationId, html: p.html });
  assert.ok(r.canonicalText.includes('é 😀 & código'));
});

test('DOE-SP: JSON escapes decode to the same text as literal characters', () => {
  const literal = doe({ title: 'T', slug: 's', content: '<p>Ação 😀</p>' });
  // Escape every non-ASCII UTF-16 unit as a JSON \uXXXX sequence (built in code, not typed in the source).
  const BACKSLASH = String.fromCharCode(92);
  const escaped = literal.replace(/[^\x00-\x7f]/gu, (c) => Array.from({ length: c.length }, (_, i) => BACKSLASH + 'u' + c.charCodeAt(i).toString(16).padStart(4, '0')).join(''));
  assert.ok(escaped.includes(BACKSLASH + 'u00e7') && !/[^\x00-\x7f]/u.test(escaped), 'fixture really uses JSON escapes');
  const a = prepareDoeSpRepresentation({ resourceId: 'synthetic://doe/esc.json', bytes: bytes(escaped) }, GUID);
  const b = prepareDoeSpRepresentation({ resourceId: 'synthetic://doe/lit.json', bytes: bytes(literal) }, GUID);
  assert.equal(a.html, b.html); assert.equal(a.htmlSha256, b.htmlSha256);
  assert.notEqual(a.resource.sha256, b.resource.sha256, 'resource identity still distinguishes the received bytes');
});

test('DOE-SP: missing fields and invalid responses fail closed', () => {
  const run = (raw: string | Uint8Array, id = GUID) => code(() => prepareDoeSpRepresentation({ resourceId: 'synthetic://doe/x.json', bytes: typeof raw === 'string' ? bytes(raw) : raw }, id));
  assert.equal(run('{not json'), 'invalid_json');
  assert.equal(run(new Uint8Array([0x7b, 0xff, 0x7d])), 'invalid_utf8');
  assert.equal(run('[]'), 'invalid_root');
  assert.equal(run(doe({ id: 'abc' })), 'invalid_id');
  assert.equal(run(doe(), '9716c5c2-7f22-46eb-a80d-00000000ffff'), 'id_mismatch');
  for (const f of ['title', 'slug', 'journal']) assert.equal(run(doe({ [f]: '' })), 'missing_fields', f);
  assert.equal(run(doe({ date: '03/09/2026' })), 'missing_fields');
  assert.equal(run(doe({ content: null })), 'missing_content');
  assert.equal(run(doe({ content: '   ' })), 'empty_content');
  assert.equal(run(doe({ attachments: {} })), 'invalid_attachments');
  assert.equal(run(doe({ attachments: [{ id: 'x', name: 'a.pdf' }] })), 'invalid_attachment');
});

const rfb = (over: Record<string, unknown> = {}) => JSON.stringify({ idAto: 990001, epigrafeCompleta: 'Solução de Consulta Sintética nº 1',
  ementas: [{ ordemSegmentoAto: 2, textoIntegra: '<p>Ementa sintética.</p>' }],
  outrosSegmentos: [{ ordemSegmentoAto: 3, textoIntegra: '<p>Art. 1º Texto sintético.</p>' }, { ordemSegmentoAto: 1, textoIntegra: '<p>SOLUÇÃO SINTÉTICA</p>' }], ...over });

test('RFB: segments in ascending order with per-segment provenance; omitted and attachment-only segments declared', () => {
  const raw = rfb({ outrosSegmentos: [
    { ordemSegmentoAto: 3, textoIntegra: '<p>Art. 1º Texto sintético 😀.</p>' },
    { ordemSegmentoAto: 1, textoIntegra: '<p>SOLUÇÃO SINTÉTICA</p>' },
    { ordemSegmentoAto: 4, omitir: true, textoIntegra: '<p>não deve aparecer</p>' },
    { ordemSegmentoAto: 5, arquivoBinario: { idArquivoBinario: 77, nomeArquivoBinario: 'tabela.pdf' } },
    { ordemSegmentoAto: 6, textoIntegra: '' },
  ] });
  const p = prepareRfbRepresentation({ resourceId: 'synthetic://rfb/990001.json', bytes: bytes(raw) }, 990001);
  assert.equal(p.preparationVersion, RFB_PREPARATION_VERSION); assert.equal(p.provisional, true);
  assert.deepEqual(p.pieces.map((x) => x.pointer), ['/outrosSegmentos/1/textoIntegra', '/ementas/0/textoIntegra', '/outrosSegmentos/0/textoIntegra']);
  for (const piece of p.pieces) assert.equal(sha(p.html.slice(piece.htmlSpan.start, piece.htmlSpan.end)), piece.sha256);
  assert.ok(!p.html.includes('não deve aparecer'));
  assert.deepEqual(p.missingSegments, [{ pointer: '/outrosSegmentos/2', order: 4, reason: 'omitted_by_source' }, { pointer: '/outrosSegmentos/4', order: 6, reason: 'no_text' }]);
  assert.deepEqual(p.attachments, [{ id: '77', name: 'tabela.pdf', position: 5, status: 'missing' }]);
  assert.equal(p.excluded[0]!.pointer, '/epigrafeCompleta');
  const r = readAnatomyInput({ source: 'RFB', representationId: p.preparationId, html: p.html });
  const text = r.canonicalText;
  assert.ok(text.indexOf('SOLUÇÃO SINTÉTICA') < text.indexOf('Ementa sintética.') && text.indexOf('Ementa sintética.') < text.indexOf('Art. 1º'));
  // Order is a property of ordemSegmentoAto, not of array position.
  const shuffled = rfb({ ementas: [{ ordemSegmentoAto: 2, textoIntegra: '<p>Ementa sintética.</p>' }],
    outrosSegmentos: [{ ordemSegmentoAto: 1, textoIntegra: '<p>SOLUÇÃO SINTÉTICA</p>' }, { ordemSegmentoAto: 3, textoIntegra: '<p>Art. 1º Texto sintético.</p>' }] });
  assert.equal(prepareRfbRepresentation({ resourceId: 'synthetic://rfb/a.json', bytes: bytes(rfb()) }, 990001).html,
    prepareRfbRepresentation({ resourceId: 'synthetic://rfb/b.json', bytes: bytes(shuffled) }, 990001).html);
});

test('RFB: missing fields and invalid responses fail closed', () => {
  const run = (raw: string, id = 990001) => code(() => prepareRfbRepresentation({ resourceId: 'synthetic://rfb/x.json', bytes: bytes(raw) }, id));
  assert.equal(run(rfb({ idAto: '990001' })), 'invalid_id');
  assert.equal(run(rfb(), 990002), 'id_mismatch');
  assert.equal(run(JSON.stringify({ idAto: 990001 })), 'no_segments');
  assert.equal(run(rfb({ ementas: {} })), 'invalid_segments');
  assert.equal(run(rfb({ ementas: [1] })), 'invalid_segment');
  assert.equal(run(rfb({ ementas: [{ textoIntegra: '<p>x</p>' }] })), 'segment_order_missing');
  assert.equal(run(rfb({ ementas: [{ ordemSegmentoAto: 3, textoIntegra: '<p>dup</p>' }] })), 'segment_order_duplicate');
  assert.equal(run(rfb({ ementas: [{ ordemSegmentoAto: 2, textoIntegra: 5 }] })), 'invalid_segment_text');
  assert.equal(run(rfb({ ementas: [{ ordemSegmentoAto: 2, arquivoBinario: { idArquivoBinario: 'x' } }] })), 'invalid_attachment');
  assert.equal(run(JSON.stringify({ idAto: 990001, ementas: [{ ordemSegmentoAto: 1, omitir: true, textoIntegra: '<p>x</p>' }] })), 'no_readable_segment');
});
