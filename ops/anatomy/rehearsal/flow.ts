/**
 * ANAT-ADMIN-01 operational rehearsal (issue tribusca-control#116): drives the COMPILED API (dist, approved SHA) running
 * in an isolated container, over real HTTP, with synthetic platform admins. Needs the rehearsal-only values:
 *   RH_API (e.g. http://127.0.0.1:53000), RH_ADMIN_URL (rehearsal database, superuser), RH_JWT (rehearsal JWT secret).
 * Refuses to run unless RH_ADMIN_URL points to 127.0.0.1:55432/radar_rehearsal (the disposable rehearsal database).
 * Usage: node --import tsx ops/anatomy/rehearsal/flow.ts off|full
 *   off  : flag off  -> ANAT routes 404 for an admin, the rest of the API works.
 *   full : flag on   -> rejection, approval, preview, confirm, replay, second activation and rollback; audit read.
 * Prints one JSON line with every step's status.
 */
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION } from '../../../src/modules/anatomy/profile.js';

const API = process.env.RH_API ?? ''; const ADMIN_URL = process.env.RH_ADMIN_URL ?? ''; const SECRET = process.env.RH_JWT ?? '';
const target = new URL(ADMIN_URL || 'postgresql://invalid');
if (target.hostname !== '127.0.0.1' || target.port !== '55432' || target.pathname !== '/radar_rehearsal' || !API.startsWith('http://127.0.0.1:') || SECRET.length < 32) {
  throw new Error('rehearsal environment only (127.0.0.1:55432/radar_rehearsal, local API, rehearsal secret)');
}
const mode = process.argv[2] ?? 'full';
const db = new pg.Client({ connectionString: ADMIN_URL }); await db.connect();
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (sub: string, sid: string) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, sid, typ: 'access', iat: now, exp: now + 900 })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};
async function user(admin: boolean): Promise<string> {
  const id = randomUUID(); const sid = randomUUID();
  await db.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [id, `${id}@rehearsal.invalid`]);
  if (admin) await db.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', $2)", [id, randomUUID()]);
  await db.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours')", [sid, id]);
  return sign(id, sid);
}
const P = '/api/v1/admin/anatomy-rules';
const steps: Record<string, unknown> = {};
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
function expect(name: string, ok: boolean, detail: unknown) { steps[name] = ok ? 'PASS' : { FAIL: detail }; if (!ok) process.exitCode = 1; }

const A = await user(true); const R = await user(true); const N = await user(false);
if (mode === 'off') {
  const anat = await call(A, 'GET', `${P}/drafts`);
  expect('flag off: ANAT route 404 for an admin', anat.status === 404, anat);
  const me = await call(A, 'GET', '/api/v1/admin/me');
  expect('flag off: existing admin route 200', me.status === 200, me);
  const health = await call(null, 'GET', '/health');
  expect('flag off: health 200', health.status === 200 && health.body.database === 'up', health);
} else {
  const defaults = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
  const rfbHeaders = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { ncm: { columnHeaders: string[] } }).ncm.columnHeaders;
  const variant = (header: string) => [...defaults().filter((p) => !((p as { scope: { level: string; source?: string } }).scope.level === 'source'
    && (p as { scope: { source?: string } }).scope.source === 'RFB')), { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' },
    fields: { ncm: { columnHeaders: [...rfbHeaders, header] } } }];
  const table = (header: string) => ({ id: 'col', purpose: `coluna NCM chamada ${header}`, polarity: 'positive', source: 'RFB',
    input: { html: `<table><tr><td>${header}</td></tr><tr><td>8471.30.12</td></tr></table>` },
    expect: [{ kind: 'entity', domain: 'NCM', literal: '8471.30.12' }], catalog: { edition: 'syn', codes: ['84713012'] } });
  const article = { id: 'art', purpose: 'artigo', polarity: 'positive', source: 'DOU', input: { html: '<p>Art. 1º NCM 8471.41.00.</p>' }, expect: [{ kind: 'part', type: 'article' }] };

  expect('auth: no token 401', (await call(null, 'GET', `${P}/drafts`)).status === 401, null);
  expect('auth: non-admin 403', (await call(N, 'GET', `${P}/drafts`)).status === 403, null);
  const base = await call(A, 'POST', `${P}/drafts`, { profiles: defaults(), examples: [table('Classificacao'), article] });
  const baseFrozen = await call(A, 'POST', `${P}/drafts/${base.body.id}/freeze`, { revision: 1 });
  const baselineId = (await call(A, 'GET', `${P}/candidates/${baseFrozen.body.candidateId}`)).body.candidate.ruleSetId as string;

  /** Draft → freeze → simulate → compare; returns what a review needs. */
  async function prepare(label: string, header: string) {
    const d = await call(A, 'POST', `${P}/drafts`, { profiles: variant(header), examples: [table(header), article] });
    const f = await call(A, 'POST', `${P}/drafts/${d.body.id}/freeze`, { revision: 1 });
    if (d.status !== 201 || f.status >= 300) throw new Error(`${label}: draft ${d.status} ${JSON.stringify(d.body)} / freeze ${f.status} ${JSON.stringify(f.body)}`);
    const cand = f.body.candidateId as string;
    const s = await call(A, 'POST', `${P}/candidates/${cand}/simulate`);
    expect(`${label}: simulation complete, all pass`, s.status === 200 && s.body.status === 'complete' && s.body.rows.every((r: { outcome: string }) => r.outcome === 'pass'), s.body);
    const c = await call(A, 'POST', `${P}/candidates/${cand}/compare`, { baselineRuleSetId: baselineId });
    expect(`${label}: comparison`, c.status === 200, c.body);
    const got = await call(R, 'GET', `${P}/candidates/${cand}`);
    if (got.status !== 200) throw new Error(`${label}: candidate read ${got.status} ${JSON.stringify(got.body)}`);
    const detail = got.body;
    const decisions = detail.comparisons.flatMap((k: { id: string; envelope: { differences: { id: string }[] } }) =>
      k.envelope.differences.map((x) => ({ comparisonId: k.id, differenceId: x.id, decision: 'expected' })));
    return { cand, sim: s.body.simulationId as string, comparisonIds: c.body.comparisons.map((k: { comparisonId: string }) => k.comparisonId) as string[], decisions };
  }
  const review = (x: Awaited<ReturnType<typeof prepare>>, token: string, outcome: 'approved' | 'rejected') =>
    call(token, 'POST', `${P}/candidates/${x.cand}/reviews`, { simulationId: x.sim, outcome, rationale: `Revisão sintética do ensaio: ${outcome}.`, comparisonIds: x.comparisonIds, decisions: x.decisions });

  // Rejection path.
  const rej = await prepare('rejected candidate', 'Posicao');
  const own = await review(rej, A, 'approved');
  expect('author cannot review own candidate (409)', own.status === 409 && own.body.error === 'AUTHOR_CANNOT_REVIEW', own.body);
  const rejected = await review(rej, R, 'rejected');
  expect('reviewer rejects', rejected.status === 201, rejected.body);
  const rejState = (await call(R, 'GET', `${P}/candidates/${rej.cand}`)).body.candidate.state;
  expect('rejected candidate state', rejState === 'rejected', rejState);
  const rejPreview = await call(R, 'POST', `${P}/activation/preview`, { action: 'activate', candidateId: rej.cand, reviewId: rejected.body.reviewId, scope: 'global' });
  expect('a rejected candidate cannot be activated', rejPreview.status >= 400, rejPreview);

  // Approval, preview, confirm, replay.
  const one = await prepare('candidate 1', 'Classificacao');
  const ok1 = await review(one, R, 'approved');
  expect('reviewer approves candidate 1', ok1.status === 201, ok1.body);
  const pv1 = await call(R, 'POST', `${P}/activation/preview`, { action: 'activate', candidateId: one.cand, reviewId: ok1.body.reviewId, scope: 'global' });
  expect('preview candidate 1', pv1.status === 201, pv1.body);
  const cf1 = await call(R, 'POST', `${P}/activation/confirm`, { token: pv1.body.token, intentHash: pv1.body.intentHash, justification: 'Ativação sintética do ensaio.' });
  expect('confirm candidate 1', cf1.status === 200 && cf1.body.replayed === false, cf1.body);
  const rp1 = await call(R, 'POST', `${P}/activation/confirm`, { token: pv1.body.token, intentHash: pv1.body.intentHash, justification: 'Ativação sintética do ensaio.' });
  expect('replay returns the same activation', rp1.status === 200 && rp1.body.replayed === true && rp1.body.activationId === cf1.body.activationId, rp1.body);

  // Second activation supersedes; rollback (return) to candidate 1.
  const two = await prepare('candidate 2', 'Classificacao Fiscal');
  const ok2 = await review(two, R, 'approved');
  const pv2 = await call(R, 'POST', `${P}/activation/preview`, { action: 'activate', candidateId: two.cand, reviewId: ok2.body.reviewId, scope: 'global' });
  expect('preview candidate 2 sees the active rule', pv2.status === 201 && pv2.body.affectedScope.basis === 'active_candidate', pv2.body);
  const cf2 = await call(R, 'POST', `${P}/activation/confirm`, { token: pv2.body.token, intentHash: pv2.body.intentHash, justification: 'Segunda ativação sintética.' });
  expect('confirm candidate 2', cf2.status === 200, cf2.body);
  const back = await call(R, 'POST', `${P}/activation/preview`, { action: 'rollback', candidateId: one.cand, reviewId: ok1.body.reviewId, scope: 'global' });
  expect('rollback preview to candidate 1', back.status === 201, back.body);
  const backCf = await call(R, 'POST', `${P}/activation/confirm`, { token: back.body.token, intentHash: back.body.intentHash, justification: 'Retorno sintético ao candidato 1.' });
  expect('rollback confirmed', backCf.status === 200, backCf.body);
  const states = await Promise.all([one.cand, two.cand].map(async (c) => (await call(R, 'GET', `${P}/candidates/${c}`)).body.candidate.state));
  expect('after rollback: candidate 1 active, candidate 2 not', states[0] === 'active' && states[1] !== 'active', states);
  const acts = await call(R, 'GET', `${P}/activations`);
  expect('three activations recorded (activate, activate, rollback)', acts.body.length === 3 && acts.body.filter((a: { kind: string }) => a.kind === 'rollback').length === 1, acts.body.length);
  const audit = await call(R, 'GET', `${P}/audit`);
  const actions = new Set(audit.body.map((x: { action: string }) => x.action));
  expect('ANAT audit readable by an admin (anat_list_audit)', audit.status === 200 && ['ANAT_RULES_DRAFT_SAVED', 'ANAT_RULES_REVIEWED', 'ANAT_RULES_ACTIVATED', 'ANAT_RULES_ATTEMPT_REJECTED'].every((a) => actions.has(a)), [...actions]);
  expect('ANAT audit refused to a non-admin', (await call(N, 'GET', `${P}/audit`)).status === 403, null);
  const direct = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'anatomy_rules'")).rows[0].n;
  steps['ANAT audit rows written'] = direct;
}
await db.end();
console.log(JSON.stringify({ mode, steps }));
