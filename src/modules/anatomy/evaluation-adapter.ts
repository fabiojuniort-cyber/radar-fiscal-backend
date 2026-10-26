import { validateAnatomyResult, type AnatomyResult } from './contract.js';
import type { Prediction, PredictedRelation, PredictedSelection, PredictionPending } from './evaluation.js';

/**
 * ANAT-04-EVAL-02 — pure adapter from a validated `AnatomyResult` to the evaluator `Prediction`, in memory only.
 * It preserves spans, domains, relations and the result's own pending items. It NEVER infers positive selections
 * nor annotation coverage: selections are an explicit, required input, and proven coverage stays an evaluator option.
 */
export const EVALUATION_ADAPTER_VERSION = 'ANAT-EVAL-ADAPTER/1.0.0' as const;

type Span = { start: number; end: number };
export interface AdapterInput { /** Explicit selections to evaluate; pass [] for none. Nothing is derived. */ selections: PredictedSelection[] }

const COMPOUND = new Set(['NCM_RANGE', 'NCM_EXCEPTION']);

/** All occurrences of `needle` fully inside [from, to) of `text`. */
function occurrences(text: string, needle: string, from: number, to: number): number[] {
  const out: number[] = []; if (!needle) return out;
  for (let i = text.indexOf(needle, from); i >= 0 && i + needle.length <= to; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export function anatomyResultToPrediction(input: AnatomyResult, explicit: AdapterInput): Prediction {
  if (!explicit || !Array.isArray(explicit.selections)) throw new TypeError('selections must be passed explicitly (use [] for none)');
  const result = validateAnatomyResult(input); // fail closed on any contract violation
  const text = result.canonicalText;
  const pending: PredictionPending = { status: result.status,
    limitations: result.limitations.map((l) => ({ code: l.code, partId: l.partId, span: l.span ? { ...l.span } : null })),
    unidentifiedSegments: result.coverage.segments.filter((s) => s.classification === 'unidentified').map((s) => ({ ...s.span })),
    missingResources: [...result.coverage.missingResources], unresolved: [] };

  const parts = result.parts.map((p) => {
    // Geometry the reader could not establish is not presented as a cell geometry claim.
    const table = p.table && p.table.geometry !== 'unknown' ? { row: p.table.row, column: p.table.column, rowSpan: p.table.rowSpan, columnSpan: p.table.columnSpan } : null;
    if (p.table && p.table.geometry === 'unknown') pending.unresolved.push({ kind: 'table_geometry', ref: p.id, detail: 'geometry unknown in the result' });
    return { id: p.id, parentId: p.parentId, order: p.order, type: p.type, span: { ...p.span }, context: p.context, table };
  });

  // Compound carriers (NCM_RANGE / NCM_EXCEPTION) become relations, not entity occurrences.
  const entities = result.entities.filter((e) => !COMPOUND.has(e.domain)).map((e) => ({ id: e.id, domain: e.domain, span: { ...e.span } }));
  const byId = new Map(result.entities.map((e) => [e.id, e]));
  const relations: PredictedRelation[] = [];
  for (const c of result.entities) {
    if (!COMPOUND.has(c.domain)) continue;
    // A compound carrier must hold the relation of its own kind; anything else is reported, never silently dropped.
    const expected = c.domain === 'NCM_RANGE' ? 'range' : 'exception';
    if (!c.relation || c.relation.kind !== expected) {
      pending.unresolved.push({ kind: 'compound_relation', ref: c.id,
        detail: c.relation ? `${c.domain} carries relation kind "${c.relation.kind}", expected "${expected}"` : `${c.domain} has no relation` });
      continue;
    }
    const r = c.relation; const targets = [...r.targetEntityIds];
    for (const t of targets) {
      const target = byId.get(t);
      if (!target) pending.unresolved.push({ kind: 'relation_target', ref: c.id, detail: `target ${t} not in result` });
      // Compounds are not occurrences in the prediction, so a reference to one cannot be scored; it is reported.
      else if (COMPOUND.has(target.domain)) pending.unresolved.push({ kind: 'relation_target', ref: c.id, detail: `target ${t} is a compound ${target.domain}, not an occurrence` });
    }
    const operator = r.operator.trim();
    if (r.kind === 'range') {
      const first = byId.get(targets[0]!); const last = byId.get(targets[targets.length - 1]!);
      // The operator must sit, once, between the first and the last member; otherwise its span stays unknown.
      const hits = first && last ? occurrences(text, operator, first.span.end, last.span.start) : [];
      const operatorSpan: Span | null = hits.length === 1 ? { start: hits[0]!, end: hits[0]! + operator.length } : null;
      if (!operatorSpan) pending.unresolved.push({ kind: 'operator_span', ref: c.id, detail: `range operator "${operator}" not uniquely located` });
      relations.push({ kind: 'range', operatorSpan, memberEntityIds: targets, targetEntityIds: [], scopeSpan: { ...c.span }, condition: r.condition });
    } else if (r.kind === 'exception') {
      // The marker opens the compound span when the extractor anchored it there; otherwise it must occur once inside.
      const atStart = text.slice(c.span.start, c.span.start + operator.length) === operator;
      const hits = atStart ? [c.span.start] : occurrences(text, operator, c.span.start, c.span.end);
      const operatorSpan: Span | null = hits.length === 1 ? { start: hits[0]!, end: hits[0]! + operator.length } : null;
      if (!operatorSpan) pending.unresolved.push({ kind: 'operator_span', ref: c.id, detail: `exception operator "${operator}" not uniquely located` });
      relations.push({ kind: 'exception', operatorSpan, memberEntityIds: [], targetEntityIds: targets, scopeSpan: { ...c.span }, condition: r.condition });
    }
  }

  return { parts, entities, relations, selections: explicit.selections.map((s) => ({ purpose: s.purpose, positive: s.positive, span: s.span ? { ...s.span } : null })),
    coverage: { textLength: result.coverage.textLength, recognizedLength: result.coverage.recognizedLength }, pending };
}

/**
 * Explicit, opt-in mapping of the result's eligibility decisions to selections, one to one and unchanged
 * (`eligible` → `positive`). It is never called by the adapter; a caller must choose to use it.
 */
export function selectionsFromEligibility(result: AnatomyResult): PredictedSelection[] {
  return result.eligibility.map((s) => ({ purpose: s.purpose, positive: s.eligible, span: { ...s.span } }));
}
