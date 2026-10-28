import type { Pool, PoolClient } from 'pg';
import { assertCanonicalSubset, AdminError, withAdminTx } from '../admin/rules-admin.service.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../build-identity.js';
import { canonicalJson, sha256, type AnatomyResult } from '../contract.js';
import type { ProfileScope } from '../profile.js';
import { ExecutorError, type SimulationExecutor } from '../simulation-executor.js';
import { SAMPLE_ANNOTATIONS, type Nature } from './sample-annotations.js';
import { SYNTHETIC_SAMPLES, type SampleInput } from './sample-inputs.js';
import { applyChanges, ConfigValidationError, FIELD_CATALOG, scopePt, SHIPPED_PROFILES, suggestRules, validateConfiguration, type Change, type Scope } from './rules.js';
import { describeResult, diffDescribed, documentHash, NATURE_PT, type Correction, type Described } from './view.js';

/**
 * ANAT-CONFIG-01 (issue tribusca-control#116): accessible anatomy configuration. "Salvar configuração" validates and
 * applies in ONE administrative action (COORD decision 28/10/2026, replaces the 079 double approval for this flow).
 * Writes go only through the audited SQL entry points of 082; reads use RLS (platform admins only).
 */
export const OFFICIAL_SAMPLES: readonly SampleInput[] = Object.freeze([]); // pending: official sources not reachable (docs/anatomy/CONFIG-01.md)
export const ALL_SAMPLES: readonly SampleInput[] = Object.freeze([...OFFICIAL_SAMPLES, ...SYNTHETIC_SAMPLES]);
const SAMPLE = new Map(ALL_SAMPLES.map((s) => [s.id, s]));

export interface ActiveConfiguration { versionId: string | null; version: number; origin: 'saved' | 'shipped'; profiles: unknown[]; corrections: Correction[];
  kind?: string; author?: string; createdAt?: string; note?: string | null; profileSetHash: string }

/** The configuration in force. No saved version yet → the shipped defaults (version 0). */
export async function readActive(c: PoolClient): Promise<ActiveConfiguration> {
  const r = (await c.query(`SELECT v.id, v.version, v.kind, v.profiles, v.corrections, v.profile_set_hash AS hash, v.author, v.created_at AS "createdAt", v.note
    FROM anatomy_config_current k JOIN anatomy_config_versions v ON v.id = k.version_id WHERE k.singleton`)).rows[0];
  if (!r) { const profiles = SHIPPED_PROFILES(); return { versionId: null, version: 0, origin: 'shipped', profiles, corrections: [], profileSetHash: sha256(canonicalJson(profiles)) }; }
  return { versionId: r.id, version: r.version, origin: 'saved', profiles: r.profiles, corrections: r.corrections, kind: r.kind, author: r.author, createdAt: r.createdAt, note: r.note, profileSetHash: r.hash };
}

/**
 * THE shared analysis service (ANAT-CONFIG-01 R2). Every analysis of a document under a configuration goes through here:
 * the screen's before/after preview AND the persisted "nova análise" of one document. It runs the engine in the isolated
 * executor with the configuration's profiles, then applies the configuration's passage corrections on top of the engine
 * result (the engine result itself is never changed; both are returned).
 */
export async function configuredAnalysis(executor: SimulationExecutor, cfg: { profiles: unknown[]; corrections: Correction[] }, sample: SampleInput, signal: AbortSignal) {
  let run;
  try { run = await executor.analyze({ example: exampleOf(sample), profiles: cfg.profiles, expectedEngineHash: ANATOMY_ENGINE_BUILD_HASH }, signal); } catch (e) { throw fromExecutor(e); }
  if (run.status !== 'complete') throw new AdminError(run.reason === 'aborted' ? 499 : 503, run.reason === 'aborted' ? 'ABORTED' : 'SIMULATION_UNAVAILABLE');
  return { result: run.result, described: describeResult(sample, run.result, SAMPLE_ANNOTATIONS[sample.id] ?? [], cfg.corrections) };
}

/**
 * THE consumer: a new analysis of ONE document with the configuration in force (profiles + corrections), persisted with
 * the document version, the configuration version and the corrections applied or found stale. Earlier analyses are kept
 * (immutable rows). If the configuration changes while the analysis runs, nothing is recorded (STALE_VERSION).
 * No batch, collection or reprocessing exists or is triggered here.
 */
export async function analyzeWithActiveConfiguration(pool: Pool, executor: SimulationExecutor | null, userId: string, sampleId: string, corr: string, signal: AbortSignal) {
  if (!executor) throw new AdminError(503, 'SIMULATION_UNAVAILABLE');
  const sample = SAMPLE.get(sampleId); if (!sample) throw new AdminError(404, 'SAMPLE_NOT_FOUND');
  const active = await withAdminTx(pool, userId, readActive);
  const { result, described } = await configuredAnalysis(executor, active, sample, AbortSignal.any([signal, AbortSignal.timeout(executor.limits.totalMs)]));
  const summary = { status: described.status, counts: described.counts, passages: described.passages.map((p) => ({ key: p.key, structure: p.structure,
    engineNature: p.nature, effectiveNature: p.effectiveNature, corrected: !!p.correction })) };
  const applied = described.corrections.applied.map((a) => ({ partKey: a.partKey, expected: a.correction.expected, author: a.correction.author ?? null }));
  const stale = described.corrections.stale.map((x) => ({ partKey: x.correction.partKey, why: x.why }));
  assertCanonicalSubset(summary);
  const id = await withAdminTx(pool, userId, async (c) => (await c.query(
    'SELECT anat_config_record_analysis($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10) AS id',
    [active.version, sample.documentId, sample.version, described.documentHash, result.analysisId, result.outputHash, JSON.stringify(applied), JSON.stringify(stale),
      JSON.stringify(summary), corr])).rows[0].id as string);
  return { analysisRecordId: id, documentId: sample.documentId, documentVersion: sample.version, documentHash: described.documentHash,
    configVersion: active.version, configVersionId: active.versionId, engineAnalysisId: result.analysisId, ruleSetHash: result.identity.ruleSetHash,
    correctionsApplied: applied, correctionsStale: stale, described };
}
export async function listDocumentAnalyses(c: PoolClient, documentId: string) {
  return (await c.query(`SELECT a.id, a.document_id AS "documentId", a.document_version AS "documentVersion", a.document_hash AS "documentHash", a.config_version AS "configVersion",
    a.engine_analysis_id AS "engineAnalysisId", a.corrections_applied AS "correctionsApplied", a.corrections_stale AS "correctionsStale", a.summary, u.email AS "requestedByEmail",
    a.created_at AS "createdAt" FROM anatomy_config_analyses a LEFT JOIN app_users u ON u.id = a.requested_by WHERE a.document_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [documentId])).rows;
}

export async function listVersions(c: PoolClient) {
  return (await c.query(`SELECT v.id, v.version, v.kind, v.profile_set_hash AS "profileSetHash", v.note, v.author, u.email AS "authorEmail", v.created_at AS "createdAt",
    v.restored_from AS "restoredFrom", (SELECT r.version FROM anatomy_config_versions r WHERE r.id = v.restored_from) AS "restoredFromVersion",
    jsonb_array_length(v.corrections) AS "correctionCount", (k.version_id = v.id) AS current
    FROM anatomy_config_versions v LEFT JOIN anatomy_config_current k ON k.singleton LEFT JOIN app_users u ON u.id = v.author ORDER BY v.version DESC LIMIT 200`)).rows;
}
export async function readVersion(c: PoolClient, id: string) {
  const r = (await c.query('SELECT id, version, kind, profiles, corrections, note, created_at AS "createdAt" FROM anatomy_config_versions WHERE id = $1', [id])).rows[0];
  if (!r) throw new AdminError(404, 'VERSION_NOT_FOUND', id);
  return { ...r, rules: rulesView(r.profiles) };
}

/** The configuration as a list the administrator can read: one row per field and scope, with the literals in force. */
export function rulesView(profiles: unknown[]) {
  const rows: { scope: Scope; scopeLabel: string; path: string; title: string; help: string; literals: string[] }[] = [];
  for (const p of profiles as { scope: ProfileScope; fields: Record<string, Record<string, string[]>> }[]) {
    for (const f of FIELD_CATALOG) {
      const list = p.fields?.[f.group]?.[f.field];
      if (list) rows.push({ scope: p.scope as Scope, scopeLabel: scopePt(p.scope as Scope), path: f.path, title: f.title, help: f.help, literals: [...list] });
    }
  }
  return rows;
}

export function sampleSummaries() {
  return ALL_SAMPLES.map((s) => ({ id: s.id, documentId: s.documentId, version: s.version, documentHash: documentHash(s.content), title: s.title, source: s.source, family: s.family,
    format: s.format, provenance: s.provenance, covers: s.covers,
    annotated: (SAMPLE_ANNOTATIONS[s.id]?.length ?? 0) }));
}
const exampleOf = (s: SampleInput) => ({ id: s.id, purpose: s.title, polarity: 'positive', source: s.source, family: s.family,
  input: s.format === 'html' ? { html: s.content } : { text: s.content }, expect: [{ kind: 'part', type: 'document' }] });

function fromExecutor(e: unknown): AdminError {
  if (e instanceof ExecutorError) return new AdminError(e.code === 'QUEUE_FULL' || e.code === 'QUEUE_TIMEOUT' || e.code === 'CLOSED' ? 503 : e.code === 'ABORTED' ? 499 : 422,
    e.code === 'INVALID_INPUT' ? 'invalid_configuration' : e.code === 'ABORTED' ? 'ABORTED' : 'SIMULATION_UNAVAILABLE');
  throw e;
}

export interface AnalysisInput { sampleIds?: string[] | undefined; changes?: Change[] | undefined; corrections?: CorrectionInput[] | undefined }
/**
 * Runs the samples under the configuration in force (before) and the proposed one (after = in force + changes) in the
 * isolated executor. Counts are the engine's real output on these samples; nothing is persisted.
 */
export async function analyze(pool: Pool, executor: SimulationExecutor | null, userId: string, input: AnalysisInput, signal: AbortSignal) {
  if (!executor) throw new AdminError(503, 'SIMULATION_UNAVAILABLE');
  const active = await withAdminTx(pool, userId, readActive);
  const changes = input.changes ?? [];
  const proposed = changes.length ? applyChanges(active.profiles, changes) : active.profiles;
  const validation = validateConfiguration(proposed);
  const corrections = input.corrections ? prepareCorrections(active, input.corrections, userId) : active.corrections;
  const ids = input.sampleIds?.length ? input.sampleIds : ALL_SAMPLES.map((s) => s.id);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(executor.limits.totalMs)]);
  const samples = [];
  for (const id of ids) {
    const s = SAMPLE.get(id); if (!s) throw new AdminError(404, 'SAMPLE_NOT_FOUND', null);
    // Same service as the persisted analysis: "before" = configuration in force, "after" = the proposal.
    const before: Described = (await configuredAnalysis(executor, active, s, deadline)).described;
    const after: Described = (await configuredAnalysis(executor, { profiles: proposed, corrections }, s, deadline)).described;
    samples.push({ id, documentId: s.documentId, version: s.version, title: s.title, source: s.source, provenance: s.provenance, before, after, diff: diffDescribed(before, after) });
  }
  const totals = {
    samples: samples.length,
    passages: samples.reduce((n, s) => n + s.after.passages.length, 0),
    changedPassages: samples.reduce((n, s) => n + s.diff.changed.length, 0),
    samplesChanged: samples.filter((s) => s.diff.changed.length > 0).length,
    reviewBefore: samples.reduce((n, s) => n + s.before.review.length, 0),
    reviewAfter: samples.reduce((n, s) => n + s.after.review.length, 0),
  };
  return { basedOnVersion: active.version, changes: changes.length, effective: validation.effective, totals, samples };
}

export function suggestions(input: { sampleId: string; text: string; wanted: Nature }) {
  const s = SAMPLE.get(input.sampleId); if (!s) throw new AdminError(404, 'SAMPLE_NOT_FOUND');
  return { wantedLabel: NATURE_PT[input.wanted], ...suggestRules(s, input.text, input.wanted) };
}

const hashOf = (profiles: unknown) => sha256(canonicalJson(profiles));
/** Validate, then apply in one transaction (version + pointer + audit). A stale base or any failure keeps the version in force. */
export async function save(pool: Pool, userId: string, input: { basedOnVersion: number; changes: Change[]; corrections: CorrectionInput[]; note?: string | undefined }, corr: string) {
  const active = await withAdminTx(pool, userId, readActive);
  if (active.version !== input.basedOnVersion) throw new AdminError(409, 'STALE_VERSION');
  const profiles = input.changes.length ? applyChanges(active.profiles, input.changes) : active.profiles;
  validateConfiguration(profiles);
  const corrections = prepareCorrections(active, input.corrections, userId);
  if (!input.changes.length && canonicalJson(corrections) === canonicalJson(active.corrections)) throw new ConfigValidationError([{ message: 'Não há alterações para salvar.' }]);
  assertCanonicalSubset(profiles); assertCanonicalSubset(corrections);
  return withAdminTx(pool, userId, async (c) => (await c.query('SELECT version_id AS "versionId", version FROM anat_config_save($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
    [input.basedOnVersion, JSON.stringify(profiles), JSON.stringify(corrections), hashOf(profiles), input.note ?? null, corr])).rows[0] as { versionId: string; version: number });
}
/** Restore = a new version with an earlier version's content; re-validated against the current engine first. */
export async function restore(pool: Pool, userId: string, input: { basedOnVersion: number; versionId: string; note?: string | undefined }, corr: string) {
  const source = await withAdminTx(pool, userId, (c) => readVersion(c, input.versionId));
  validateConfiguration(source.profiles);
  return withAdminTx(pool, userId, async (c) => (await c.query('SELECT version_id AS "versionId", version FROM anat_config_restore($1,$2,$3,$4)',
    [input.basedOnVersion, input.versionId, input.note ?? null, corr])).rows[0] as { versionId: string; version: number });
}
export interface CorrectionInput { documentId: string; documentHash: string; partKey: string; expected: Nature; reason: string }
/**
 * Corrections the administrator keeps or adds. A correction already in the version in force is kept as it is (author,
 * date and version unchanged). A new one must point at a CURRENT version of a known document, carry a reason, and gets
 * the session user as author (never taken from the client). A correction never becomes a rule.
 */
export function prepareCorrections(active: ActiveConfiguration, input: readonly CorrectionInput[], userId: string): Correction[] {
  const issues: { message: string }[] = []; const seen = new Set<string>(); const out: Correction[] = [];
  const same = (a: CorrectionInput, b: Correction) => a.documentId === b.documentId && a.documentHash === b.documentHash && a.partKey === b.partKey && a.expected === b.expected && a.reason.trim() === b.reason;
  for (const c of input) {
    const id = `${c.documentId}|${c.documentHash}|${c.partKey}`;
    if (seen.has(id)) { issues.push({ message: 'Há duas correções para o mesmo trecho. Mantenha apenas uma.' }); continue; }
    seen.add(id);
    const kept = active.corrections.find((x) => same(c, x));
    if (kept) { out.push(kept); continue; }
    const reason = c.reason.trim();
    if (reason.length < 3) { issues.push({ message: 'Informe o motivo da correção (pelo menos 3 caracteres).' }); continue; }
    const versions = ALL_SAMPLES.filter((s) => s.documentId === c.documentId);
    if (!versions.length) { issues.push({ message: 'A correção aponta para um documento que não existe.' }); continue; }
    if (!versions.some((s) => documentHash(s.content) === c.documentHash)) { issues.push({ message: 'O documento mudou desde que a correção foi feita. Abra a versão atual e corrija de novo.' }); continue; }
    out.push({ documentId: c.documentId, documentHash: c.documentHash, partKey: c.partKey, expected: c.expected, reason, author: userId,
      createdAt: new Date().toISOString(), sinceVersion: active.version + 1 });
  }
  if (issues.length) throw new ConfigValidationError(issues);
  return out;
}
export async function auditConfigAttempt(pool: Pool, userId: string, operation: 'SAVE' | 'RESTORE', code: string, target: string | null, corr: string) {
  if (code !== 'STALE_VERSION' && code !== 'VERSION_NOT_FOUND') return false;
  try { await withAdminTx(pool, userId, (c) => c.query('SELECT anat_config_audit_attempt($1,$2,$3,$4)', [operation, code, target, corr])); return true; } catch { return false; }
}
/** Author e-mails for display (corrections and versions show who did what). */
export async function authorEmails(c: PoolClient, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = (await c.query('SELECT id::text AS id, email FROM app_users WHERE id = ANY($1::uuid[])', [[...new Set(ids)]])).rows as { id: string; email: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.email]));
}
export async function listConfigAudit(c: PoolClient) {
  return (await c.query(`SELECT a.id, a.action, a.entity_id AS "entityId", a.actor_id AS "actorId", u.email AS "actorEmail", a.data, a.correlation_id AS "correlationId", a.occurred_at AS "occurredAt"
    FROM public.anat_list_audit(500) a LEFT JOIN app_users u ON u.id::text = a.actor_id WHERE a.action LIKE 'ANAT\\_RULES\\_CONFIG\\_%' ORDER BY a.occurred_at DESC`)).rows;
}
export { ConfigValidationError };
