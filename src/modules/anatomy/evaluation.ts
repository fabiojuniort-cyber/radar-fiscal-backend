import type { AnatomyGold } from './gold.js';

/**
 * ANAT-04-EVAL-01 — pure evaluator for the measurement matrix (docs/anatomy/GOLD-COVERAGE.md).
 * Inputs are a gold and a prediction already in memory; nothing here reads files, runs the engine or
 * touches the corpus. `null` always means N/A and is never replaced by 0 or 1.
 */
export const EVALUATION_VERSION = 'ANAT-EVAL/1.0.0' as const;

type Span = { start: number; end: number };
export interface PredictedPart { id: string; parentId: string | null; type: string; span: Span; context: string; order: number;
  table?: { row: number; column: number; rowSpan: number; columnSpan: number } | null }
export interface PredictedEntity { id: string; domain: string; span: Span }
export interface PredictedRelation { kind: 'range' | 'exception'; operatorSpan: Span | null; memberEntityIds: string[]; targetEntityIds: string[]; scopeSpan: Span | null; condition: string | null }
export interface PredictedSelection { purpose: 'ncm' | 'thematic_text'; positive: boolean; /** null or invalid = unlocated (still counted in S1b). */ span: Span | null }
/** Items the prediction itself declares unresolved; carried for the report, never scored as hits. */
export interface PredictionPending {
  status: 'complete' | 'partial' | 'failed';
  limitations: { code: string; partId: string | null; span: Span | null }[];
  unidentifiedSegments: Span[];
  missingResources: string[];
  unresolved: { kind: 'operator_span' | 'table_geometry' | 'relation_target'; ref: string; detail: string }[];
}
export interface Prediction { parts: PredictedPart[]; entities: PredictedEntity[]; relations: PredictedRelation[]; selections: PredictedSelection[];
  /** Engine-reported coverage for the descriptive C1 only; never used as proven annotation coverage. */
  coverage?: { textLength: number; recognizedLength: number };
  pending?: PredictionPending }

/** P/R/F1 with the decision table: P is N/A without predictions; R is N/A without gold; zero hits with both → 0/0/0. */
export interface Prf { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }
export interface Ratio { numerator: number; denominator: number; value: number | null }
export const NA = { status: 'N/A' as const };
export type NotApplicable = typeof NA & { reason: string };

export function prf(tp: number, predicted: number, gold: number): Prf {
  const precision = predicted === 0 ? null : tp / predicted;
  const recall = gold === 0 ? null : tp / gold;
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp: predicted - tp, fn: gold - tp, precision, recall, f1 };
}
export const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, value: denominator === 0 ? null : numerator / denominator });

/** One-to-one matching: equal keys pair in order of occurrence; a duplicated prediction never yields a second hit. */
export function matchOneToOne<G, P>(gold: G[], predicted: P[], goldKey: (g: G) => string, predKey: (p: P) => string): { pairs: [G, P][]; unmatchedGold: G[]; unmatchedPred: P[] } {
  // Track predictions by index so equal values (or identical objects) are never conflated.
  const queue = new Map<string, number[]>();
  predicted.forEach((p, i) => { const k = predKey(p); queue.set(k, [...(queue.get(k) ?? []), i]); });
  const pairs: [G, P][] = []; const unmatchedGold: G[] = []; const used = new Set<number>();
  for (const g of gold) {
    const i = queue.get(goldKey(g))?.shift();
    if (i === undefined) unmatchedGold.push(g); else { used.add(i); pairs.push([g, predicted[i]!]); }
  }
  return { pairs, unmatchedGold, unmatchedPred: predicted.filter((_, i) => !used.has(i)) };
}

const sk = (s: Span | null | undefined) => (s ? `${s.start}:${s.end}` : '-');
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const digits = (literal: string) => literal.replace(/\D/g, '').length;
const CODE = new Set(['NCM', 'NBM']);
const NON_CODE = new Set(['CITATION', 'OTHER', 'PROCESS', 'CNPJ']);

/** Gold code spans that must never receive a positive `ncm` selection (S1), and the structural candidates. */
export function goldCodeRoles(gold: AnatomyGold): { nonCandidates: Span[]; candidates: Span[] } {
  const parts = new Map(gold.parts.map((p) => [p.id, p]));
  const range = new Set(gold.relations.filter((r) => r.kind === 'range').flatMap((r) => r.memberEntityIds));
  const exception = new Set(gold.relations.filter((r) => r.kind === 'exception').flatMap((r) => r.targetEntityIds));
  const nonCandidates: Span[] = []; const candidates: Span[] = [];
  for (const e of gold.entities) {
    if (!CODE.has(e.domain)) continue;
    const candidate = e.domain === 'NCM' && parts.get(e.partId)?.context === 'operative_candidate' && digits(e.literal) !== 2 && !range.has(e.id) && !exception.has(e.id);
    (candidate ? candidates : nonCandidates).push(e.span);
  }
  return { nonCandidates, candidates };
}

/**
 * S1b classes of positive `ncm` emissions (exhaustive; their sum equals `emitted`):
 * - exactCandidate: span equals a structural candidate (not a violation of exclusion);
 * - onNonCandidate: touches a gold non-candidate code (proven violation);
 * - inexactOnCandidate: touches a candidate without its exact span (proven violation: the gold fixes the code span);
 * - outsideGoldCodes: touches no gold code and lies entirely inside a region PROVEN to be fully annotated
 *   (`options.annotationCoverage`, given in memory apart from the gold) — proven violation, e.g. an invented positive;
 * - pendingCoverage: touches no gold code and coverage of that text is not proven — pending, never a violation;
 * - inGap: touches no gold code and lies in a declared gap or unidentified part (unverifiable, not proven);
 * - unlocated: no valid span inside the text (unverifiable, reported).
 */
export interface S1Classes { exactCandidate: number; onNonCandidate: number; inexactOnCandidate: number; outsideGoldCodes: number; pendingCoverage: number; inGap: number; unlocated: number }
export interface S1b { emitted: number; violations: number; unverifiable: number; classes: S1Classes }
const s1b = (emitted: number, c: S1Classes): S1b => ({ emitted, violations: c.onNonCandidate + c.inexactOnCandidate + c.outsideGoldCodes,
  unverifiable: c.pendingCoverage + c.inGap + c.unlocated, classes: c });

/**
 * Evaluation options kept OUT of the gold: approved golds are never edited to carry them.
 * `annotationCoverage` lists canonical-text regions proven to be fully annotated for nomenclature codes; without it,
 * an emission over text with no gold code is pending, not a violation.
 */
export interface EvaluationOptions { annotationCoverage?: Span[] }

export interface EntryEvaluation {
  version: typeof EVALUATION_VERSION; id: string; source: string;
  E1: Prf; E2: Ratio; E3: Ratio; E4: Ratio & { confusion: Record<string, number> }; E5: Prf;
  R1: Prf; R2: Prf; R3: Ratio; R4: Prf; R5: Ratio; R6: Prf;
  M1: Prf; M2a: Prf; M2b: Ratio; M2c: NotApplicable; M2: NotApplicable;
  S1a: Ratio; S1b: S1b; S2: NotApplicable;
  C1: Ratio | NotApplicable;
}

export function evaluateEntry(id: string, source: string, gold: AnatomyGold, pred: Prediction, options: EvaluationOptions = {}): EntryEvaluation {
  // E1 — parts, root excluded.
  const gParts = gold.parts.filter((p) => p.type !== 'document'); const pParts = pred.parts.filter((p) => p.type !== 'document');
  const partKey = (p: { type: string; span: Span }) => `${p.type}|${sk(p.span)}`;
  const m1 = matchOneToOne(gParts, pParts, partKey, partKey);
  const pairOf = new Map(m1.pairs.map(([g, p]) => [g.id, p]));
  // E2 — parent of a matched part is the pair of its gold parent (when that parent is not the root and was matched).
  const rootIds = new Set(gold.parts.filter((p) => p.type === 'document').map((p) => p.id));
  let e2n = 0; let e2d = 0;
  for (const [g, p] of m1.pairs) {
    if (g.parentId === null || rootIds.has(g.parentId)) continue;
    const parentPair = pairOf.get(g.parentId); if (!parentPair) continue;
    e2d++; if (p.parentId === parentPair.id) e2n++;
  }
  // E3 — EVERY pair of matched gold siblings (n·(n−1)/2 per parent, in gold order) must keep its relative order under
  // the same predicted parent. All pairs, not only neighbours, so partial inversions and omissions are both counted.
  const siblings = new Map<string | null, typeof gParts>();
  for (const g of gParts) siblings.set(g.parentId, [...(siblings.get(g.parentId) ?? []), g]);
  let e3n = 0; let e3d = 0;
  for (const list of siblings.values()) {
    const matched = [...list].sort((a, b) => a.order - b.order).map((g) => pairOf.get(g.id)).filter((p): p is PredictedPart => p !== undefined);
    for (let i = 0; i < matched.length; i++) {
      for (let j = i + 1; j < matched.length; j++) {
        const a = matched[i]!; const b = matched[j]!;
        e3d++; if (a.parentId === b.parentId && a.order < b.order) e3n++;
      }
    }
  }
  // E4 — context over matched parts, with confusion counts gold→pred.
  const confusion: Record<string, number> = {}; let e4n = 0;
  for (const [g, p] of m1.pairs) { const k = `${g.context}->${p.context}`; confusion[k] = (confusion[k] ?? 0) + 1; if (g.context === p.context) e4n++; }
  // E5 — cells with extended geometry key.
  const cellKey = (c: { span: Span; table?: { row: number; column: number; rowSpan: number; columnSpan: number } | null }) =>
    `${sk(c.span)}|${c.table ? `${c.table.row},${c.table.column},${c.table.rowSpan},${c.table.columnSpan}` : '-'}`;
  const gCells = gParts.filter((p) => p.type === 'cell'); const pCells = pParts.filter((p) => p.type === 'cell');
  const e5 = matchOneToOne(gCells, pCells, cellKey, cellKey);
  // R — entities by class, one to one on domain + span.
  const entKey = (e: { domain: string; span: Span }) => `${e.domain}|${sk(e.span)}`;
  // A two-character code span is a chapter reference (informative class R4), kept out of R1/R2.
  const isChapterG = (e: AnatomyGold['entities'][number]) => CODE.has(e.domain) && digits(e.literal) === 2;
  const isChapterP = (e: PredictedEntity) => CODE.has(e.domain) && e.span.end - e.span.start === 2;
  const byClass = (gf: (e: AnatomyGold['entities'][number]) => boolean, pf: (e: PredictedEntity) => boolean) => {
    const g = gold.entities.filter(gf); const p = pred.entities.filter(pf);
    return prf(matchOneToOne(g, p, entKey, entKey).pairs.length, p.length, g.length);
  };
  const R1 = byClass((e) => e.domain === 'NCM' && !isChapterG(e), (e) => e.domain === 'NCM' && !isChapterP(e));
  const R2 = byClass((e) => e.domain === 'NBM' && !isChapterG(e), (e) => e.domain === 'NBM' && !isChapterP(e));
  const R4 = prf(matchOneToOne(gold.entities.filter(isChapterG), pred.entities.filter(isChapterP), (e) => sk(e.span), (e) => sk(e.span)).pairs.length,
    pred.entities.filter(isChapterP).length, gold.entities.filter(isChapterG).length);
  const R6 = byClass((e) => e.domain === 'CITATION', (e) => e.domain === 'CITATION');
  // R3 — NCM×NBM confusion among codes matched by span only.
  const r3 = matchOneToOne(gold.entities.filter((e) => CODE.has(e.domain)), pred.entities.filter((e) => CODE.has(e.domain)), (e) => sk(e.span), (e) => sk(e.span));
  const R3 = ratio(r3.pairs.filter(([g, p]) => g.domain !== p.domain).length, r3.pairs.length);
  // R5 — gold non-code spans hit by any predicted NCM (each span counted once).
  const nonCode = gold.entities.filter((e) => NON_CODE.has(e.domain)); const predNcm = pred.entities.filter((e) => e.domain === 'NCM');
  const R5 = ratio(nonCode.filter((g) => predNcm.some((p) => overlaps(g.span, p.span))).length, nonCode.length);
  // M1/M2 — relations keyed by operator span and the DOMAIN + span of each member/target, so a relation whose ends
  // carry the wrong nomenclature (NCM↔NBM) is not a hit. An unresolved id gets a key that can never match.
  const ref = (e: { domain: string; span: Span }) => `${e.domain}@${sk(e.span)}`;
  const gEnt = new Map(gold.entities.map((e) => [e.id, ref(e)])); const pEnt = new Map(pred.entities.map((e) => [e.id, ref(e)]));
  // Range: operator + both ends in order. Exception: operator + the SET of targets (order-free).
  const relKey = (refs: Map<string, string>, side: 'g' | 'p') => (r: { operatorSpan: Span | null; memberEntityIds: string[]; targetEntityIds: string[]; kind: string }) => {
    const ends = (r.kind === 'range' ? r.memberEntityIds : r.targetEntityIds).map((i) => refs.get(i) ?? `unresolved:${side}:${i}`);
    if (r.kind !== 'range') return `${r.kind}|${sk(r.operatorSpan)}|${[...new Set(ends)].sort().join(',')}`; // targets are a set: repeats collapse
    return `${r.kind}|${sk(r.operatorSpan)}|${ends.join(',')}`;
  };
  const gRanges = gold.relations.filter((r) => r.kind === 'range'); const pRanges = pred.relations.filter((r) => r.kind === 'range');
  const M1 = prf(matchOneToOne(gRanges, pRanges, relKey(gEnt, 'g'), relKey(pEnt, 'p')).pairs.length, pRanges.length, gRanges.length);
  const gExc = gold.relations.filter((r) => r.kind === 'exception'); const pExc = pred.relations.filter((r) => r.kind === 'exception');
  const m2 = matchOneToOne(gExc, pExc, relKey(gEnt, 'g'), relKey(pEnt, 'p'));
  const M2a = prf(m2.pairs.length, pExc.length, gExc.length);
  const M2b = ratio(m2.pairs.filter(([g, p]) => sk(g.scopeSpan) === sk(p.scopeSpan)).length, m2.pairs.length);
  // S1 — denominator from the gold, independent of matching. Every positive `ncm` emission falls in exactly one class,
  // so none can disappear; only classes the gold can prove count as violations.
  const roles = goldCodeRoles(gold);
  const positives = pred.selections.filter((s) => s.purpose === 'ncm' && s.positive);
  const validSpan = (s: Span | null | undefined): s is Span => !!s && Number.isInteger(s.start) && Number.isInteger(s.end)
    && s.start >= 0 && s.start < s.end && s.end <= gold.canonicalTextUtf16Length;
  const located = positives.map((s) => s.span).filter(validSpan);
  const S1a = ratio(roles.nonCandidates.filter((n) => located.some((s) => overlaps(n, s))).length, roles.nonCandidates.length);
  // Regions the gold does not vouch for: declared gaps with a span and parts annotated as unidentified.
  const unverifiedRegions = [...gold.gaps.flatMap((g) => (g.span ? [g.span] : [])), ...gold.parts.filter((p) => p.type === 'unidentified').map((p) => p.span)];
  const classes: S1Classes = { exactCandidate: 0, onNonCandidate: 0, inexactOnCandidate: 0, outsideGoldCodes: 0, pendingCoverage: 0, inGap: 0, unlocated: 0 };
  const proven = (options.annotationCoverage ?? []).filter(validSpan);
  const insideProven = (s: Span) => proven.some((r) => r.start <= s.start && s.end <= r.end);
  for (const s of positives) {
    const span = s.span;
    if (!validSpan(span)) classes.unlocated++;
    else if (roles.nonCandidates.some((n) => overlaps(n, span))) classes.onNonCandidate++;
    else if (roles.candidates.some((c) => c.start === span.start && c.end === span.end)) classes.exactCandidate++;
    else if (roles.candidates.some((c) => overlaps(c, span))) classes.inexactOnCandidate++;
    else if (unverifiedRegions.some((r) => overlaps(r, span))) classes.inGap++;
    else if (insideProven(span)) classes.outsideGoldCodes++;
    else classes.pendingCoverage++;
  }
  const C1 = pred.coverage ? ratio(pred.coverage.recognizedLength, pred.coverage.textLength) : { ...NA, reason: 'prediction carries no coverage' };
  return { version: EVALUATION_VERSION, id, source,
    E1: prf(m1.pairs.length, pParts.length, gParts.length), E2: ratio(e2n, e2d), E3: ratio(e3n, e3d), E4: { ...ratio(e4n, m1.pairs.length), confusion },
    E5: prf(e5.pairs.length, pCells.length, gCells.length), R1, R2, R3, R4, R5, R6, M1, M2a, M2b,
    M2c: { ...NA, reason: 'gold condition null does not prove absence of a condition (not annotated in this stage)' },
    M2: { ...NA, reason: 'complete exception depends on M2c' },
    S1a, S1b: s1b(positives.length, classes),
    S2: { ...NA, reason: 'positive selection requires approved legal evidence (ANAT-06)' }, C1 };
}

/** Aggregate per source (or overall): P/R/F1 recomputed from summed counts and ratios from summed parts, never averaged. */
export function aggregate(entries: EntryEvaluation[]): Record<string, Pick<EntryEvaluation, 'E1' | 'E5' | 'R1' | 'R2' | 'R4' | 'R6' | 'M1' | 'M2a'> & Record<'E2' | 'E3' | 'E4' | 'R3' | 'R5' | 'M2b' | 'S1a', Ratio> & { S1b: EntryEvaluation['S1b']; entries: string[] }> {
  const groups = new Map<string, EntryEvaluation[]>();
  for (const e of entries) { groups.set(e.source, [...(groups.get(e.source) ?? []), e]); groups.set('ALL', [...(groups.get('ALL') ?? []), e]); }
  const out: ReturnType<typeof aggregate> = {};
  for (const [key, list] of groups) {
    const sumPrf = (k: 'E1' | 'E5' | 'R1' | 'R2' | 'R4' | 'R6' | 'M1' | 'M2a') => {
      const tp = list.reduce((a, e) => a + e[k].tp, 0); const pr = list.reduce((a, e) => a + e[k].tp + e[k].fp, 0); const g = list.reduce((a, e) => a + e[k].tp + e[k].fn, 0);
      return prf(tp, pr, g);
    };
    const sumRatio = (k: 'E2' | 'E3' | 'E4' | 'R3' | 'R5' | 'M2b' | 'S1a') => ratio(list.reduce((a, e) => a + e[k].numerator, 0), list.reduce((a, e) => a + e[k].denominator, 0));
    out[key] = { E1: sumPrf('E1'), E5: sumPrf('E5'), R1: sumPrf('R1'), R2: sumPrf('R2'), R4: sumPrf('R4'), R6: sumPrf('R6'), M1: sumPrf('M1'), M2a: sumPrf('M2a'),
      E2: sumRatio('E2'), E3: sumRatio('E3'), E4: sumRatio('E4'), R3: sumRatio('R3'), R5: sumRatio('R5'), M2b: sumRatio('M2b'), S1a: sumRatio('S1a'),
      S1b: s1b(list.reduce((a, e) => a + e.S1b.emitted, 0), (Object.keys(list[0]!.S1b.classes) as (keyof S1Classes)[])
        .reduce((acc, k) => ({ ...acc, [k]: list.reduce((a, e) => a + e.S1b.classes[k], 0) }), {} as S1Classes)),
      entries: list.map((e) => e.id) };
  }
  return out;
}
