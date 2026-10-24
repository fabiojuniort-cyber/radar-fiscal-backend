import { z } from 'zod';
import { ANATOMY_ENGINE_BUILD_HASH } from './build-identity.js';
import { anatomyIdentityHash, anatomyOutputHash, canonicalJson, sha256, validateAnatomyResult, type AnatomyResult } from './contract.js';
import { analyzeAnatomy, type AnatomyRequest } from './engine.js';
import { ProfileValidationError, resolveEffectiveProfile } from './profile.js';

/**
 * ANAT-ADMIN-01 / P2 (issue #116) — pure, in-memory services the rules administration screen will call:
 * simulation of a candidate profile on explicit SYNTHETIC examples, comparison of two engine results for the same
 * input snapshot, and review of the differences. No persistence, HTTP, activation or corpus access: inputs are only
 * the HTML/text written in each example. Engine protections, golds and measurement criteria are untouched; nothing
 * here can grant a positive selection (any eligible entry is a hard failure).
 */
export const SIMULATION_LIMITS = Object.freeze({ maxExamples: 20, maxMillisPerExample: 2000, maxInputUtf16: 256 * 1024 });
/** Reserved (holdout) corpus IDs: never accepted as example IDs, so a reserve entry cannot be named into a simulation. */
export const RESERVED_ENTRY_IDS = Object.freeze(['04', '06', '08', '09', '12', '14', '16', '18', '24', '28']);
const SOURCES = ['CONFAZ', 'DOU', 'DOE-SP', 'RFB'] as const;

const matcher = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('part'), type: z.string().min(1), context: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('entity'), domain: z.string().min(1), literal: z.string().min(1).optional(), relation: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('limitation'), code: z.string().min(1) }),
]);
export type ExpectationMatcher = z.infer<typeof matcher>;
const example = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/u).refine((id) => !RESERVED_ENTRY_IDS.includes(id), { message: 'reserved corpus entry IDs are not accepted' }),
  purpose: z.string().min(1).max(256),
  polarity: z.enum(['positive', 'negative']),
  source: z.enum(SOURCES),
  family: z.string().min(1).max(64).nullable().default(null),
  input: z.strictObject({ html: z.string().max(SIMULATION_LIMITS.maxInputUtf16).optional(), text: z.string().max(SIMULATION_LIMITS.maxInputUtf16).optional() })
    .refine((i) => (i.html === undefined) !== (i.text === undefined), { message: 'exactly one of html or text' }),
  /** positive: every matcher must be present; negative: every matcher must be absent. */
  expect: z.array(matcher).min(1).max(64),
  catalog: z.strictObject({ edition: z.string().min(1), codes: z.array(z.string().regex(/^\d{4,8}$/)) }).optional(),
});
export type SimulationExample = z.input<typeof example>;
const simulationInput = z.strictObject({ profiles: z.array(z.unknown()).min(1), examples: z.array(example).min(1).max(SIMULATION_LIMITS.maxExamples) })
  .refine((s) => new Set(s.examples.map((e) => e.id)).size === s.examples.length, { message: 'duplicate example id' });

export class SimulationError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_profile' | 'positive_selection', message: string, readonly cause?: unknown) {
    super(`${code}: ${message}`); this.name = 'SimulationError';
  }
}

export interface ExampleOutcome {
  id: string; polarity: 'positive' | 'negative'; source: string; family: string | null;
  /**
   * `inconclusive` (P3 §2.5, ANAT-ADMIN-01 P3-C): the expectations held, but the engine result is not `complete`
   * (containment/extraction limits), so an absence or presence may only reflect suspended extraction. It counts as `pass`
   * only when the example is positive and declares EVERY limitation of the result with a `{ kind: 'limitation' }` matcher.
   */
  status: 'pass' | 'fail' | 'partial' | 'inconclusive';
  checks: { matcher: ExpectationMatcher; found: boolean; ok: boolean }[];
  /** Identity of what produced the result. */
  ruleSetHash: string; effectiveProfileHash: string; outputHash: string; resultStatus: AnatomyResult['status'];
  /** What was executed (persisted per example by the admin schema to bind comparisons to this run). */
  analysisId: string; inputTextHash: string;
  limitations: string[]; positiveSelections: 0; timedOut: boolean;
}
export interface SimulationReport { engineHash: string; profileSetHash: string; outcomes: ExampleOutcome[]; summary: { pass: number; fail: number; partial: number; inconclusive: number } }

const FIXED = { referenceDate: '2000-01-01', ruleSet: { id: 'simulation', version: '1' } } as const;
export type ParsedExample = z.output<typeof example>;
/** Strict P2 example validation (reserved IDs, limits); used by the isolated executor for every message. */
export function parseExample(raw: unknown): ParsedExample {
  const e = example.safeParse(raw);
  if (!e.success) throw new SimulationError('invalid_input', e.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return e.data;
}
export function requestFor(e: ParsedExample, profiles: unknown[]): AnatomyRequest {
  return { publicationVersionId: `simulation:${e.id}`, referenceDate: FIXED.referenceDate, ruleSet: { ...FIXED.ruleSet },
    input: { source: e.source, representationId: `simulation://${e.id}`, ...(e.input.html !== undefined ? { html: e.input.html } : { text: e.input.text! }) },
    ...(e.catalog ? { catalog: structuredClone(e.catalog) } : {}), profiles: structuredClone(profiles), family: e.family };
}
const matches = (r: AnatomyResult, m: ExpectationMatcher): boolean => {
  if (m.kind === 'part') return r.parts.some((p) => p.type === m.type && (m.context === undefined || p.context === m.context));
  if (m.kind === 'limitation') return r.limitations.some((l) => l.code === m.code);
  return r.entities.some((e) => e.domain === m.domain && (m.literal === undefined || e.literal === m.literal)
    && (m.relation === undefined || e.relation?.kind === m.relation));
};

/**
 * Runs the candidate profile set on each example, sequentially and independently (fresh request, cloned profiles).
 * An invalid profile set rejects the whole simulation (fail closed). An example over the time budget is `partial`.
 */
export function simulateProfiles(raw: { profiles: unknown[]; examples: SimulationExample[] }, clock: () => number = () => performance.now()): SimulationReport {
  const parsed = simulationInput.safeParse(raw);
  if (!parsed.success) throw new SimulationError('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { profiles, examples } = parsed.data;
  // Validate every target up front, so a broken profile never yields a partial report.
  for (const e of examples) {
    try { resolveEffectiveProfile(structuredClone(profiles), { source: e.source, family: e.family }); } catch (error) {
      if (error instanceof ProfileValidationError) throw new SimulationError('invalid_profile', `${e.id}: ${error.message}`, error);
      throw error;
    }
  }
  const outcomes = examples.map((e): ExampleOutcome => {
    const started = clock();
    const result = analyzeAnatomy(requestFor(e, profiles));
    return evaluateExample(e, profiles, result, clock() - started > SIMULATION_LIMITS.maxMillisPerExample);
  });
  const count = (s: ExampleOutcome['status']) => outcomes.filter((o) => o.status === s).length;
  return { engineHash: ANATOMY_ENGINE_BUILD_HASH, profileSetHash: sha256(canonicalJson(profiles)), outcomes,
    summary: { pass: count('pass'), fail: count('fail'), partial: count('partial'), inconclusive: count('inconclusive') } };
}

/** Outcome of one example from its (already valid) engine result; pure, shared by the in-process and isolated paths. */
export function evaluateExample(e: ParsedExample, profiles: unknown[], result: AnatomyResult, timedOut: boolean): ExampleOutcome {
  if (result.eligibility.some((x) => x.eligible)) throw new SimulationError('positive_selection', `${e.id}: a positive selection was produced without legal evidence`);
  const checks = e.expect.map((m) => { const found = matches(result, m); return { matcher: m, found, ok: e.polarity === 'positive' ? found : !found }; });
  const effective = resolveEffectiveProfile(structuredClone(profiles), { source: e.source, family: e.family });
  const limitations = result.limitations.map((l) => l.code);
  const declared = new Set(e.polarity === 'positive' ? e.expect.flatMap((m) => (m.kind === 'limitation' ? [m.code] : [])) : []);
  const held = checks.every((c) => c.ok);
  const status: ExampleOutcome['status'] = timedOut ? 'partial' : !held ? 'fail'
    : result.status === 'complete' || (limitations.length > 0 && limitations.every((code) => declared.has(code))) ? 'pass' : 'inconclusive';
  return { id: e.id, polarity: e.polarity, source: e.source, family: e.family, status, checks,
    ruleSetHash: result.identity.ruleSetHash, effectiveProfileHash: effective.effectiveHash, outputHash: result.outputHash, resultStatus: result.status,
    analysisId: result.analysisId, inputTextHash: result.identity.inputTextHash, limitations, positiveSelections: 0, timedOut };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison of two results for the SAME input snapshot (identity fields excluded from the content diff).

export type DiffCategory = 'part' | 'entity' | 'relation' | 'limitation' | 'eligibility';
export interface Difference { id: string; category: DiffCategory; key: string; change: 'added' | 'removed' | 'changed'; before: unknown; after: unknown }
/** Profile-set provenance; null when the caller compares two results without profile sets (compareResults). */
export interface ComparisonProvenance { beforeProfileSetHash: string | null; afterProfileSetHash: string | null }
export interface Comparison {
  /** SHA-256 of the canonical envelope: every other field below, provenance included (review P2-R1-01). */
  id: string;
  snapshot: { inputTextHash: string; inputPresentationHash: string | null };
  before: { engineHash: string; ruleSetHash: string; outputHash: string; analysisId: string; status: string };
  after: { engineHash: string; ruleSetHash: string; outputHash: string; analysisId: string; status: string };
  provenance: ComparisonProvenance;
  differences: Difference[];
  /** Informational only: occurrence counts per category; a count change never decides a regression. */
  counts: Record<DiffCategory, { before: number; after: number }>;
}
const ENVELOPE_KEYS = ['id', 'snapshot', 'before', 'after', 'provenance', 'differences', 'counts'] as const;
const envelopeId = (c: Omit<Comparison, 'id'>) => sha256(canonicalJson({ snapshot: c.snapshot, before: c.before, after: c.after,
  provenance: c.provenance, differences: c.differences, counts: c.counts }));

const spanKey = (s: { start: number; end: number } | null) => (s ? `${s.start}-${s.end}` : 'null');
/** Items per category as MULTISETS (key → values): occurrences sharing a content key are never collapsed (P2-R1-02). */
function itemsOf(r: AnatomyResult): Record<DiffCategory, Map<string, unknown[]>> {
  const partKey = new Map(r.parts.map((p) => [p.id, `${p.type}@${spanKey(p.span)}`]));
  const entityKey = new Map(r.entities.map((e) => [e.id, `${e.domain}@${spanKey(e.span)}`]));
  const out: Record<DiffCategory, Map<string, unknown[]>> = { part: new Map(), entity: new Map(), relation: new Map(), limitation: new Map(), eligibility: new Map() };
  const add = (c: DiffCategory, key: string, value: unknown) => { const list = out[c].get(key) ?? []; list.push(value); out[c].set(key, list); };
  for (const p of r.parts) add('part', partKey.get(p.id)!, { label: p.label, context: p.context, contextReasons: p.contextReasons, recognition: p.recognition,
    coverage: p.coverage, ruleId: p.ruleId, legalStatus: p.legalStatus, parent: p.parentId === null ? null : partKey.get(p.parentId) ?? null, table: p.table });
  for (const e of r.entities) {
    add('entity', entityKey.get(e.id)!, { literal: e.literal, normalized: e.normalized, part: partKey.get(e.partId) ?? null, ruleId: e.ruleId,
      confidence: e.confidence, validation: e.validation });
    if (e.relation) add('relation', entityKey.get(e.id)!, { kind: e.relation.kind, operator: e.relation.operator, condition: e.relation.condition,
      group: entityKey.get(e.relation.groupId) ?? e.relation.groupId, targets: e.relation.targetEntityIds.map((t) => entityKey.get(t) ?? t).sort(),
      scope: partKey.get(e.relation.scopePartId) ?? null, expansion: e.relation.expansion });
  }
  for (const l of r.limitations) add('limitation', `${l.code}@${spanKey(l.span)}@${l.partId === null ? 'null' : partKey.get(l.partId) ?? l.partId}`, { message: l.message });
  for (const x of r.eligibility) add('eligibility', `${x.purpose}@${spanKey(x.span)}@${x.entityId ? entityKey.get(x.entityId) : x.partId ? partKey.get(x.partId) : 'null'}`,
    { eligible: x.eligible, exclusionReasons: [...x.exclusionReasons].sort(), evidenceIds: x.evidenceIds });
  return out;
}

/** Valid, untampered contract result: schema/cross-references, outputHash and analysisId recomputed (P2-R1-03). */
export function assertValidResult(r: AnatomyResult, side: string): AnatomyResult {
  let valid: AnatomyResult;
  try { valid = validateAnatomyResult(r); } catch (error) {
    throw new SimulationError('invalid_input', `${side} result violates the contract: ${error instanceof Error ? error.message.slice(0, 300) : 'invalid'}`, error);
  }
  if (anatomyOutputHash(valid) !== valid.outputHash) throw new SimulationError('invalid_input', `${side} result outputHash does not match its content`);
  if (anatomyIdentityHash(valid.identity) !== valid.analysisId) throw new SimulationError('invalid_input', `${side} result analysisId does not match its identity`);
  return valid;
}

/**
 * Deterministic content diff of two valid results computed from the same input snapshot. Occurrences with the same
 * content key are matched one to one: identical values first, then the remaining ones in canonical order as
 * `changed`, and any surplus as `added`/`removed`. Order of occurrences in the inputs does not matter.
 */
export function compareResults(beforeRaw: AnatomyResult, afterRaw: AnatomyResult, provenance: ComparisonProvenance = { beforeProfileSetHash: null, afterProfileSetHash: null }): Comparison {
  const before = assertValidResult(beforeRaw, 'before'); const after = assertValidResult(afterRaw, 'after');
  for (const h of [provenance.beforeProfileSetHash, provenance.afterProfileSetHash]) {
    if (h !== null && !/^[0-9a-f]{64}$/u.test(h)) throw new SimulationError('invalid_input', 'profile set hashes must be SHA-256 hex or null');
  }
  if (before.identity.inputTextHash !== after.identity.inputTextHash || before.identity.inputPresentationHash !== after.identity.inputPresentationHash) {
    throw new SimulationError('invalid_input', 'results come from different input snapshots');
  }
  const a = itemsOf(before); const b = itemsOf(after);
  const differences: Difference[] = [];
  const categories: DiffCategory[] = ['part', 'entity', 'relation', 'limitation', 'eligibility'];
  for (const category of categories) {
    for (const key of [...new Set([...a[category].keys(), ...b[category].keys()])].sort()) {
      const left = (a[category].get(key) ?? []).map((v) => canonicalJson(v)).sort();
      const right = (b[category].get(key) ?? []).map((v) => canonicalJson(v)).sort();
      // Remove identical occurrences pairwise (multiset intersection).
      const remaining = [...right];
      const unmatchedLeft: string[] = [];
      for (const v of left) { const i = remaining.indexOf(v); if (i >= 0) remaining.splice(i, 1); else unmatchedLeft.push(v); }
      const n = Math.max(unmatchedLeft.length, remaining.length);
      for (let i = 0; i < n; i++) {
        const x = unmatchedLeft[i]; const y = remaining[i];
        const change = x === undefined ? 'added' : y === undefined ? 'removed' : 'changed';
        const occurrenceKey = `${key}#${i + 1}`;
        const before = x === undefined ? null : JSON.parse(x); const after = y === undefined ? null : JSON.parse(y);
        differences.push({ id: sha256(canonicalJson({ category, key: occurrenceKey, change, before, after })).slice(0, 32), category, key: occurrenceKey, change, before, after });
      }
    }
  }
  const head = (r: AnatomyResult) => ({ engineHash: r.identity.engineHash, ruleSetHash: r.identity.ruleSetHash, outputHash: r.outputHash, analysisId: r.analysisId, status: r.status });
  const size = (m: Map<string, unknown[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
  const counts = Object.fromEntries(categories.map((c) => [c, { before: size(a[c]), after: size(b[c]) }])) as Comparison['counts'];
  const body = { snapshot: { inputTextHash: before.identity.inputTextHash, inputPresentationHash: before.identity.inputPresentationHash },
    before: head(before), after: head(after), provenance: { ...provenance }, differences, counts };
  return { id: envelopeId(body), ...body };
}

/** Runs one synthetic example under two profile sets and compares the results; profile-set hashes are inside the id. */
export function compareProfiles(raw: { example: SimulationExample; before: unknown[]; after: unknown[] }): Comparison {
  const e = example.safeParse(raw.example);
  if (!e.success) throw new SimulationError('invalid_input', e.error.issues.map((i) => i.message).join('; '));
  const run = (profiles: unknown[]) => {
    try { return analyzeAnatomy(requestFor(e.data, profiles)); } catch (error) {
      if (error instanceof ProfileValidationError) throw new SimulationError('invalid_profile', error.message, error);
      throw error;
    }
  };
  return compareResults(run(raw.before), run(raw.after),
    { beforeProfileSetHash: sha256(canonicalJson(raw.before)), afterProfileSetHash: sha256(canonicalJson(raw.after)) });
}

// ---------------------------------------------------------------------------------------------------------------
// Review of differences: every difference is explicitly classified; nothing is inferred from counts.

export type DiffDecision = 'expected' | 'regression' | 'not_evaluated';
export interface Review {
  comparisonId: string;
  decisions: { differenceId: string; decision: DiffDecision; note: string }[];
  verdict: 'clear' | 'blocked' | 'incomplete';
  totals: Record<DiffDecision, number>;
}
const decisionInput = z.array(z.strictObject({ differenceId: z.string().min(1), decision: z.enum(['expected', 'regression', 'not_evaluated']), note: z.string().max(2000).default('') }));

/**
 * Binds decisions to one comparison. Unknown or duplicated difference IDs are refused. Unclassified differences are
 * `not_evaluated`. Verdict: any regression → blocked; else any not_evaluated → incomplete; else clear.
 * The verdict depends only on these explicit decisions, never on how many items were added or removed.
 */
export function reviewDifferences(comparison: Comparison, rawDecisions: unknown): Review {
  // The review binds to the whole envelope: no unknown fields, and the id must equal the hash of every other field.
  const keys = Object.keys(comparison).sort();
  if (keys.join() !== [...ENVELOPE_KEYS].sort().join()) throw new SimulationError('invalid_input', `comparison has unexpected fields: ${keys.join(', ')}`);
  const { id, ...body } = comparison;
  if (envelopeId(body) !== id) throw new SimulationError('invalid_input', 'comparison content does not match its id');
  const parsed = decisionInput.safeParse(rawDecisions);
  if (!parsed.success) throw new SimulationError('invalid_input', parsed.error.issues.map((i) => i.message).join('; '));
  const known = new Set(comparison.differences.map((d) => d.id));
  const given = new Map<string, { decision: DiffDecision; note: string }>();
  for (const d of parsed.data) {
    if (!known.has(d.differenceId)) throw new SimulationError('invalid_input', `unknown difference ${d.differenceId} for comparison ${comparison.id}`);
    if (given.has(d.differenceId)) throw new SimulationError('invalid_input', `duplicate decision for ${d.differenceId}`);
    given.set(d.differenceId, { decision: d.decision, note: d.note });
  }
  const decisions = comparison.differences.map((d) => ({ differenceId: d.id, ...(given.get(d.id) ?? { decision: 'not_evaluated' as const, note: '' }) }));
  const totals = { expected: 0, regression: 0, not_evaluated: 0 } as Record<DiffDecision, number>;
  for (const d of decisions) totals[d.decision]++;
  return { comparisonId: comparison.id, decisions, verdict: totals.regression ? 'blocked' : totals.not_evaluated ? 'incomplete' : 'clear', totals };
}

