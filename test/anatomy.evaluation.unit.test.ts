import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aggregate, evaluateEntry, goldCodeRoles, matchOneToOne, prf, ratio, type Prediction, type PredictedPart } from '../src/modules/anatomy/evaluation.js';
import { ANATOMY_GOLD_VERSION, type AnatomyGold } from '../src/modules/anatomy/gold.js';

// SYNTHETIC gold and predictions only. The engine is never run and no corpus entry is measured.
const text = 'Art. 1º NCM 8471.30.12 e 8471.41.00 a 8471.49.00, exceto 8471.50.00 e 8471.60.00. Capítulo 84. Lei nº 1.234. Redação anterior: 8450.11.00.';
const at = (s: string, nth = 0) => { let i = -1; for (let k = 0; k <= nth; k++) i = text.indexOf(s, i + 1); assert.ok(i >= 0, s); return { start: i, end: i + s.length }; };
const hist = at('Redação anterior: 8450.11.00.');
const art = { start: 0, end: hist.start - 1 };
type GPart = AnatomyGold['parts'][number];
const gp = (id: string, parentId: string | null, order: number, type: GPart['type'], span: { start: number; end: number }, context: GPart['context'] = 'operative_candidate', table: GPart['table'] = null): GPart =>
  ({ id, parentId, order, type, span, context, contextReason: 'synthetic', table });
const E = (id: string, partId: string, literal: string, domain: AnatomyGold['entities'][number]['domain'], nth = 0) => ({ id, partId, span: at(literal, nth), literal, domain, note: '' });

function goldDoc(): AnatomyGold {
  return { goldVersion: ANATOMY_GOLD_VERSION, id: '99', partition: 'development', preparation: 'synthetic/1', canonicalTextSha256: '0'.repeat(64),
    canonicalTextUtf16Length: text.length, status: 'prepared', annotator: 'synthetic', annotatedAt: '2026-10-19',
    parts: [gp('doc', null, 0, 'document', { start: 0, end: text.length }, 'unknown'), gp('a1', 'doc', 0, 'article', art), gp('h1', 'doc', 1, 'body', hist, 'historical'),
      gp('c1', 'a1', 0, 'cell', at('Art. 1º'), 'operative_candidate', { row: 0, column: 0, rowSpan: 1, columnSpan: 1, geometry: 'original', headerDomain: null }),
      gp('c2', 'a1', 1, 'cell', at('Capítulo 84'), 'operative_candidate', { row: 0, column: 1, rowSpan: 1, columnSpan: 1, geometry: 'original', headerDomain: null })],
    entities: [E('n1', 'a1', '8471.30.12', 'NCM'), E('n2', 'a1', '8471.41.00', 'NCM'), E('n3', 'a1', '8471.49.00', 'NCM'), E('n4', 'a1', '8471.50.00', 'NCM'),
      E('n5', 'a1', '8471.60.00', 'NCM'), E('ch', 'a1', '84', 'NCM', 1), E('law', 'a1', 'Lei nº 1.234', 'CITATION'), E('old', 'h1', '8450.11.00', 'NCM')],
    relations: [
      { id: 'r1', kind: 'range', operatorSpan: { start: at('8471.41.00').end + 1, end: at('8471.41.00').end + 2 }, memberEntityIds: ['n2', 'n3'], targetEntityIds: [], scopeSpan: { start: at('8471.41.00').start, end: at('8471.49.00').end }, condition: null },
      { id: 'x1', kind: 'exception', operatorSpan: at('exceto'), memberEntityIds: [], targetEntityIds: ['n4', 'n5'], scopeSpan: { start: at('exceto').start, end: at('8471.60.00').end }, condition: null }],
    gaps: [], review: { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' } };
}
const pp = (id: string, parentId: string | null, order: number, type: string, span: { start: number; end: number }, context = 'operative_candidate', table: PredictedPart['table'] = null): PredictedPart => ({ id, parentId, order, type, span, context, table });
/** A prediction identical to the gold structure; tests then perturb copies of it. */
function perfect(g: AnatomyGold): Prediction {
  return { parts: g.parts.map((p) => pp(`p-${p.id}`, p.parentId ? `p-${p.parentId}` : null, p.order, p.type, p.span, p.context, p.table ? { row: p.table.row, column: p.table.column, rowSpan: p.table.rowSpan, columnSpan: p.table.columnSpan } : null)),
    entities: g.entities.map((e) => ({ id: `p-${e.id}`, domain: e.domain, span: e.span })),
    relations: g.relations.map((r) => ({ kind: r.kind, operatorSpan: r.operatorSpan, memberEntityIds: r.memberEntityIds.map((i) => `p-${i}`), targetEntityIds: r.targetEntityIds.map((i) => `p-${i}`), scopeSpan: r.scopeSpan, condition: r.condition })),
    selections: [] };
}

test('decision table for P/R/F1 and N/A ratios', () => {
  assert.deepEqual(prf(0, 0, 0), { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null });
  assert.deepEqual(prf(0, 3, 0), { tp: 0, fp: 3, fn: 0, precision: 0, recall: null, f1: null });
  assert.deepEqual(prf(0, 0, 4), { tp: 0, fp: 0, fn: 4, precision: null, recall: 0, f1: null }, 'no predictions: precision is N/A');
  assert.deepEqual(prf(0, 2, 4), { tp: 0, fp: 2, fn: 4, precision: 0, recall: 0, f1: 0 }, 'gold and predictions without hits: all zero');
  assert.deepEqual(prf(2, 4, 2), { tp: 2, fp: 2, fn: 0, precision: 0.5, recall: 1, f1: 2 / 3 });
  assert.deepEqual(ratio(0, 0), { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(ratio(1, 4).value, 0.25);
});

test('one-to-one matching: a duplicated prediction never yields a second hit', () => {
  const m = matchOneToOne(['a', 'b'], ['a', 'a', 'c'], (x) => x, (x) => x);
  assert.deepEqual([m.pairs.length, m.unmatchedGold, m.unmatchedPred], [1, ['b'], ['a', 'c']]);
  const g = goldDoc(); const p = perfect(g); p.entities.push({ id: 'dup', domain: 'NCM', span: g.entities[0]!.span });
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.R1.tp, r.R1.fp, r.R1.fn], [6, 1, 0], 'duplicate NCM is one extra FP');
  // Gold repeated twice only counts twice if predicted twice.
  assert.equal(matchOneToOne(['k', 'k'], ['k'], (x) => x, (x) => x).pairs.length, 1);
});

test('perfect structural prediction scores 1 where defined and keeps N/A where it must', () => {
  const g = goldDoc(); const r = evaluateEntry('99', 'SYN', g, perfect(g));
  for (const k of ['E1', 'E5', 'R1', 'R4', 'R6', 'M1', 'M2a'] as const) assert.deepEqual([r[k].precision, r[k].recall, r[k].f1], [1, 1, 1], k);
  assert.deepEqual([r.R2.precision, r.R2.recall, r.R2.f1], [null, null, null], 'no NBM in gold nor prediction');
  for (const k of ['E2', 'E3', 'E4', 'M2b'] as const) assert.equal(r[k].value, 1, k);
  assert.equal(r.R3.value, 0, 'no domain swap');
  assert.equal(r.R5.value, 0, 'citation not hit by NCM');
  assert.equal(r.M2c.status, 'N/A'); assert.equal(r.M2.status, 'N/A'); assert.equal(r.S2.status, 'N/A');
  assert.equal(r.C1 && 'status' in r.C1 ? r.C1.status : 'ratio', 'N/A');
});

test('hierarchy, order, context and table geometry errors are counted separately', () => {
  const g = goldDoc(); const p = perfect(g);
  const c2 = p.parts.find((x) => x.id === 'p-c2')!; c2.parentId = 'p-h1';           // wrong parent
  const c1 = p.parts.find((x) => x.id === 'p-c1')!; c1.order = 5;                    // order swap among siblings
  p.parts.find((x) => x.id === 'p-a1')!.context = 'historical';                       // context error
  c1.table = { row: 0, column: 0, rowSpan: 2, columnSpan: 1 };                         // geometry error
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.E2.numerator, r.E2.denominator], [1, 2]);
  assert.deepEqual([r.E3.numerator, r.E3.denominator], [1, 2], 'a1→h1 keep order; c1/c2 lose it (different predicted parent)');
  assert.equal(r.E4.confusion['operative_candidate->historical'], 1);
  assert.deepEqual([r.E5.tp, r.E5.fp, r.E5.fn], [1, 1, 1]);
  assert.equal(r.E1.f1, 1, 'type and span still match');
  const none = evaluateEntry('99', 'SYN', g, { parts: [], entities: [], relations: [], selections: [] });
  assert.deepEqual([none.E1.precision, none.E1.recall, none.E2.value, none.E3.value, none.E4.value], [null, 0, null, null, null]);
});

test('domains: NCM×NBM swap, chapter class, and false NCM over other domains', () => {
  const g = goldDoc(); const p = perfect(g);
  p.entities.find((e) => e.id === 'p-n1')!.domain = 'NBM';
  p.entities.push({ id: 'fake', domain: 'NCM', span: { start: at('1.234').start, end: at('1.234').end } });
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.equal(r.R1.fn, 1); assert.equal(r.R2.fp, 1); assert.deepEqual([r.R3.numerator, r.R3.denominator], [1, 7]);
  assert.deepEqual([r.R5.numerator, r.R5.denominator], [1, 1]);
  assert.deepEqual([r.R4.tp, r.R4.fn], [1, 0], 'chapter kept out of R1');
});

test('ranges need both ends in order; exceptions need the target set; scope widening is not full credit; M2c/M2 N/A', () => {
  const g = goldDoc(); const p = perfect(g);
  const range = p.relations.find((r) => r.kind === 'range')!; range.memberEntityIds.reverse();
  const exc = p.relations.find((r) => r.kind === 'exception')!; exc.targetEntityIds.reverse();
  exc.scopeSpan = { start: exc.scopeSpan!.start, end: text.indexOf('Capítulo') };    // widened scope
  exc.condition = 'salvo se sintético';
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.M1.tp, r.M1.fp, r.M1.fn], [0, 1, 1], 'swapped range ends do not match');
  assert.equal(r.M2a.tp, 1, 'target set is order-free');
  assert.deepEqual([r.M2b.numerator, r.M2b.denominator], [0, 1], 'widened scope is an error');
  assert.equal(r.M2.status, 'N/A'); assert.equal(r.M2c.status, 'N/A');
});

test('S1: denominator from the gold; each hit span once in S1a; raw emissions and invented positives in S1b', () => {
  const g = goldDoc(); const p = perfect(g);
  const roles = goldCodeRoles(g);
  assert.deepEqual([roles.candidates.length, roles.nonCandidates.length], [1, 6], 'only 8471.30.12 is a candidate; range ends, exception targets, chapter and historical are not');
  p.selections = [
    { purpose: 'ncm', positive: true, span: at('8471.30.12') },     // candidate: not a violation
    { purpose: 'ncm', positive: true, span: at('8450.11.00') },     // historical: violation
    { purpose: 'ncm', positive: true, span: at('8450.11.00') },     // same span again: S1a once, S1b twice
    { purpose: 'ncm', positive: true, span: at('8471.50.00') },     // exception target: violation
    { purpose: 'ncm', positive: false, span: at('8471.60.00') },    // negative selection: ignored
    { purpose: 'thematic_text', positive: true, span: at('8471.60.00') }, // thematic channel: ignored
    { purpose: 'ncm', positive: true, span: at('Lei nº') },          // invented over no gold code
  ];
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.S1a.numerator, r.S1a.denominator], [2, 6]);
  assert.deepEqual(r.S1b, { emitted: 5, violations: 4, unverifiable: 0, classes: { exactCandidate: 1, onNonCandidate: 3, inexactOnCandidate: 0, outsideGoldCodes: 1, inGap: 0, unlocated: 0 } });
  // Matching does not change the S1 denominator.
  const empty = evaluateEntry('99', 'SYN', g, { parts: [], entities: [], relations: [], selections: [] });
  assert.equal(empty.S1a.denominator, 6);
});

test('S1b flags invented positives in a document without codes, where S1a is N/A', () => {
  const g = goldDoc(); g.entities = g.entities.filter((e) => e.domain === 'CITATION'); g.relations = [];
  const r = evaluateEntry('98', 'SYN', g, { ...perfect(g), selections: [{ purpose: 'ncm', positive: true, span: at('Art. 1º') }] });
  assert.equal(r.S1a.value, null);
  assert.deepEqual(r.S1b, { emitted: 1, violations: 1, unverifiable: 0, classes: { exactCandidate: 0, onNonCandidate: 0, inexactOnCandidate: 0, outsideGoldCodes: 1, inGap: 0, unlocated: 0 } });
});

test('aggregation sums counts per source and overall; ratios are not averaged; N/A survives', () => {
  const g = goldDoc();
  const good = evaluateEntry('a', 'CONFAZ', g, perfect(g));
  const p = perfect(g); p.entities = p.entities.filter((e) => e.domain !== 'NCM');
  const bad = evaluateEntry('b', 'CONFAZ', g, p);
  const g2 = goldDoc(); g2.entities = []; g2.relations = [];
  const dou = evaluateEntry('c', 'DOU', g2, { ...perfect(g2), selections: [{ purpose: 'ncm', positive: true, span: at('Art. 1º') }] });
  const agg = aggregate([good, bad, dou]);
  assert.deepEqual(Object.keys(agg).sort(), ['ALL', 'CONFAZ', 'DOU']);
  assert.deepEqual([agg.CONFAZ!.R1.tp, agg.CONFAZ!.R1.fp, agg.CONFAZ!.R1.fn], [6, 0, 6]);
  assert.equal(agg.CONFAZ!.R1.precision, 1); assert.equal(agg.CONFAZ!.R1.recall, 0.5);
  assert.deepEqual([agg.DOU!.R1.precision, agg.DOU!.R1.recall], [null, null], 'DOU: no NCM gold nor prediction');
  assert.equal(agg.DOU!.S1a.value, null); assert.equal(agg.DOU!.S1b.violations, 1);
  assert.deepEqual([agg.ALL!.S1a.denominator, agg.ALL!.S1b.violations], [12, 1]);
  assert.deepEqual(agg.ALL!.entries, ['a', 'b', 'c']);
});

// Adversarial reproductions of the EVAL-01 review findings (GPT/Codex, PR #244 review 5566614441).

test('finding 1: a relation whose ends carry the wrong nomenclature (NCM↔NBM) is not a hit', () => {
  const g = goldDoc(); const p = perfect(g);
  for (const id of ['p-n2', 'p-n3', 'p-n4']) p.entities.find((e) => e.id === id)!.domain = 'NBM';
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.M1.tp, r.M1.fp, r.M1.fn], [0, 1, 1], 'range with NBM ends');
  assert.deepEqual([r.M2a.tp, r.M2a.fp, r.M2a.fn], [0, 1, 1], 'exception with one NBM target');
  assert.equal(r.M2b.value, null, 'no M2a pair, so scope is N/A');
  // A relation pointing to an entity id that does not exist never matches.
  const q = perfect(g); q.relations.find((x) => x.kind === 'range')!.memberEntityIds = ['ghost', 'p-n3'];
  assert.equal(evaluateEntry('99', 'SYN', g, q).M1.tp, 0);
});

test('finding 2: every positive ncm emission is classified; inexact and unlocated spans never disappear', () => {
  const g = goldDoc(); const cand = at('8471.30.12');
  const sel = (span: { start: number; end: number } | null) => ({ purpose: 'ncm' as const, positive: true, span });
  const p = { ...perfect(g), selections: [
    sel({ start: cand.start, end: cand.end - 1 }),          // inexact on a candidate
    sel({ start: cand.start - 4, end: cand.end }),          // wider than the candidate
    sel(null),                                              // no span
    sel({ start: 5, end: 3 }),                              // inverted span
    sel({ start: text.length, end: text.length + 4 }),      // outside the text
    sel(cand),                                              // exact candidate
  ] };
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual(r.S1b.classes, { exactCandidate: 1, onNonCandidate: 0, inexactOnCandidate: 2, outsideGoldCodes: 0, inGap: 0, unlocated: 3 });
  assert.deepEqual([r.S1b.emitted, r.S1b.violations, r.S1b.unverifiable], [6, 2, 3]);
  const sum = Object.values(r.S1b.classes).reduce((a, b) => a + b, 0);
  assert.equal(sum, r.S1b.emitted, 'classes are exhaustive');
});

test('finding 3: emissions in declared gaps or unidentified parts are unverifiable, not proven violations', () => {
  const g = goldDoc(); const law = at('Lei nº 1.234');
  g.entities = g.entities.filter((e) => e.domain !== 'CITATION');
  g.gaps = [{ kind: 'missing_attachment', span: law, resource: null, note: 'synthetic gap' }];
  const tail = at('Capítulo 84');
  g.parts.push(gp('u1', 'a1', 2, 'unidentified', { start: tail.end + 2, end: tail.end + 3 }, 'unknown'));
  const p = { ...perfect(g), selections: [
    { purpose: 'ncm' as const, positive: true, span: law },                                   // in a declared gap
    { purpose: 'ncm' as const, positive: true, span: { start: tail.end + 2, end: tail.end + 3 } }, // in an unidentified part
    { purpose: 'ncm' as const, positive: true, span: at('Art. 1º') },                           // annotated text, no code
  ] };
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.S1b.classes.inGap, r.S1b.classes.outsideGoldCodes, r.S1b.violations, r.S1b.unverifiable], [2, 1, 1, 2]);
});

test('finding 4: an omitted sibling cannot hide an inversion between its neighbours (E3)', () => {
  const g = goldDoc();
  const s = (n: number) => ({ start: 120 + n * 2, end: 121 + n * 2 });
  g.parts = [g.parts[0]!, gp('x', 'doc', 0, 'body', s(0)), gp('y', 'doc', 1, 'body', s(1)), gp('z', 'doc', 2, 'body', s(2))];
  g.entities = []; g.relations = [];
  const p: Prediction = { parts: [pp('p-doc', null, 0, 'document', g.parts[0]!.span, 'unknown'), pp('pz', 'p-doc', 0, 'body', s(2)), pp('px', 'p-doc', 1, 'body', s(0))],
    entities: [], relations: [], selections: [] };   // y omitted; z placed before x
  const r = evaluateEntry('99', 'SYN', g, p);
  assert.deepEqual([r.E3.numerator, r.E3.denominator], [0, 1], 'x→z inversion is caught despite the missing y');
  const ok: Prediction = { ...p, parts: [p.parts[0]!, pp('px', 'p-doc', 0, 'body', s(0)), pp('pz', 'p-doc', 1, 'body', s(2))] };
  assert.deepEqual([evaluateEntry('99', 'SYN', g, ok).E3.numerator, evaluateEntry('99', 'SYN', g, ok).E3.denominator], [1, 1]);
});

test('aggregation keeps the S1b classes and the exhaustive sum', () => {
  const g = goldDoc();
  const a = evaluateEntry('a', 'CONFAZ', g, { ...perfect(g), selections: [{ purpose: 'ncm', positive: true, span: null }] });
  const b = evaluateEntry('b', 'DOU', g, { ...perfect(g), selections: [{ purpose: 'ncm', positive: true, span: at('8450.11.00') }] });
  const agg = aggregate([a, b]).ALL!;
  assert.deepEqual([agg.S1b.emitted, agg.S1b.violations, agg.S1b.unverifiable, agg.S1b.classes.unlocated, agg.S1b.classes.onNonCandidate], [2, 1, 1, 1, 1]);
});

test('static gold roles agree with the approved 01 matrix counts (no engine, no measurement)', () => {
  const g01 = JSON.parse(readFileSync(new URL('./fixtures/anatomy/gold/01.json', import.meta.url), 'utf8')) as AnatomyGold;
  const roles = goldCodeRoles(g01);
  assert.deepEqual([roles.candidates.length, roles.nonCandidates.length], [640, 1362]);
  const g02 = JSON.parse(readFileSync(new URL('./fixtures/anatomy/gold/02.json', import.meta.url), 'utf8')) as AnatomyGold;
  assert.deepEqual([goldCodeRoles(g02).candidates.length, goldCodeRoles(g02).nonCandidates.length], [0, 1]);
});
