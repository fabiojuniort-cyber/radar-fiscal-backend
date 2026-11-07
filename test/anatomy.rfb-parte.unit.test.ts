import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { validateAnatomyResult } from '../src/modules/anatomy/contract.js';

// ANAT-L11 (decisão do Fábio, tribusca-control#116 c.6647638485): the RFB type `parte`, when declared by the document's
// own tiposSegmento, is a structural grouping above livro/título/capítulo. Synthetic payloads + the official IN 2.121.
const TYPES = [{ idTipoSegmento: 1, siglaTipoSegmento: 'ementa' }, { idTipoSegmento: 3, siglaTipoSegmento: 'artigo' },
  { idTipoSegmento: 9, siglaTipoSegmento: 'secao' }, { idTipoSegmento: 10, siglaTipoSegmento: 'capitulo' }, { idTipoSegmento: 13, siglaTipoSegmento: 'parte' },
  { idTipoSegmento: 15, siglaTipoSegmento: 'inciso' }, { idTipoSegmento: 999, siglaTipoSegmento: 'nao identificado' }];
const seg = (order: number, tipo: number | undefined, text: string, extra: Record<string, unknown> = {}) => ({ ordemSegmentoAto: order, ...(tipo === undefined ? {} : { idTipoSegmento: tipo }), textoIntegra: text, ...extra });
const doc = (segs: Record<string, unknown>[], types = TYPES) => ({ idAto: 900002, tiposSegmento: types, ementas: [seg(1, 1, '<p>Dispõe sobre exemplo.</p>')], outrosSegmentos: segs });
const read = (d: unknown, source: 'RFB' | 'DOU' = 'RFB') => {
  const p = prepareRfbRepresentation({ resourceId: 'x', bytes: new TextEncoder().encode(JSON.stringify(d)) }, 900002);
  return { p, r: readAnatomyInput({ source, representationId: 'x', html: p.html }) };
};
const at = (r: ReturnType<typeof read>['r'], prefix: string) => r.parts.find((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start).trimStart().startsWith(prefix))!;
const BODY = [seg(2, 13, 'PARTE I \n\n DA PARTE EXEMPLO'), seg(3, 10, 'CAPÍTULO I \n\n DISPOSIÇÕES'), seg(4, 9, 'Seção I \n Do Exemplo'),
  seg(5, 3, '<p>Art. 1º Texto exemplo:</p>'), seg(6, 15, 'I primeiro;'), seg(7, 13, 'PARTE II \n\n OUTRA PARTE'), seg(8, 3, '<p>Art. 2º Outro texto.</p>')];

test('L11: declared parte is a group (part) — Parte → Capítulo → Seção → Artigo → Inciso; text and traceability kept', () => {
  const { p, r } = read(doc(BODY));
  const p1 = at(r, 'PARTE I '); const cap = at(r, 'CAPÍTULO I'); const sec = at(r, 'Seção I'); const art = at(r, 'Art. 1º'); const inc = at(r, 'I primeiro');
  assert.equal(p1.type, 'group'); assert.deepEqual(p1.contextReasons, ['rfb_declared_group_part']);
  assert.equal(r.parts.find((x) => x.id === p1.parentId)!.type, 'document');
  assert.equal(cap.parentId, p1.id); assert.equal(sec.parentId, cap.id); assert.equal(art.parentId, sec.id); assert.equal(inc.parentId, art.id);
  const p2 = at(r, 'PARTE II'); assert.equal(p2.parentId, p1.parentId, 'a new parte closes the previous one'); assert.equal(at(r, 'Art. 2º').parentId, p2.id);
  assert.ok(r.canonicalText.includes('PARTE I \n\n DA PARTE EXEMPLO'), 'original identification preserved verbatim');
  const ptr = p1.sourcePointers[0]!.sourceSpan!;
  assert.deepEqual(p.pieces.filter((x) => x.htmlSpan.start >= ptr.start && x.htmlSpan.end <= ptr.end).map((x) => x.pointer), ['/outrosSegmentos/0/textoIntegra']);
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
  assert.ok(!r.limitations.some((l) => l.code === 'rfb_segment_type_unmapped'));
});

test('L11 negative: free text "PARTE I" without a declared type is not inferred; the source "não identificado" (999) stays unidentified', () => {
  const { r } = read(doc([seg(2, undefined, 'PARTE I \n\n SEM TIPO'), seg(3, 999, 'PARTE II \n\n TIPO 999'), seg(4, 3, '<p>Art. 1º Texto.</p>')]));
  assert.equal(at(r, 'PARTE I ').type, 'unidentified'); assert.equal(at(r, 'PARTE II').type, 'unidentified');
  assert.ok(r.limitations.some((l) => l.code === 'rfb_segment_type_missing'));
  assert.ok(r.limitations.some((l) => l.code === 'rfb_segment_type_unidentified_by_source'));
});

test('L11 negative: parte absent from / conflicting in the document table is never guessed', () => {
  const noParte = TYPES.filter((t) => t.siglaTipoSegmento !== 'parte');
  const a = read(doc([seg(2, 13, 'PARTE I \n\n X'), seg(3, 3, '<p>Art. 1º T.</p>')], noParte)).r;
  assert.equal(at(a, 'PARTE I').type, 'unidentified'); assert.ok(a.limitations.some((l) => l.code === 'rfb_segment_type_unknown_in_document_table'));
  const b = read(doc([seg(2, 13, 'PARTE I \n\n X'), seg(3, 3, '<p>Art. 1º T.</p>')], [...TYPES, { idTipoSegmento: 13, siglaTipoSegmento: 'livro' }])).r;
  assert.equal(at(b, 'PARTE I').type, 'unidentified'); assert.ok(b.limitations.some((l) => l.code === 'rfb_segment_type_table_conflict'));
});

test('L11 negative: declared parte contradicting the text grammar keeps the grammar result and records the conflict', () => {
  const { r } = read(doc([seg(2, 13, '<p>Art. 1º Texto que a fonte chama de parte.</p>')]));
  assert.equal(at(r, 'Art. 1º').type, 'article'); assert.ok(r.limitations.some((l) => l.code === 'rfb_segment_type_conflict'));
});

test('L11 negative: tachado parte is historical with source evidence; legalStatus unknown; other sources ignore data-rfb-*', () => {
  const { r } = read(doc([seg(2, 13, 'PARTE I \n\n ANTIGA', { tachado: true }), seg(3, 3, '<p>Art. 1º T.</p>', { tachado: true })]));
  const p1 = at(r, 'PARTE I'); assert.equal(p1.type, 'group'); assert.equal(p1.context, 'historical'); assert.ok(p1.contextReasons.includes('rfb_tachado_source'));
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
  const dou = read(doc(BODY), 'DOU').r; assert.equal(at(dou, 'PARTE I ').type, 'unidentified', 'DOU/SP: no declared types, no parte');
});

test('L11 engine: result with parte groups validates in the contract; quoted parte keeps prohibited precedence', () => {
  const html = prepareRfbRepresentation({ resourceId: 'x', bytes: new TextEncoder().encode(JSON.stringify(doc(BODY))) }, 900002).html;
  const r = analyzeAnatomy({ publicationVersionId: 'x', referenceDate: '2026-11-05', ruleSet: { id: 't', version: '1' }, input: { source: 'RFB', representationId: 'x', html }, catalog: { edition: 'none', codes: [] } });
  assert.doesNotThrow(() => validateAnatomyResult(r));
  const q = read(doc([seg(2, 3, '<p>Art. 1º O art. 9 passa a vigorar:</p><p>“PARTE I</p>'), seg(3, 13, 'PARTE II \n\n CITADA”')])).r;
  const quoted = at(q, 'PARTE II'); assert.notEqual(quoted.context, 'operative_candidate');
});

test('L11 official IN RFB 2.121/2022 (127905, promoted:false): 5 partes become groups, PARTE VI stays inside the open quotation, 999 untouched', () => {
  const dir = new URL('../ops/anatomy/official-identification/rfb-normasinternet2/', import.meta.url);
  const meta = JSON.parse(readFileSync(new URL('127905.meta.json', dir), 'utf8')); assert.equal(meta.promoted, false);
  const p = prepareRfbRepresentation({ resourceId: 'r', bytes: new Uint8Array(readFileSync(new URL('127905.json', dir))) }, 127905);
  const r = readAnatomyInput({ source: 'RFB', representationId: 'r', html: p.html });
  const partes = r.parts.filter((x) => /^PARTE [IVX]+ /u.test(r.canonicalText.slice(x.span.start, x.span.end)));
  assert.equal(partes.length, 6);
  assert.deepEqual(partes.map((x) => x.type), ['group', 'group', 'group', 'group', 'group', 'quoted_text']);
  for (const g of partes.slice(0, 5)) { assert.deepEqual(g.contextReasons, ['rfb_declared_group_part']); assert.equal(r.parts.find((x) => x.id === g.parentId)!.type, 'document'); }
  const livro = r.parts.find((x) => x.parentId === partes[0]!.id && x.type === 'group')!; assert.match(r.canonicalText.slice(livro.span.start), /^LIVRO I /u);
  assert.equal(partes[5]!.context, 'prohibited');
  assert.ok(!r.limitations.some((l) => l.code === 'rfb_segment_type_unmapped'));
  assert.equal(r.limitations.filter((l) => l.code === 'rfb_segment_type_unidentified_by_source').length, 1);
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
});
