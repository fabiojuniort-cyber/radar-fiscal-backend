import assert from 'node:assert/strict';
import test from 'node:test';
import { anatomyOutputHash, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { anatomyResultToPrediction, selectionsFromEligibility } from '../src/modules/anatomy/evaluation-adapter.js';
import { evaluateEntry } from '../src/modules/anatomy/evaluation.js';
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
