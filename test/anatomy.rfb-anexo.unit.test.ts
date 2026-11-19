import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';

// ANAT-L22 (decisão do Fábio, tribusca-control#116 c.6671833324): RFB type `anexo` declared by the document's own
// tiposSegmento → annex, ONLY when the text grammar left the block unidentified. Synthetic payloads.
const TYPES = [{ idTipoSegmento: 1, siglaTipoSegmento: 'ementa' }, { idTipoSegmento: 3, siglaTipoSegmento: 'artigo' },
  { idTipoSegmento: 16, siglaTipoSegmento: 'anexo' }, { idTipoSegmento: 999, siglaTipoSegmento: 'nao identificado' }];
const seg = (order: number, tipo: number | undefined, text: string, extra: Record<string, unknown> = {}) => ({ ordemSegmentoAto: order, ...(tipo === undefined ? {} : { idTipoSegmento: tipo }), textoIntegra: text, ...extra });
const doc = (segs: Record<string, unknown>[], types = TYPES) => ({ idAto: 900003, tiposSegmento: types, ementas: [seg(1, 1, '<p>Dispõe sobre exemplo.</p>')], outrosSegmentos: segs });
const read = (d: unknown, source: 'RFB' | 'DOU' = 'RFB') => readAnatomyInput({ source, representationId: 'x',
  html: prepareRfbRepresentation({ resourceId: 'x', bytes: new TextEncoder().encode(JSON.stringify(d)) }, 900003).html });
const at = (r: ReturnType<typeof read>, needle: string) => r.parts.filter((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start, x.span.end).includes(needle))
  .sort((a, b) => (a.span.end - a.span.start) - (b.span.end - b.span.start))[0]!;
const ART = seg(2, 3, '<p>Art. 1º Texto exemplo.</p>');

test('L22: declared anexo fills a block the grammar left unidentified (e.g. file name before the heading)', () => {
  const r = read(doc([ART, seg(3, 16, 'Anexo I.pdf\nANEXO I – MODELO EXEMPLO')]));
  const a = at(r, 'MODELO EXEMPLO'); assert.equal(a.type, 'annex'); assert.deepEqual(a.contextReasons, ['rfb_declared_anexo']);
  assert.ok(!r.limitations.some((l) => l.code === 'rfb_segment_type_unmapped'));
  assert.ok(r.canonicalText.includes('Anexo I.pdf\nANEXO I – MODELO EXEMPLO'), 'text verbatim');
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
});

test('L22: grammar precedence — a heading the grammar recognises keeps the grammar reason; a contradicting declaration is a conflict', () => {
  const g = read(doc([ART, seg(3, 16, 'ANEXO II')]));
  const h = at(g, 'ANEXO II'); assert.equal(h.type, 'annex'); assert.ok(!h.contextReasons.includes('rfb_declared_anexo'), 'grammar result kept');
  const c = read(doc([seg(2, 16, '<p>Art. 1º Texto declarado como anexo.</p>')]));
  assert.equal(at(c, 'Art. 1º').type, 'article'); assert.ok(c.limitations.some((l) => l.code === 'rfb_segment_type_conflict'));
});

test('L22 negative: absent, unknown or conflicting type, type 999 and other sources never become annex', () => {
  const missing = read(doc([ART, seg(3, undefined, 'Anexo I.pdf\nX')]));
  assert.equal(at(missing, 'Anexo I.pdf').type, 'unidentified'); assert.ok(missing.limitations.some((l) => l.code === 'rfb_segment_type_missing'));
  const unknown = read(doc([ART, seg(3, 16, 'Anexo I.pdf\nX')], TYPES.filter((t) => t.siglaTipoSegmento !== 'anexo')));
  assert.equal(at(unknown, 'Anexo I.pdf').type, 'unidentified'); assert.ok(unknown.limitations.some((l) => l.code === 'rfb_segment_type_unknown_in_document_table'));
  const conflict = read(doc([ART, seg(3, 16, 'Anexo I.pdf\nX')], [...TYPES, { idTipoSegmento: 16, siglaTipoSegmento: 'artigo' }]));
  assert.equal(at(conflict, 'Anexo I.pdf').type, 'unidentified'); assert.ok(conflict.limitations.some((l) => l.code === 'rfb_segment_type_table_conflict'));
  const s999 = read(doc([ART, seg(3, 999, 'Anexo I.pdf\nX')]));
  assert.equal(at(s999, 'Anexo I.pdf').type, 'unidentified');
  const dou = read(doc([ART, seg(3, 16, 'Anexo I.pdf\nX')]), 'DOU');
  assert.equal(at(dou, 'Anexo I.pdf').type, 'unidentified', 'data-rfb-* ignored outside RFB');
});

test('L22: tachado declared anexo is historical with source evidence; quotation keeps precedence', () => {
  const t = read(doc([ART, seg(3, 16, 'Anexo I.pdf\nANEXO ANTIGO', { tachado: true })]));
  const a = at(t, 'ANEXO ANTIGO'); assert.equal(a.type, 'annex'); assert.equal(a.context, 'historical'); assert.ok(a.contextReasons.includes('rfb_tachado_source'));
  const q = read(doc([seg(2, 3, '<p>Art. 1º O anexo passa a vigorar:</p><p>“Texto citado</p>'), seg(3, 16, 'Anexo I.pdf\nCITADO”')]));
  assert.equal(at(q, 'CITADO').type, 'quoted_text');
});
