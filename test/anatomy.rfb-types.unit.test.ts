import assert from 'node:assert/strict';
import test from 'node:test';
import { locateJsonHtmlSpan, prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';

// ANAT-D04 — RFB segment types declared by the document's own tiposSegmento. Synthetic payloads only.
const TYPES = [{ idTipoSegmento: 1, siglaTipoSegmento: 'ementa' }, { idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }, { idTipoSegmento: 4, siglaTipoSegmento: 'fecho' },
  { idTipoSegmento: 5, siglaTipoSegmento: 'paragrafo' }, { idTipoSegmento: 9, siglaTipoSegmento: 'secao' }, { idTipoSegmento: 10, siglaTipoSegmento: 'capitulo' },
  { idTipoSegmento: 14, siglaTipoSegmento: 'alinea' }, { idTipoSegmento: 15, siglaTipoSegmento: 'inciso' }, { idTipoSegmento: 999, siglaTipoSegmento: 'nao identificado' }];
const seg = (order: number, tipo: number | undefined, text: string, extra: Record<string, unknown> = {}) => ({ ordemSegmentoAto: order, ...(tipo === undefined ? {} : { idTipoSegmento: tipo }), textoIntegra: text, ...extra });
const doc = (segs: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ idAto: 900001, tiposSegmento: TYPES,
  ementas: [seg(1, 1, '<p>Dispõe sobre o exemplo sintético.</p>')], outrosSegmentos: segs, ...over });
const read = (d: unknown, source: 'RFB' | 'DOU' = 'RFB') => {
  const p = prepareRfbRepresentation({ resourceId: 'x', bytes: new TextEncoder().encode(JSON.stringify(d)) }, 900001);
  return { p, r: readAnatomyInput({ source, representationId: 'x', html: p.html }) };
};
const at = (r: ReturnType<typeof read>['r'], prefix: string) => r.parts.find((x) => !['document', 'caput'].includes(x.type) && r.canonicalText.slice(x.span.start).trimStart().startsWith(prefix))!;
const BODY = [
  seg(2, 10, 'CAPÍTULO I \n\n\n DISPOSIÇÕES EXEMPLO'), seg(3, 9, 'Seção I \n Do Exemplo'),
  seg(4, 3, '<p>Art. 1º São obrigadas:</p>'), seg(5, 15, 'I que fizerem a ação exemplo; e'), seg(6, 15, 'II que fizerem outra ação.'),
  seg(7, 5, '<p>Parágrafo único. Texto exemplo.</p>'), seg(8, 999, 'III texto que a fonte não classificou.'),
  seg(9, 3, '<p>Art. 2º Redação superada exemplo.</p>', { tachado: true }), seg(10, 4, 'FULANO EXEMPLO'),
];

test('D04: declared types fill gaps the text grammar left — group (capítulo/seção), inciso without dash, ementa and fecho; text unchanged', () => {
  const { p, r } = read(doc(BODY));
  const cap = at(r, 'CAPÍTULO I'); const sec = at(r, 'Seção I'); const art1 = at(r, 'Art. 1º');
  assert.equal(cap.type, 'group'); assert.equal(cap.contextReasons[0], 'rfb_declared_group_chapter');
  assert.equal(sec.type, 'group'); assert.equal(sec.parentId, cap.id, 'seção nests under capítulo');
  assert.equal(art1.parentId, sec.id, 'article nests under seção');
  const inc = at(r, 'I que'); assert.equal(inc.type, 'inciso'); assert.equal(inc.contextReasons[0], 'rfb_declared_inciso'); assert.equal(inc.parentId, art1.id);
  assert.equal(at(r, 'II que').type, 'inciso');
  assert.equal(at(r, 'Dispõe').type, 'summary'); assert.equal(at(r, 'Dispõe').context, 'prohibited');
  assert.equal(at(r, 'FULANO').type, 'signature');
  assert.ok(!r.canonicalText.includes(' – ') && r.canonicalText.includes('I que fizerem'), 'no separator inserted, text unchanged');
  // traceability JSON → preparation → part
  // the block's source span is its <section> wrapper; the JSON piece it carries is the one contained in it
  const ptr = inc.sourcePointers[0]!.sourceSpan!;
  const inside = p.pieces.filter((x) => x.htmlSpan.start >= ptr.start && x.htmlSpan.end <= ptr.end);
  assert.deepEqual(inside.map((x) => x.pointer), ['/outrosSegmentos/3/textoIntegra']);
  assert.equal(locateJsonHtmlSpan(p, inside[0]!.htmlSpan)!.pointer, '/outrosSegmentos/3/textoIntegra');
  assert.ok(r.parts.every((x) => x.legalStatus === 'unknown'));
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
});

test('D04: the source\'s own "não identificado" type is a limitation, never guessed (even if it looks like an inciso)', () => {
  const { r } = read(doc(BODY));
  const iii = at(r, 'III texto'); assert.equal(iii.type, 'unidentified');
  assert.ok(r.limitations.some((l) => l.code === 'rfb_segment_type_unidentified_by_source' && l.span!.start <= iii.span.start));
});

test('D04: tachado → context historical with rfb_tachado_source; legalStatus stays unknown; children inherit', () => {
  const { r } = read(doc([...BODY.slice(0, 7), seg(9, 3, '<p>Art. 2º Redação superada exemplo.</p>', { tachado: true }), seg(10, 15, 'I inciso superado.', { tachado: true }), seg(11, 4, 'FULANO EXEMPLO')]));
  const art2 = at(r, 'Art. 2º');
  assert.equal(art2.context, 'historical'); assert.ok(art2.contextReasons.includes('rfb_tachado_source')); assert.equal(art2.legalStatus, 'unknown');
  const inc = at(r, 'I inciso superado'); assert.equal(inc.context, 'historical'); assert.ok(inc.contextReasons.includes('rfb_tachado_source'));
  assert.equal(at(r, 'Art. 1º').context, 'operative_candidate', 'non-struck untouched');
});

test('D04: missing, unknown and conflicting types become explicit limitations; grammar conflicts keep the grammar result', () => {
  const missing = read(doc([seg(2, undefined, 'I sem tipo declarado.')]));
  assert.equal(at(missing.r, 'I sem tipo').type, 'unidentified');
  assert.ok(missing.r.limitations.some((l) => l.code === 'rfb_segment_type_missing'));
  const unknown = read(doc([seg(2, 77, 'I tipo fora da tabela.')]));
  assert.ok(unknown.r.limitations.some((l) => l.code === 'rfb_segment_type_unknown_in_document_table'));
  const clash = read(doc([seg(2, 15, 'I tabela contraditória.')], { tiposSegmento: [...TYPES, { idTipoSegmento: 15, siglaTipoSegmento: 'alinea' }] }));
  assert.ok(clash.r.limitations.some((l) => l.code === 'rfb_segment_type_table_conflict'));
  assert.equal(at(clash.r, 'I tabela').type, 'unidentified');
  const unmapped = read(doc([seg(2, 50, 'Texto de tipo sem mapa.')], { tiposSegmento: [...TYPES, { idTipoSegmento: 50, siglaTipoSegmento: 'tipo inventado' }] }));
  assert.ok(unmapped.r.limitations.some((l) => l.code === 'rfb_segment_type_unmapped'));
  const conflict = read(doc([seg(2, 5, '<p>Art. 9º Gramática diz artigo.</p>')]));
  assert.equal(at(conflict.r, 'Art. 9º').type, 'article', 'grammar kept');
  assert.ok(conflict.r.limitations.some((l) => l.code === 'rfb_segment_type_conflict'));
  // numbers are per-document: the same id means whatever THIS table says
  const renumbered = read(doc([seg(2, 42, 'I numeração própria.')], { tiposSegmento: [{ idTipoSegmento: 42, siglaTipoSegmento: 'inciso' }] }));
  assert.equal(at(renumbered.r, 'I numeração').type, 'inciso');
});

test('D04: data-rfb-* attributes are honoured only for source RFB (other sources unaffected)', () => {
  const html = '<html><body><section data-rfb-segment="1" data-rfb-type="inciso" data-rfb-tachado="true">I texto exemplo.</section></body></html>';
  const dou = readAnatomyInput({ source: 'DOU', representationId: 'x', html });
  assert.equal(dou.parts.find((x) => x.type !== 'document')!.type, 'unidentified');
  assert.ok(!dou.parts.some((x) => x.contextReasons.includes('rfb_tachado_source')));
  assert.ok(!dou.limitations.some((l) => l.code.startsWith('rfb_')));
});

test('D04-R1-01: a table inside a tachado segment is historical (table, rows, cells), equivalent non-struck table stays operative, DOU control unaffected', () => {
  const tbl = '<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>8471.30.12</td><td>Equipamento exemplo</td></tr></table>';
  const { r } = read(doc([seg(2, 3, '<p>Art. 1º Tabela vigente:</p>'), seg(3, 3, tbl), seg(4, 3, '<p>Art. 2º Artigo vigente, tabela superada:</p>'), seg(5, 3, tbl, { tachado: true })]));
  const tables = r.parts.filter((x) => x.type === 'table');
  assert.equal(tables.length, 2);
  const kids = (t: { id: string }) => { const ids = new Set([t.id]); let grew = true; while (grew) { grew = false; for (const x of r.parts) if (x.parentId && ids.has(x.parentId) && !ids.has(x.id)) { ids.add(x.id); grew = true; } } return r.parts.filter((x) => ids.has(x.id)); };
  const [live, struck] = tables;
  assert.ok(kids(live!).every((x) => x.context === 'operative_candidate'), 'non-struck table operative');
  for (const x of kids(struck!)) { assert.equal(x.context, 'historical', `${x.type} historical`); assert.ok(x.contextReasons.includes('rfb_tachado_source'), `${x.type} reason`); assert.equal(x.legalStatus, 'unknown'); }
  assert.ok(r.canonicalText.includes('8471.30.12'));
  const html = `<html><body><section data-rfb-segment="1" data-rfb-tachado="true">${tbl}</section></body></html>`;
  const dou = readAnatomyInput({ source: 'DOU', representationId: 'x', html });
  assert.ok(dou.parts.filter((x) => x.type === 'cell').every((x) => x.context === 'operative_candidate' && !x.contextReasons.includes('rfb_tachado_source')));
});

test('D04-R1-02 (contract-bound): a tachado unidentified block keeps type unidentified and context unknown (contract), with the tachado evidence as reason; quoted stays prohibited; the engine accepts it', () => {
  const d = doc([seg(2, 3, '<p>Art. 1º Vigente.</p>'), seg(3, 999, 'III texto superado não classificado.', { tachado: true }), seg(4, 3, '<blockquote><p>Art. 5º texto citado.</p></blockquote>', { tachado: true })]);
  const { r, p } = read(d);
  const iii = at(r, 'III texto superado');
  assert.equal(iii.type, 'unidentified', 'type not guessed');
  assert.equal(iii.context, 'unknown', 'contract: unidentified cannot assert another context');
  assert.ok(iii.contextReasons.includes('rfb_tachado_source'), 'tachado evidence preserved'); assert.equal(iii.legalStatus, 'unknown');
  assert.equal(r.parts.find((x) => x.type === 'quoted_text')!.context, 'prohibited');
  assert.doesNotThrow(() => analyzeAnatomy({ publicationVersionId: 's', referenceDate: '2026-11-05', ruleSet: { id: 's', version: '1' },
    input: { source: 'RFB', representationId: 'x', html: p.html }, catalog: { edition: 's', codes: [] } }));
});

test('D04-R1-01 (selection): cells of a tachado table carry exclusion context_historical; the same cells in a non-struck table do not', () => {
  const t = (code: string) => `<table><tr><td>NCM</td><td>Descrição</td></tr><tr><td>${code}</td><td>Equipamento exemplo</td></tr></table>`;
  const { p } = read(doc([seg(2, 3, '<p>Art. 1º Tabela vigente:</p>'), seg(3, 3, t('8471.30.12')), seg(4, 3, '<p>Art. 2º Artigo vigente com tabela superada:</p>'), seg(5, 3, t('8471.41.10'), { tachado: true })]));
  const a = analyzeAnatomy({ publicationVersionId: 's', referenceDate: '2026-11-05', ruleSet: { id: 's', version: '1' },
    input: { source: 'RFB', representationId: 'x', html: p.html }, catalog: { edition: 's', codes: ['84713012', '84714110'] } });
  const cellOf = (code: string) => a.parts.find((x) => x.type === 'cell' && a.canonicalText.slice(x.span.start, x.span.end).includes(code))!;
  const elig = (id: string) => a.eligibility.find((e) => e.partId === id && e.purpose === 'thematic_text')!;
  const live = cellOf('8471.30.12'); const struck = cellOf('8471.41.10');
  assert.equal(live.context, 'operative_candidate'); assert.ok(!elig(live.id).exclusionReasons.includes('context_historical'));
  assert.equal(struck.context, 'historical'); assert.ok(elig(struck.id).exclusionReasons.includes('context_historical'));
  assert.ok(a.eligibility.every((e) => e.eligible === false), 'no positive selection without approved evidence');
  assert.ok(a.parts.every((x) => x.legalStatus === 'unknown'));
});
