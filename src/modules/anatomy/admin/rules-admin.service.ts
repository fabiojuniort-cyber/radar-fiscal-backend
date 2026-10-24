import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ANATOMY_ENGINE_BUILD_HASH } from '../build-identity.js';
import { canonicalJson } from '../contract.js';
import { DEFAULT_PROFILES, PROFILE_SOURCES, ProfileValidationError, resolveEffectiveProfile } from '../profile.js';
import { parseExample, RESERVED_ENTRY_IDS, SIMULATION_LIMITS } from '../rules-simulation.js';
import { EXECUTOR_LIMITS, ExecutorError, type SimulationExecutor } from '../simulation-executor.js';

/**
 * ANAT-ADMIN-01 P3-D (issue #116): administrative service over the P3-B1 persistence (SQL entry points only — never
 * direct DML) and the P3-C executor. The session user always comes from authentication; `app.user_id` is set with
 * `set_config(..., true)` inside each transaction, so it never outlives the transaction or leaks through the pool.
 */
export const ATTEMPT_CODES = ['STALE_REVISION', 'AUTHOR_CANNOT_REVIEW', 'REVIEW_INCOMPLETE', 'SIMULATION_NOT_PASSING', 'COMPARISON_MISMATCH',
  'PREVIEW_EXPIRED', 'PREVIEW_CONSUMED', 'PREVIEW_STALE', 'ENGINE_MISMATCH', 'SIMULATION_UNAVAILABLE', 'LIMIT_EXCEEDED'] as const;
export type AttemptCode = (typeof ATTEMPT_CODES)[number];
export type Operation = 'DRAFT_SAVE' | 'FREEZE' | 'SIMULATE' | 'COMPARE' | 'REVIEW' | 'PREVIEW' | 'CONFIRM';

/** Sanitised failure: a code and an HTTP status only (no SQL text, example content, token or secret). */
export class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, readonly targetId: string | null = null) { super(code); this.name = 'AdminError'; }
  get attempt(): AttemptCode | null { return (ATTEMPT_CODES as readonly string[]).includes(this.code) ? (this.code as AttemptCode) : null; }
}
const NOT_FOUND = new Set(['DRAFT_NOT_FOUND', 'CANDIDATE_NOT_FOUND', 'REVIEW_NOT_FOUND', 'SIMULATION_NOT_FOUND']);
const VALIDATION = new Set(['INVALID_PROFILE', 'INVALID_EXAMPLE', 'RESERVED_EXAMPLE_ID', 'DUPLICATE_EXAMPLE_ID', 'CANONICAL_KEY_UNSUPPORTED', 'CANONICAL_NUMBER_UNSUPPORTED', 'HASH_MISMATCH']);

/** Maps a database error to a sanitised AdminError. Unknown errors become a generic 500 (the cause is not echoed). */
export function mapDbError(error: unknown, targetId: string | null = null): AdminError {
  if (error instanceof AdminError) return error;
  const e = error as { message?: string; code?: string };
  const message = typeof e?.message === 'string' ? e.message : '';
  const anat = /^anat:([A-Z_]+)/u.exec(message)?.[1];
  if (anat) {
    if (anat === 'PLATFORM_ADMIN_REQUIRED' || anat === 'ACTOR_REQUIRED' || anat === 'ACTOR_MISMATCH') return new AdminError(403, 'platform_admin_required', targetId);
    if (NOT_FOUND.has(anat)) return new AdminError(404, anat, targetId);
    if (VALIDATION.has(anat)) return new AdminError(422, anat, targetId);
    return new AdminError(409, anat, targetId);
  }
  // The audit trail is part of every mutation: if it cannot be written, nothing was written.
  if (/audit_log|audit_/u.test(message) && (e.code === '42501' || e.code === '23514')) return new AdminError(503, 'audit_unavailable', targetId);
  if (e.code === '23503') return new AdminError(409, 'REVIEW_INCOMPLETE', targetId); // FK: link to another candidate/review
  if (e.code === '23505') return new AdminError(409, 'REVIEW_INCOMPLETE', targetId); // duplicate decision/link
  if (e.code === '22P02') return new AdminError(422, 'invalid_identifier', targetId);
  return new AdminError(500, 'internal_error', targetId);
}

export async function withAdminTx<T>(pool: Pool, userId: string, fn: (c: PoolClient) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation === 'SERIALIZABLE' ? 'SERIALIZABLE' : 'READ COMMITTED'}`);
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Separate transaction after the rollback (P3 §0.2). A failure here is swallowed: the original error is returned. */
export async function auditAttempt(pool: Pool, userId: string, operation: Operation, error: AdminError, correlationId: string): Promise<boolean> {
  const code = error.attempt; if (!code) return false;
  try {
    await withAdminTx(pool, userId, (c) => c.query('SELECT anat_audit_attempt($1,$2,$3,$4)', [operation, code, error.targetId, correlationId]));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical subset (accepted in B1): refuse BEFORE persisting what the database canonicaliser cannot reproduce.
// Never rounds or normalises.
// ---------------------------------------------------------------------------------------------------------------
export function assertCanonicalSubset(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdminError(422, 'CANONICAL_NUMBER_UNSUPPORTED');
    if (Number.isInteger(value)) { if (!Number.isSafeInteger(value)) throw new AdminError(422, 'CANONICAL_NUMBER_UNSUPPORTED'); return; }
    const text = String(value); const abs = Math.abs(value);
    if (abs < 1e-6 || abs >= 1e21 || /e/iu.test(text) || text.replace(/[^0-9]/gu, '').replace(/^0+/u, '').length > 15) {
      throw new AdminError(422, 'CANONICAL_NUMBER_UNSUPPORTED');
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertCanonicalSubset(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      // Code units >= U+D800 cover surrogates (supplementary code points) and U+E000..U+FFFF.
      for (let i = 0; i < k.length; i++) if (k.charCodeAt(i) >= 0xd800) throw new AdminError(422, 'CANONICAL_KEY_UNSUPPORTED');
      assertCanonicalSubset(v, `${path}.${k}`);
    }
    return;
  }
  throw new AdminError(422, 'CANONICAL_NUMBER_UNSUPPORTED');
}

// ---------------------------------------------------------------------------------------------------------------
// Reads (RLS: platform admins only) and derived states
// ---------------------------------------------------------------------------------------------------------------
const CANDIDATE_STATE = `CASE
  WHEN EXISTS (SELECT 1 FROM anatomy_rule_activations a WHERE a.candidate_id = c.id AND a.superseded_at IS NULL) THEN 'active'
  WHEN EXISTS (SELECT 1 FROM anatomy_rule_activations a WHERE a.candidate_id = c.id) THEN 'superseded'
  WHEN EXISTS (SELECT 1 FROM anatomy_rule_reviews r WHERE r.candidate_id = c.id AND r.outcome = 'approved') THEN 'approved'
  WHEN EXISTS (SELECT 1 FROM anatomy_rule_reviews r WHERE r.candidate_id = c.id) THEN 'rejected'
  WHEN EXISTS (SELECT 1 FROM anatomy_rule_simulations s WHERE s.candidate_id = c.id) THEN 'simulated'
  ELSE 'frozen' END`;

export interface CandidateRow { id: string; ruleSetId: string; ruleHash: string; exampleSetId: string; exampleSetHash: string; engineHash: string;
  createdBy: string; draftId: string; draftRevision: number; draftAuthor: string; state: string; createdAt: string; profiles?: unknown[]; examples?: unknown[] }

export async function listDrafts(c: PoolClient) {
  return (await c.query(`SELECT id, author, revision, updated_at AS "updatedAt", profiles, examples FROM anatomy_rule_drafts ORDER BY updated_at DESC LIMIT 200`)).rows;
}
export async function readDraft(c: PoolClient, id: string) {
  const r = (await c.query(`SELECT id, author, revision, updated_at AS "updatedAt", profiles, examples FROM anatomy_rule_drafts WHERE id = $1`, [id])).rows[0];
  if (!r) throw new AdminError(404, 'DRAFT_NOT_FOUND', id);
  return r;
}
export async function listCandidates(c: PoolClient, withContent = false, id: string | null = null): Promise<CandidateRow[]> {
  const rows = (await c.query(`SELECT c.id, c.rule_set_id AS "ruleSetId", c.rule_hash AS "ruleHash", c.example_set_id AS "exampleSetId",
    e.example_set_hash AS "exampleSetHash", c.engine_hash AS "engineHash", c.created_by AS "createdBy", c.draft_id AS "draftId",
    c.draft_revision AS "draftRevision", c.draft_author AS "draftAuthor", ${CANDIDATE_STATE} AS state, c.created_at AS "createdAt"
    ${withContent ? ', s.profiles, e.examples' : ''}
    FROM anatomy_rule_candidates c JOIN anatomy_rule_example_sets e ON e.id = c.example_set_id
    JOIN anatomy_rule_sets s ON s.id = c.rule_set_id AND s.rule_hash = c.rule_hash
    WHERE ($1::uuid IS NULL OR c.id = $1) ORDER BY c.created_at DESC LIMIT 200`, [id])).rows as CandidateRow[];
  return rows;
}
export async function readCandidate(c: PoolClient, id: string): Promise<Required<CandidateRow>> {
  const row = (await listCandidates(c, true, id))[0];
  if (!row) throw new AdminError(404, 'CANDIDATE_NOT_FOUND', id);
  return row as Required<CandidateRow>;
}
export async function candidateDetail(c: PoolClient, id: string) {
  const candidate = await readCandidate(c, id);
  const simulations = (await c.query(`SELECT s.id, s.status, s.pass_count AS "passCount", s.fail_count AS "failCount", s.partial_count AS "partialCount",
    s.cancelled_count AS "cancelledCount", s.inconclusive_count AS "inconclusiveCount", s.report_hash AS "reportHash", s.requested_by AS "requestedBy", s.created_at AS "createdAt",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('exampleId', x.example_id, 'outcome', x.outcome, 'outputHash', x.output_hash, 'analysisId', x.analysis_id) ORDER BY x.example_id)
      FROM anatomy_rule_simulation_examples x WHERE x.simulation_id = s.id), '[]') AS rows
    FROM anatomy_rule_simulations s WHERE s.candidate_id = $1 ORDER BY s.created_at DESC`, [id])).rows;
  const comparisons = (await c.query(`SELECT k.id, k.example_id AS "exampleId", k.comparison_hash AS "comparisonHash", k.baseline_rule_set_id AS "baselineRuleSetId",
    k.baseline_rule_hash AS "baselineRuleHash", k.created_at AS "createdAt", e.envelope FROM anatomy_rule_comparisons k
    JOIN anatomy_rule_comparison_envelopes e USING (comparison_hash) WHERE k.candidate_id = $1 ORDER BY k.created_at DESC`, [id])).rows;
  const reviews = (await c.query(`SELECT r.id, r.simulation_id AS "simulationId", r.reviewer, r.outcome, r.rationale, r.created_at AS "createdAt",
    COALESCE((SELECT jsonb_agg(rc.comparison_id) FROM anatomy_rule_review_comparisons rc WHERE rc.review_id = r.id), '[]') AS "comparisonIds",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('comparisonId', d.comparison_id, 'differenceId', d.difference_id, 'decision', d.decision, 'note', d.note))
      FROM anatomy_rule_review_decisions d WHERE d.review_id = r.id), '[]') AS decisions
    FROM anatomy_rule_reviews r WHERE r.candidate_id = $1 ORDER BY r.created_at DESC`, [id])).rows;
  return { candidate, simulations, comparisons, reviews };
}
export async function listActivations(c: PoolClient) {
  return (await c.query(`SELECT id, scope, candidate_id AS "candidateId", review_id AS "reviewId", kind, previous_activation_id AS "previousActivationId",
    preview_id AS "previewId", affected_scope AS "affectedScope", actor, justification, activated_at AS "activatedAt", superseded_at AS "supersededAt"
    FROM anatomy_rule_activations ORDER BY activated_at DESC LIMIT 200`)).rows;
}
export async function listAudit(c: PoolClient) {
  return (await c.query(`SELECT id, action, entity_id AS "entityId", actor_id AS "actorId", after_data AS data, correlation_id AS "correlationId", occurred_at AS "occurredAt"
    FROM audit_log WHERE tenant_id IS NULL AND entity_type = 'anatomy_rules' ORDER BY occurred_at DESC LIMIT 500`)).rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations (SQL entry points only)
// ---------------------------------------------------------------------------------------------------------------
/**
 * D-R1-01: full P1/P2 validation BEFORE anything is persisted (drafts and freeze): examples against the strict P2
 * schema (limits, reserved IDs, unique IDs), profiles as ANAT-PROFILE/1 (size, schema, protection floor) for every
 * source and for every example's source/family target. Refusals are 422 codes only, never the offending content.
 * D-R2-01: the size limits are the executor's own (EXECUTOR_LIMITS), so a saved or frozen draft is never one the
 * executor refuses; the catalog limit is checked here as well as in the executor.
 */
export function assertDraftContent(profiles: unknown, examples: unknown): void {
  if (!Array.isArray(examples) || examples.length < 1 || examples.length > SIMULATION_LIMITS.maxExamples) throw new AdminError(422, 'LIMIT_EXCEEDED');
  const ids = new Set<string>();
  const targets: { source: string; family: string | null }[] = PROFILE_SOURCES.map((source) => ({ source, family: null }));
  for (const raw of examples) {
    const id = (raw as { id?: unknown })?.id;
    if (typeof id === 'string' && (RESERVED_ENTRY_IDS as readonly string[]).includes(id)) throw new AdminError(422, 'RESERVED_EXAMPLE_ID');
    let e;
    try { e = parseExample(raw); } catch { throw new AdminError(422, 'INVALID_EXAMPLE'); }
    if (ids.has(e.id)) throw new AdminError(422, 'DUPLICATE_EXAMPLE_ID');
    if ((e.catalog?.codes.length ?? 0) > EXECUTOR_LIMITS.maxCatalogCodes) throw new AdminError(422, 'LIMIT_EXCEEDED');
    ids.add(e.id); targets.push({ source: e.source, family: e.family });
  }
  if (!Array.isArray(profiles) || profiles.length === 0) throw new AdminError(422, 'INVALID_PROFILE');
  let bytes: number;
  try { bytes = Buffer.byteLength(canonicalJson(profiles), 'utf8'); } catch { throw new AdminError(422, 'INVALID_PROFILE'); }
  if (bytes > EXECUTOR_LIMITS.maxProfilesBytes) throw new AdminError(422, 'LIMIT_EXCEEDED');
  for (const target of targets) {
    try { resolveEffectiveProfile(structuredClone(profiles), target); } catch (error) {
      if (error instanceof ProfileValidationError) throw new AdminError(422, 'INVALID_PROFILE');
      throw error;
    }
  }
}

export async function saveDraft(c: PoolClient, input: { id: string | null; revision: number | null; profiles: unknown[]; examples: unknown[] }, corr: string) {
  assertCanonicalSubset(input.profiles); assertCanonicalSubset(input.examples);
  assertDraftContent(input.profiles, input.examples);
  const r = (await c.query('SELECT draft_id AS id, revision FROM anat_save_draft($1,$2,$3::jsonb,$4::jsonb,$5)',
    [input.id, input.revision, JSON.stringify(input.profiles), JSON.stringify(input.examples), corr])).rows[0];
  return r as { id: string; revision: number };
}
export async function freeze(c: PoolClient, draftId: string, revision: number, corr: string) {
  // A draft saved before this validation existed (or written by any other path) is re-validated before freezing.
  const draft = (await c.query('SELECT profiles, examples FROM anatomy_rule_drafts WHERE id = $1', [draftId])).rows[0];
  if (draft) { assertCanonicalSubset(draft.profiles); assertCanonicalSubset(draft.examples); assertDraftContent(draft.profiles, draft.examples); }
  return (await c.query('SELECT candidate_id AS "candidateId", created FROM anat_freeze($1,$2,$3,$4)', [draftId, revision, ANATOMY_ENGINE_BUILD_HASH, corr])).rows[0] as { candidateId: string; created: boolean };
}

const fromExecutor = (error: unknown, target: string | null): AdminError => {
  if (error instanceof ExecutorError) {
    if (error.code === 'QUEUE_FULL' || error.code === 'QUEUE_TIMEOUT') return new AdminError(429, error.code, target);
    if (error.code === 'ENGINE_MISMATCH') return new AdminError(409, 'ENGINE_MISMATCH', target);
    if (error.code === 'LIMIT_EXCEEDED') return new AdminError(409, 'LIMIT_EXCEEDED', target);
    if (error.code === 'CLOSED') return new AdminError(503, 'SIMULATION_UNAVAILABLE', target);
    if (error.code === 'ABORTED') return new AdminError(499, 'ABORTED', target);
    return new AdminError(422, 'invalid_input', target);
  }
  return mapDbError(error, target);
};

export async function simulate(pool: Pool, executor: SimulationExecutor | null, userId: string, candidateId: string, corr: string, signal: AbortSignal) {
  if (!executor) throw new AdminError(503, 'SIMULATION_UNAVAILABLE', candidateId);
  const cand = await withAdminTx(pool, userId, (c) => readCandidate(c, candidateId));
  let run;
  try { run = await executor.simulate({ profiles: cand.profiles, examples: cand.examples, expectedEngineHash: cand.engineHash }, signal); } catch (e) { throw fromExecutor(e, candidateId); }
  assertCanonicalSubset(run.report);
  const rows = run.rows.map((r) => ({ exampleId: r.exampleId, outcome: r.outcome, engineHash: r.engineHash, inputTextHash: r.inputTextHash,
    outputHash: r.outputHash, analysisId: r.analysisId, ruleSetHash: r.ruleSetHash }));
  const id = await withAdminTx(pool, userId, async (c) => (await c.query('SELECT anat_record_simulation($1,$2,$3::jsonb,$4::jsonb,$5) AS id',
    [candidateId, run.status, JSON.stringify(run.report), JSON.stringify(rows), corr])).rows[0].id as string);
  return { simulationId: id, status: run.status, rows: run.rows };
}

/** Baseline: the declared snapshot, else the active candidate's snapshot for the scope. */
async function baselineFor(c: PoolClient, scope: string, declared: string | null) {
  const row = declared
    ? (await c.query('SELECT id, rule_hash AS hash, profiles FROM anatomy_rule_sets WHERE id = $1', [declared])).rows[0]
    : (await c.query(`SELECT s.id, s.rule_hash AS hash, s.profiles FROM anatomy_rule_activations a JOIN anatomy_rule_candidates k ON k.id = a.candidate_id
        JOIN anatomy_rule_sets s ON s.id = k.rule_set_id AND s.rule_hash = k.rule_hash WHERE a.scope = $1 AND a.superseded_at IS NULL`, [scope])).rows[0];
  if (!row) throw new AdminError(422, 'baseline_required');
  return row as { id: string; hash: string; profiles: unknown[] };
}

export async function compare(pool: Pool, executor: SimulationExecutor | null, userId: string, candidateId: string,
  input: { scope: string; baselineRuleSetId: string | null }, corr: string, signal: AbortSignal) {
  if (!executor) throw new AdminError(503, 'SIMULATION_UNAVAILABLE', candidateId);
  const { cand, base } = await withAdminTx(pool, userId, async (c) => ({ cand: await readCandidate(c, candidateId), base: await baselineFor(c, input.scope, input.baselineRuleSetId) }));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(executor.limits.totalMs)]);
  const out: { exampleId: string; comparisonId: string; comparisonHash: string; differenceCount: number }[] = [];
  for (const example of cand.examples as { id: string }[]) {
    let run;
    try { run = await executor.compare({ example, before: base.profiles, after: cand.profiles, expectedEngineHash: cand.engineHash }, deadline); } catch (e) { throw fromExecutor(e, candidateId); }
    if (run.status !== 'complete') throw new AdminError(run.reason === 'aborted' ? 499 : 409, run.reason === 'aborted' ? 'ABORTED' : 'SIMULATION_UNAVAILABLE', candidateId);
    assertCanonicalSubset(run.comparison);
    const r = await withAdminTx(pool, userId, async (c) => (await c.query('SELECT comparison_id AS id FROM anat_record_comparison($1,$2,$3,$4,$5::jsonb,$6)',
      [candidateId, example.id, base.id, base.hash, JSON.stringify(run.comparison), corr])).rows[0].id as string);
    out.push({ exampleId: example.id, comparisonId: r, comparisonHash: run.comparison.id, differenceCount: run.comparison.differences.length });
  }
  return { baselineRuleSetId: base.id, baselineRuleHash: base.hash, comparisons: out };
}

export async function review(c: PoolClient, candidateId: string, input: { simulationId: string; outcome: 'approved' | 'rejected'; rationale: string;
  comparisonIds: string[]; decisions: { comparisonId: string; differenceId: string; decision: string; note?: string | undefined }[] }, corr: string) {
  return (await c.query('SELECT anat_record_review($1,$2,$3,$4,$5::uuid[],$6::jsonb,$7) AS id', [candidateId, input.simulationId, input.outcome, input.rationale,
    input.comparisonIds, JSON.stringify(input.decisions.map((d) => ({ ...d, note: d.note ?? '' }))), corr])).rows[0].id as string;
}

/**
 * Affected scope (P3 §4): per source and per family that has its own profile, compare the EFFECTIVE profile hash of the
 * current rules (active candidate, else the shipped defaults) with the candidate's. Counts are never invented: this
 * schema has no publication source/family metadata and publication_anatomies has no effective_profile_hash, so both
 * counts are declared unsupported.
 */
export function affectedScope(current: unknown[], candidate: unknown[], currentLabel: string) {
  const families = new Set<string>();
  for (const p of [...current, ...candidate] as { scope?: { level?: string; source?: string; family?: string } }[]) {
    if (p?.scope?.level === 'family' && p.scope.source && p.scope.family) families.add(`${p.scope.source}|${p.scope.family}`);
  }
  const targets: { source: string; family: string | null }[] = [...PROFILE_SOURCES.map((source) => ({ source, family: null })),
    ...[...families].sort().map((k) => ({ source: k.split('|')[0]!, family: k.split('|')[1]! }))];
  const targetsOut = targets.map((t) => {
    const before = resolveEffectiveProfile(structuredClone(current), t).effectiveHash;
    const after = resolveEffectiveProfile(structuredClone(candidate), t).effectiveHash;
    return { source: t.source, family: t.family, changed: before !== after, beforeEffectiveHash: before, afterEffectiveHash: after };
  });
  return { basis: currentLabel, targets: targetsOut,
    publications: { status: 'unsupported', reason: 'publication source/family metadata is not available to this module' },
    analyses: { status: 'unsupported', reason: 'publication_anatomies has no effective_profile_hash/family column (M_ANAT_BASE)' },
    unknownFamily: 'publications without family metadata cannot be attributed to a family profile',
    reprocessing: 'none: activation never reprocesses publications' };
}

export async function preview(c: PoolClient, input: { action: 'activate' | 'rollback'; candidateId: string; reviewId: string; scope: string }, corr: string) {
  // D-R1-02: serialise with confirm (same advisory key as anat_confirm) BEFORE reading the active rule, so the rule the
  // affected scope is computed from is the one anat_preview records as observed; the link is re-checked below.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('anat-activation:' || $1, 0))", [input.scope]);
  const cand = await readCandidate(c, input.candidateId);
  const active = (await c.query(`SELECT a.id, s.profiles FROM anatomy_rule_activations a JOIN anatomy_rule_candidates k ON k.id = a.candidate_id
    JOIN anatomy_rule_sets s ON s.id = k.rule_set_id AND s.rule_hash = k.rule_hash WHERE a.scope = $1 AND a.superseded_at IS NULL`, [input.scope])).rows[0];
  const scope = affectedScope(active ? active.profiles : structuredClone([...DEFAULT_PROFILES]), cand.profiles, active ? 'active_candidate' : 'shipped_defaults');
  // Random token; only its SHA-256 reaches the database; the raw value is returned once and never logged.
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const r = (await c.query('SELECT preview_id AS "previewId", intent_hash AS "intentHash", expires_at AS "expiresAt" FROM anat_preview($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    [input.action, input.candidateId, input.reviewId, input.scope, ANATOMY_ENGINE_BUILD_HASH, tokenHash, JSON.stringify(scope), corr])).rows[0];
  const observed = (await c.query('SELECT observed_activation_id AS id FROM anatomy_rule_activation_previews WHERE id = $1', [r.previewId])).rows[0]?.id ?? null;
  if (observed !== (active?.id ?? null)) throw new AdminError(409, 'PREVIEW_STALE'); // never persist a scope computed on another rule
  return { ...r, token, affectedScope: scope } as { previewId: string; intentHash: string; expiresAt: string; token: string; affectedScope: ReturnType<typeof affectedScope> };
}

/** SERIALIZABLE confirm with up to 3 attempts; each attempt re-reads the preview (replay returns the same activation). */
export async function confirm(pool: Pool, userId: string, input: { token: string; intentHash: string; justification: string }, corr: string) {
  const tokenHash = createHash('sha256').update(input.token, 'utf8').digest('hex');
  for (let attempt = 1; ; attempt++) {
    try {
      return await withAdminTx(pool, userId, async (c) => (await c.query('SELECT activation_id AS "activationId", replayed FROM anat_confirm($1,$2,$3,$4,$5)',
        [tokenHash, input.intentHash, ANATOMY_ENGINE_BUILD_HASH, input.justification, corr])).rows[0] as { activationId: string; replayed: boolean }, 'SERIALIZABLE');
    } catch (error) {
      if ((error as { code?: string }).code === '40001' && attempt < 3) continue;
      throw error;
    }
  }
}

export const canonicalOf = canonicalJson;
