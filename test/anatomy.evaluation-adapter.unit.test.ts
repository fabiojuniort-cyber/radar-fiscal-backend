import assert from 'node:assert/strict';
import test from 'node:test';
import { anatomyOutputHash, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { anatomyResultToPrediction, selectionsFromEligibility } from '../src/modules/anatomy/evaluation-adapter.js';
import { aggregate, evaluateEntry } from '../src/modules/anatomy/evaluation.js';
import { ANATOMY_GOLD_VERSION, type AnatomyGold } from '../src/modules/anatomy/gold.js';

// SYNTHETIC inputs only: the engine runs on inline HTML written here; no corpus entry, reserve or source is used.
const HTML = '<p class="TextoAcordo">Cláusula primeira NCM 8471.41.00 a 8471.49.00, exceto 8471.50.00 e 0101.21.00.</p>'
  + '<table><tr><td>NCM</td></tr><tr><td>7307.19.20</td></tr></table>';
function request(over: Partial<AnatomyRequest> = {}): AnatomyRequest {
  return { publicationVersionId: 'synthetic-version', referenceDate: '2026-10-16', ruleSet: { id: 'synthetic', version: '1' },
    input: { source: 'CONFAZ', representationId: 'synthetic-html', html: HTML },
    catalog: { edition: 'synthetic-2026', codes: ['84714100', '84714900', '84715000', '01012100', '73071920'] }, ...over };
}
/** Mutate a valid result and re-seal its output hash, so only the intended field differs. */
function reseal(result: AnatomyResult, mutate: (r: AnatomyResult) => void): AnatomyResult {
  const copy = structuredClone(result); mutate(copy); copy.outputHash = anatomyOutputHash(copy); return copy;
}

test('selections must be explicit: nothing is derived from eligibility, and the opt-in mapping is one to one', () => {
  const result = analyzeAnatomy(request());
  assert.throws(() => anatomyResultToPrediction(result, undefined as never), /explicitly/);
  assert.throws(() => anatomyResultToPrediction(result, {} as never), /explicitly/);
  const p = anatomyResultToPrediction(result, { selections: [] });
  assert.ok(result.eligibility.length > 0);
  assert.deepEqual(p.selections, [], 'eligibility is not turned into selections');
  const opted = selectionsFromEligibility(result);
  assert.equal(opted.length, result.eligibility.length);
  assert.deepEqual(opted.map((s) => s.positive), result.eligibility.map((s) => s.eligible), 'eligible → positive, unchanged');
  assert.ok(opted.every((s) => !s.positive), 'the synthetic engine output has no positive selection');
});

test('parts, entity spans and domains are preserved; compound carriers become relations, not occurrences', () => {
  const result = analyzeAnatomy(request());
  const p = anatomyResultToPrediction(result, { selections: [] });
  assert.deepEqual(p.parts.map((x) => [x.id, x.parentId, x.order, x.type, x.span, x.context]),
    result.parts.map((x) => [x.id, x.parentId, x.order, x.type, x.span, x.context]));
  const plain = result.entities.filter((e) => e.domain !== 'NCM_RANGE' && e.domain !== 'NCM_EXCEPTION');
  assert.deepEqual(p.entities, plain.map((e) => ({ id: e.id, domain: e.domain, span: e.span })));
  assert.ok(!p.entities.some((e) => e.domain === 'NCM_RANGE' || e.domain === 'NCM_EXCEPTION'));
  const text = result.canonicalText;
  const range = p.relations.find((r) => r.kind === 'range')!;
  const literalOf = (id: string) => { const s = p.entities.find((e) => e.id === id)!.span; return text.slice(s.start, s.end); };
  assert.deepEqual(range.memberEntityIds.map(literalOf), ['8471.41.00', '8471.49.00'], 'range ends in order');
  assert.equal(text.slice(range.operatorSpan!.start, range.operatorSpan!.end), 'a');
  const exc = p.relations.find((r) => r.kind === 'exception')!;
  const compound = result.entities.find((e) => e.domain === 'NCM_EXCEPTION')!;
  assert.equal(text.slice(exc.operatorSpan!.start, exc.operatorSpan!.end), 'exceto');
  assert.deepEqual(exc.targetEntityIds, compound.relation!.targetEntityIds, 'targets kept exactly as the engine emitted them');
  assert.deepEqual([exc.scopeSpan, exc.condition], [compound.span, compound.relation!.condition]);
  assert.deepEqual(p.coverage, { textLength: result.coverage.textLength, recognizedLength: result.coverage.recognizedLength });
  assert.deepEqual(p.pending!.unresolved, []);
});

test('pending items are preserved: status, missing resources, limitations, unknown geometry, unlocatable operators', () => {
  const partial = analyzeAnatomy(request({ attachments: [{ resourceId: 'synthetic-annex', sha256: null, state: 'missing' }] }));
  const p = anatomyResultToPrediction(partial, { selections: [] });
  assert.equal(p.pending!.status, 'partial');
  assert.deepEqual(p.pending!.missingResources, partial.coverage.missingResources);
  assert.deepEqual(p.pending!.limitations.map((l) => l.code), partial.limitations.map((l) => l.code));
  assert.deepEqual(p.pending!.unidentifiedSegments, partial.coverage.segments.filter((s) => s.classification === 'unidentified').map((s) => s.span));

  const base = analyzeAnatomy(request());
  const cellId = base.parts.find((x) => x.type === 'cell')!.id;
  const unknown = reseal(base, (r) => { r.parts.find((x) => x.id === cellId)!.table!.geometry = 'unknown'; });
  const q = anatomyResultToPrediction(unknown, { selections: [] });
  assert.equal(q.parts.find((x) => x.id === cellId)!.table, null, 'unknown geometry is not claimed');
  assert.deepEqual(q.pending!.unresolved.filter((u) => u.kind === 'table_geometry').map((u) => u.ref), [cellId]);

  const lost = reseal(base, (r) => { for (const e of r.entities) if (e.relation?.kind === 'range' || e.relation?.kind === 'range_start' || e.relation?.kind === 'range_end') e.relation.operator = 'até'; });
  const z = anatomyResultToPrediction(lost, { selections: [] });
  assert.equal(z.relations.find((r) => r.kind === 'range')!.operatorSpan, null);
  assert.ok(z.pending!.unresolved.some((u) => u.kind === 'operator_span'));
});

test('the adapter validates the contract (fail closed) and never mutates its input', () => {
  const result = analyzeAnatomy(request());
  const before = JSON.stringify(result);
  anatomyResultToPrediction(result, { selections: [{ purpose: 'ncm', positive: true, span: { start: 0, end: 4 } }] });
  assert.equal(JSON.stringify(result), before);
  const tampered = structuredClone(result); tampered.entities[0]!.span = { start: 0, end: 1 }; // hash no longer matches
  assert.throws(() => anatomyResultToPrediction(tampered, { selections: [] }));
});

// Reproductions of the EVAL-02 review (GPT/Codex, PR #244 review 5566856002). The contract accepts these shapes,
// so the adapter must report them instead of dropping them.

test('finding 1: a compound without a relation of its own kind is reported with id and reason, never dropped', () => {
  const base = analyzeAnatomy(request());
  const rangeId = base.entities.find((e) => e.domain === 'NCM_RANGE')!.id;
  const excId = base.entities.find((e) => e.domain === 'NCM_EXCEPTION')!.id;
  const noRel = reseal(base, (r) => { r.entities.find((e) => e.id === rangeId)!.relation = null; });
  const a = anatomyResultToPrediction(noRel, { selections: [] });
  assert.ok(!a.relations.some((x) => x.kind === 'range'));
  assert.deepEqual(a.pending!.unresolved.filter((u) => u.kind === 'compound_relation'), [{ kind: 'compound_relation', ref: rangeId, detail: 'NCM_RANGE has no relation' }]);
  const wrong = reseal(base, (r) => { r.entities.find((e) => e.id === excId)!.relation!.kind = 'range'; });
  const b = anatomyResultToPrediction(wrong, { selections: [] });
  assert.ok(b.pending!.unresolved.some((u) => u.kind === 'compound_relation' && u.ref === excId && /expected "exception"/.test(u.detail)));
  assert.equal(b.relations.filter((x) => x.kind === 'exception').length, 0, 'not converted under the wrong kind');
});

test('finding 2: a range keeps the condition it was given', () => {
  const base = analyzeAnatomy(request());
  const rangeId = base.entities.find((e) => e.domain === 'NCM_RANGE')!.id;
  const withCond = reseal(base, (r) => { r.entities.find((e) => e.id === rangeId)!.relation!.condition = 'desde que sintético'; });
  assert.equal(anatomyResultToPrediction(withCond, { selections: [] }).relations.find((x) => x.kind === 'range')!.condition, 'desde que sintético');
  assert.equal(anatomyResultToPrediction(base, { selections: [] }).relations.find((x) => x.kind === 'range')!.condition, null);
});

function syntheticGold(text: string, relations: AnatomyGold['relations'], entities: AnatomyGold['entities'], extraParts: AnatomyGold['parts'] = []): AnatomyGold {
  return { goldVersion: ANATOMY_GOLD_VERSION, id: '96', partition: 'development', preparation: 'synthetic/1', canonicalTextSha256: '0'.repeat(64),
    canonicalTextUtf16Length: text.length, status: 'prepared', annotator: 'synthetic', annotatedAt: '2026-10-19',
    parts: [{ id: 'd', parentId: null, order: 0, type: 'document', span: { start: 0, end: text.length }, context: 'unknown', contextReason: 'document', table: null },
      { id: 'b', parentId: 'd', order: 0, type: 'body', span: { start: 0, end: text.length }, context: 'operative_candidate', contextReason: 'synthetic', table: null }, ...extraParts],
    entities, relations, gaps: [], review: { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' } };
}

test('finding 3: pending items reach evaluateEntry and the aggregation, and unknown fields never earn credit', () => {
  const base = analyzeAnatomy(request());
  const text = base.canonicalText; const at = (s: string) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
  const ent = (id: string, lit: string) => ({ id, partId: 'b', span: at(lit), literal: lit, domain: 'NCM' as const, note: '' });
  const ents = [ent('a', '8471.41.00'), ent('z', '8471.49.00'), ent('x', '8471.50.00')];
  // Unknown operator on BOTH sides: null = null must not be a hit.
  const lost = reseal(base, (r) => { for (const e of r.entities) if (e.relation && ['range', 'range_start', 'range_end'].includes(e.relation.kind)) e.relation.operator = 'até'; });
  const pLost = anatomyResultToPrediction(lost, { selections: [] });
  const g1 = syntheticGold(text, [{ id: 'r', kind: 'range', operatorSpan: null, memberEntityIds: ['a', 'z'], targetEntityIds: [], scopeSpan: null, condition: null }], ents);
  const e1 = evaluateEntry('96', 'SYN', g1, pLost);
  assert.deepEqual([e1.M1.tp, e1.M1.fp, e1.M1.fn], [0, 1, 1], 'unknown operator on both sides earns nothing');
  // Gold operator known, prediction unknown: still no credit.
  const opSpan = { start: at('8471.41.00').end + 1, end: at('8471.41.00').end + 2 };
  const g2 = syntheticGold(text, [{ id: 'r', kind: 'range', operatorSpan: opSpan, memberEntityIds: ['a', 'z'], targetEntityIds: [], scopeSpan: null, condition: null }], ents);
  assert.equal(evaluateEntry('96', 'SYN', g2, pLost).M1.tp, 0);
  assert.equal(evaluateEntry('96', 'SYN', g2, anatomyResultToPrediction(base, { selections: [] })).M1.tp, 1, 'known and equal operator does match');
  // Unknown scope (null on both sides) never earns M2b, even with an M2a pair.
  const pBase = anatomyResultToPrediction(base, { selections: [] });
  const exc = pBase.relations.find((r) => r.kind === 'exception')!;
  const targets = exc.targetEntityIds.map((id) => pBase.entities.find((e) => e.id === id)!);
  const gEnts = targets.map((t, i) => ({ id: `t${i}`, partId: 'b', span: t.span, literal: text.slice(t.span.start, t.span.end), domain: t.domain as 'NCM', note: '' }));
  const g3 = syntheticGold(text, [{ id: 'x', kind: 'exception', operatorSpan: exc.operatorSpan, memberEntityIds: [], targetEntityIds: gEnts.map((e) => e.id), scopeSpan: null, condition: null }], gEnts);
  const nullScope = { ...pBase, relations: pBase.relations.map((r) => (r.kind === 'exception' ? { ...r, scopeSpan: null } : r)) };
  const e3 = evaluateEntry('96', 'SYN', g3, nullScope);
  assert.equal(e3.M2a.tp, 1); assert.deepEqual([e3.M2b.numerator, e3.M2b.denominator], [0, 1], 'unknown scope earns nothing');
  // Unknown table geometry never earns E5, even against another unknown.
  const cell = base.parts.find((x) => x.type === 'cell')!;
  const gCell = syntheticGold(text, [], [], [{ id: 'c', parentId: 'b', order: 0, type: 'cell', span: cell.span, context: 'operative_candidate', contextReason: 'synthetic',
    table: { row: cell.table!.row, column: cell.table!.column, rowSpan: cell.table!.rowSpan, columnSpan: cell.table!.columnSpan, geometry: 'original', headerDomain: null } }]);
  const unknownGeo = anatomyResultToPrediction(reseal(base, (r) => { r.parts.find((x) => x.id === cell.id)!.table!.geometry = 'unknown'; }), { selections: [] });
  assert.equal(evaluateEntry('96', 'SYN', gCell, unknownGeo).E5.tp, 0);
  assert.equal(evaluateEntry('96', 'SYN', gCell, pBase).E5.tp, 1, 'known geometry still matches');
  // Pending propagation: entry and aggregation.
  const partial = analyzeAnatomy(request({ attachments: [{ resourceId: 'synthetic-annex', sha256: null, state: 'missing' }] }));
  const ePartial = evaluateEntry('p', 'CONFAZ', g1, anatomyResultToPrediction(partial, { selections: [] }));
  assert.equal(ePartial.pending!.status, 'partial');
  assert.deepEqual(ePartial.pending!.missingResources, partial.coverage.missingResources);
  const eLost = evaluateEntry('l', 'DOU', g1, pLost);
  assert.ok(eLost.pending!.unresolved.some((u) => u.kind === 'operator_span'));
  const agg = aggregate([ePartial, eLost]);
  assert.deepEqual(agg.ALL!.pending.nonCompleteEntries, ['p']);
  assert.deepEqual(agg.ALL!.pending.entriesWithPending.sort(), ['l', 'p']);
  assert.ok((agg.ALL!.pending.unresolved.operator_span ?? 0) >= 1);
  assert.equal(agg.ALL!.pending.missingResources, partial.coverage.missingResources.length);
  assert.deepEqual(agg.DOU!.pending.entriesWithPending, ['l']);
  // A hand-written prediction without pending is reported as null, not as "nothing pending" invented.
  assert.equal(evaluateEntry('h', 'SYN', g1, { parts: [], entities: [], relations: [], selections: [] }).pending, null);
});

// Residual items of the EVAL-02 R2 review (GPT/Codex, PR #244 review 5566918687).

test('residual 1: unknown geometry on the GOLD side never earns E5 credit', () => {
  const base = analyzeAnatomy(request()); const text = base.canonicalText;
  const cell = base.parts.find((x) => x.type === 'cell')!;
  const goldWith = (geometry: 'original' | 'unknown') => syntheticGold(text, [], [], [{ id: 'c', parentId: 'b', order: 0, type: 'cell', span: cell.span, context: 'operative_candidate',
    contextReason: 'synthetic', table: { row: cell.table!.row, column: cell.table!.column, rowSpan: cell.table!.rowSpan, columnSpan: cell.table!.columnSpan, geometry, headerDomain: null } }]);
  const pred = anatomyResultToPrediction(base, { selections: [] });
  assert.equal(evaluateEntry('96', 'SYN', goldWith('original'), pred).E5.tp, 1);
  const r = evaluateEntry('96', 'SYN', goldWith('unknown'), pred).E5;
  assert.deepEqual([r.tp, r.fn], [0, 1], 'same row/column but the gold geometry is unknown');
});

test('residual 2: a relation target that is a compound (removed from the prediction) is diagnosed and earns nothing', () => {
  const base = analyzeAnatomy(request());
  const rangeId = base.entities.find((e) => e.domain === 'NCM_RANGE')!.id;
  const excId = base.entities.find((e) => e.domain === 'NCM_EXCEPTION')!.id;
  const pointing = reseal(base, (r) => { r.entities.find((e) => e.id === excId)!.relation!.targetEntityIds.push(rangeId); });
  const p = anatomyResultToPrediction(pointing, { selections: [] });
  assert.ok(p.pending!.unresolved.some((u) => u.kind === 'relation_target' && u.ref === excId && u.detail.includes(rangeId) && /compound NCM_RANGE/.test(u.detail)));
  assert.ok(p.relations.find((x) => x.kind === 'exception')!.targetEntityIds.includes(rangeId), 'reference kept as emitted, not rewritten');
  // Scored against a gold exception with the same operator and the real targets, the dangling compound reference blocks M2a.
  const text = base.canonicalText; const exc = p.relations.find((x) => x.kind === 'exception')!;
  const real = exc.targetEntityIds.filter((id) => id !== rangeId).map((id, i) => { const s = p.entities.find((e) => e.id === id)!.span;
    return { id: `t${i}`, partId: 'b', span: s, literal: text.slice(s.start, s.end), domain: 'NCM' as const, note: '' }; });
  const g = syntheticGold(text, [{ id: 'x', kind: 'exception', operatorSpan: exc.operatorSpan, memberEntityIds: [], targetEntityIds: real.map((e) => e.id), scopeSpan: null, condition: null }], real);
  assert.equal(evaluateEntry('96', 'SYN', g, p).M2a.tp, 0);
  assert.equal(evaluateEntry('96', 'SYN', g, anatomyResultToPrediction(base, { selections: [] })).M2a.tp, 1, 'without the compound reference it matches');
});

test('residual 3: the aggregation keeps per-entry pending detail (resources, reasons, references, spans) next to the counts', () => {
  const base = analyzeAnatomy(request()); const text = base.canonicalText;
  const g = syntheticGold(text, [], []);
  const partial = analyzeAnatomy(request({ attachments: [{ resourceId: 'synthetic-annex', sha256: null, state: 'missing' }] }));
  const lost = reseal(base, (r) => { for (const e of r.entities) if (e.relation && ['range', 'range_start', 'range_end'].includes(e.relation.kind)) e.relation.operator = 'até'; });
  const a = evaluateEntry('p', 'CONFAZ', g, anatomyResultToPrediction(partial, { selections: [] }));
  const b = evaluateEntry('l', 'DOU', g, anatomyResultToPrediction(lost, { selections: [] }));
  const c = evaluateEntry('h', 'DOU', g, { parts: [], entities: [], relations: [], selections: [] });
  const agg = aggregate([a, b, c]);
  assert.deepEqual(agg.ALL!.pending.byEntry.map((x) => [x.id, x.source]), [['p', 'CONFAZ'], ['l', 'DOU'], ['h', 'DOU']]);
  assert.deepEqual(agg.ALL!.pending.byEntry[0]!.pending, a.pending, 'resources, limitations and spans preserved');
  assert.deepEqual(agg.ALL!.pending.byEntry[0]!.pending!.missingResources, partial.coverage.missingResources);
  const lostDetail = agg.ALL!.pending.byEntry[1]!.pending!.unresolved.find((u) => u.kind === 'operator_span')!;
  assert.ok(lostDetail.ref.startsWith('entity:NCM_RANGE') && /até/.test(lostDetail.detail), 'reference and reason preserved');
  assert.equal(agg.ALL!.pending.byEntry[2]!.pending, null, 'undeclared pending stays null');
  assert.deepEqual(agg.DOU!.pending.byEntry.map((x) => x.id), ['l', 'h']);
  assert.equal(agg.ALL!.pending.missingResources, partial.coverage.missingResources.length, 'counts kept');
  // The detail is a copy: changing it does not alter the entry evaluation.
  agg.ALL!.pending.byEntry[0]!.pending!.missingResources.push('tampered');
  assert.ok(!a.pending!.missingResources.includes('tampered'));
});

test('end to end in memory: adapted prediction without coverage keeps an invented positive pending, and with an explicit selection on a code it is proven', () => {
  const result = analyzeAnatomy(request());
  const text = result.canonicalText;
  const at = (s: string) => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
  // A tiny synthetic gold over the same canonical text: one historical code and nothing else annotated.
  const gold: AnatomyGold = { goldVersion: ANATOMY_GOLD_VERSION, id: '97', partition: 'development', preparation: 'synthetic/1', canonicalTextSha256: '0'.repeat(64),
    canonicalTextUtf16Length: text.length, status: 'prepared', annotator: 'synthetic', annotatedAt: '2026-10-19',
    parts: [{ id: 'd', parentId: null, order: 0, type: 'document', span: { start: 0, end: text.length }, context: 'unknown', contextReason: 'document', table: null },
      { id: 'h', parentId: 'd', order: 0, type: 'body', span: at('Cláusula primeira NCM 8471.41.00'), context: 'historical', contextReason: 'synthetic', table: null }],
    entities: [{ id: 'g1', partId: 'h', span: at('8471.41.00'), literal: '8471.41.00', domain: 'NCM', note: '' }], relations: [], gaps: [],
    review: { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' } };
  const selections = [{ purpose: 'ncm' as const, positive: true, span: at('Cláusula') }, { purpose: 'ncm' as const, positive: true, span: at('8471.41.00') }];
  const r = evaluateEntry('97', 'SYN', gold, anatomyResultToPrediction(result, { selections }));
  assert.deepEqual([r.S1b.emitted, r.S1b.classes.pendingCoverage, r.S1b.classes.onNonCandidate, r.S1b.violations], [2, 1, 1, 1]);
  assert.equal(r.R1.tp, 1, 'the code occurrence is preserved through the adapter');
});
