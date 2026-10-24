import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import pg from 'pg';
import { DISPOSABLE_URL, prepareAdminDatabase } from './support/anatomy-admin-db.js';

/**
 * ANAT-ADMIN-01 P3-D (issue #116): administrative HTTP API over the accepted P3-B1 persistence and the P3-C executor,
 * in a FRESH disposable database (own CI job per PostgreSQL major). Real JWT + session verification (auth.plugin),
 * real platform-admin read (platform-role) through a LOGIN role that is a member of radar_app, real isolated workers.
 * Synthetic data only: no corpus, gold or reserve; nothing is reprocessed; the route is not registered in buildApp().
 */
function assertDisposableEnvironment(env: NodeJS.ProcessEnv): string {
  assert.equal(env.CI, 'true', 'CI=true required');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions only');
  assert.equal(env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.equal(env.ANAT04_CI_DATABASE_URL, DISPOSABLE_URL, 'Only the dedicated disposable database is allowed');
  assert.equal(env.DATABASE_URL, undefined, 'Generic runtime database URL must be absent');
  assert.equal(env.DATABASE_ADMIN_URL, undefined, 'Generic admin database URL must be absent');
  return DISPOSABLE_URL;
}

test('P3-D disposable guard refuses external configuration before connection', () => {
  const safe = { CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test', ANAT04_CI_DATABASE_URL: DISPOSABLE_URL };
  assert.equal(assertDisposableEnvironment(safe), DISPOSABLE_URL);
  for (const key of Object.keys(safe)) { const m: NodeJS.ProcessEnv = { ...safe }; delete m[key]; assert.throws(() => assertDisposableEnvironment(m)); }
  assert.throws(() => assertDisposableEnvironment({ ...safe, ANAT04_CI_DATABASE_URL: 'postgresql://postgres:postgres@remote:5432/anat04_ci' }));
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_URL: DISPOSABLE_URL }));
});

const skip = process.env.ANAT04_CI_DATABASE_URL === undefined ? 'CI-only database; offline checks still run' : false;
test('P3-D admin API end to end (fresh disposable database)', { skip }, async (t) => {
  const url = assertDisposableEnvironment(process.env); // Must precede any connection.
  // env.ts (imported by the auth plugin) requires these; both are local to this process and never real secrets.
  process.env.DATABASE_URL = url; process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex'); process.env.LOG_LEVEL = 'info';
  const [{ default: Fastify }, { serializerCompiler, validatorCompiler }, { Kysely, PostgresDialect }, { registerAuthSupport }, { anatomyRulesAdminRoutes },
    { SimulationExecutor }, { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION }, contract, { assertCanonicalSubset, AdminError }, { ANATOMY_ENGINE_BUILD_HASH: ENGINE }] = await Promise.all([
    import('fastify'), import('fastify-type-provider-zod'), import('kysely'), import('../src/modules/auth/auth.plugin.js'),
    import('../src/api/routes/anatomy-rules-admin.route.js'), import('../src/modules/anatomy/simulation-executor.js'),
    import('../src/modules/anatomy/profile.js'), import('../src/modules/anatomy/contract.js'), import('../src/modules/anatomy/admin/rules-admin.service.js'),
    import('../src/modules/anatomy/build-identity.js')]);
  delete process.env.DATABASE_URL;

  const owner = new pg.Client({ connectionString: url }); await owner.connect();
  await prepareAdminDatabase(owner, ['anatomy-api-ci-bootstrap.sql']);
  // Runtime login (like production): a LOGIN role that inherits radar_app; random password, this process only.
  const login = `anat_api_ci_${randomBytes(4).toString('hex')}`; const password = randomBytes(24).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN INHERIT PASSWORD '${password}' IN ROLE radar_app`);
  const runtimeUrl = url.replace('postgres:postgres@', `${login}:${password}@`);
  const pool = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  const logs: string[] = [];
  const executor = new SimulationExecutor();
  async function makeApp(exec: InstanceType<typeof SimulationExecutor> | null) {
    const app = Fastify({ logger: { level: 'info', stream: new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } }) } });
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', new Kysely<any>({ dialect: new PostgresDialect({ pool }) }));
    app.decorate('curatorPool', null);
    await registerAuthSupport(app);
    await app.register(anatomyRulesAdminRoutes, { pool, executor: exec });
    await app.ready();
    return app;
  }
  const app = await makeApp(executor);
  // Users: admins A (author), R and R2 (reviewers); N authenticated non-admin.
  const users: Record<string, { id: string; headers: Record<string, string> }> = {};
  for (const [name, admin] of [['A', true], ['R', true], ['R2', true], ['N', false]] as const) {
    const id = randomUUID(); const sid = randomUUID();
    await owner.query("INSERT INTO app_users (id, email) VALUES ($1, $2)", [id, `${name}-${id}@example.test`]);
    if (admin) await owner.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [id]);
    await owner.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours')", [sid, id]);
    users[name] = { id, headers: { authorization: `Bearer ${app.jwt.sign({ sub: id, sid, typ: 'access' })}` } };
  }
  const P = '/api/v1/admin/anatomy-rules';
  const call = async (user: string | null, method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `${P}${path}`, headers: user ? users[user]!.headers : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
  };
  const audit = async (where: string, params: unknown[] = []) => Number((await owner.query(`SELECT count(*) FROM audit_log WHERE entity_type='anatomy_rules' AND ${where}`, params)).rows[0].count);

  // Synthetic fixtures (same shapes as the P2 tests).
  const defaults = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
  const rfbHeaders = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { ncm: { columnHeaders: string[] } }).ncm.columnHeaders;
  const candidateProfiles = () => [...defaults().filter((p) => !((p as { scope: { level: string; source?: string } }).scope.level === 'source'
    && (p as { scope: { source?: string } }).scope.source === 'RFB')), { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' },
    fields: { ncm: { columnHeaders: [...rfbHeaders, 'Classificacao'] } } }];
  const table = { id: 'col-classificacao', purpose: 'coluna NCM chamada Classificacao', polarity: 'positive', source: 'RFB',
    input: { html: '<table><tr><td>Classificacao</td></tr><tr><td>8471.30.12</td></tr></table>' },
    expect: [{ kind: 'entity', domain: 'NCM', literal: '8471.30.12' }], catalog: { edition: 'syn', codes: ['84713012'] } };
  const article = { id: 'art', purpose: 'artigo', polarity: 'positive', source: 'DOU', input: { html: '<p>Art. 1º NCM 8471.41.00.</p>' }, expect: [{ kind: 'part', type: 'article' }] };
  const quarantinedNegative = { id: 'neg-q', purpose: 'extração suspensa', polarity: 'negative', source: 'DOU',
    input: { html: '<p title="a&#x301;">Art. 1º NCM 8471.41.00.</p>' }, expect: [{ kind: 'entity', domain: 'NCM' }] };

  try {
    await t.test('authentication and authorisation: 401 without token or with a revoked session, 403 for a non-admin', async () => {
      assert.equal((await call(null, 'GET', '/drafts')).status, 401);
      assert.deepEqual((await call('N', 'GET', '/drafts')).body, { error: 'platform_admin_required' });
      assert.equal((await call('A', 'GET', '/drafts')).status, 200);
      const sid = randomUUID();
      await owner.query("INSERT INTO auth_sessions (id, user_id, idle_expires_at, absolute_expires_at, revoked_at) VALUES ($1,$2, now()+interval '1 hour', now()+interval '2 hours', now())", [sid, users.A!.id]);
      const revoked = await app.inject({ method: 'GET', url: `${P}/drafts`, headers: { authorization: `Bearer ${app.jwt.sign({ sub: users.A!.id, sid, typ: 'access' })}` } });
      assert.equal(revoked.statusCode, 401);
      assert.equal((await call('N', 'POST', '/drafts', { profiles: defaults(), examples: [article] })).status, 403);
      assert.equal(await audit('true'), 0, 'refusals before authorisation are not audited');
    });

    let baselineId = ''; let cand = ''; let sim = ''; let comparisons: { comparisonId: string; differenceCount: number }[] = []; let rev = '';
    await t.test('drafts and freeze: identity from authentication, optimistic revision, strict body, idempotent freeze', async () => {
      assert.deepEqual((await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [article], author: users.R!.id })).body, { error: 'invalid_request' });
      const base = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [table, article] });
      assert.equal(base.status, 201);
      const baseFrozen = await call('A', 'POST', `/drafts/${base.body.id}/freeze`, { revision: 1 });
      baselineId = (await call('A', 'GET', `/candidates/${baseFrozen.body.candidateId}`)).body.candidate.ruleSetId;
      const d = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [table, article] });
      assert.equal((await owner.query('SELECT author FROM anatomy_rule_drafts WHERE id=$1', [d.body.id])).rows[0].author, users.A!.id);
      const upd = await call('A', 'PUT', `/drafts/${d.body.id}`, { revision: 1, profiles: candidateProfiles(), examples: [table, article] });
      assert.deepEqual(upd.body, { id: d.body.id, revision: 2 });
      const stale = await call('A', 'PUT', `/drafts/${d.body.id}`, { revision: 1, profiles: defaults(), examples: [article] });
      assert.equal(stale.status, 409); assert.equal(stale.body.error, 'STALE_REVISION');
      assert.equal(await audit("action='ANAT_RULES_ATTEMPT_REJECTED' AND correlation_id=$1", [stale.headers['x-correlation-id']]), 1, 'attempt audited separately');
      assert.equal((await call('R', 'PUT', `/drafts/${d.body.id}`, { revision: 2, profiles: defaults(), examples: [article] })).status, 404, 'only the author edits');
      assert.equal((await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [{ ...article, id: '12' }] })).status, 422, 'reserved id');
      const f1 = await call('A', 'POST', `/drafts/${d.body.id}/freeze`, { revision: 2 });
      const f2 = await call('A', 'POST', `/drafts/${d.body.id}/freeze`, { revision: 2 });
      assert.equal(f1.body.created, true); assert.deepEqual(f2.body, { candidateId: f1.body.candidateId, created: false });
      cand = f1.body.candidateId;
      assert.equal((await call('A', 'GET', `/candidates/${cand}`)).body.candidate.state, 'frozen');
    });

    await t.test('D-R1-01: invalid profiles/examples are refused with 422 before persisting, on save and on freeze', async () => {
      const drafts = async () => Number((await owner.query('SELECT count(*) FROM anatomy_rule_drafts')).rows[0].count);
      const saved = async () => await audit("action='ANAT_RULES_DRAFT_SAVED'");
      const before = [await drafts(), await saved()];
      const cases: [string, unknown][] = [
        ['unknown profile version', { profiles: [{ profileVersion: 'NOPE', scope: { level: 'default' }, fields: {} }], examples: [article] }],
        ['profile with unknown field', { profiles: [...defaults(), { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'DOU' }, fields: { bogus: 1 } }], examples: [article] }],
        ['example missing required fields', { profiles: defaults(), examples: [{ id: 'only-id' }] }],
        ['example with unknown field', { profiles: defaults(), examples: [{ ...article, extra: true }] }],
        ['example with both html and text', { profiles: defaults(), examples: [{ ...article, input: { html: '<p>x</p>', text: 'x' } }] }],
        ['example over the input limit', { profiles: defaults(), examples: [{ ...article, input: { text: 'x'.repeat(256 * 1024 + 1) } }] }],
        ['profiles over 64 KiB', { profiles: [...defaults(), { pad: 'x'.repeat(70 * 1024) }], examples: [article] }],
      ];
      for (const [label, body] of cases) {
        const r = await call('A', 'POST', '/drafts', body);
        assert.equal(r.status, 422, `${label}: ${JSON.stringify(r.body)}`);
        assert.deepEqual(Object.keys(r.body).sort(), ['correlationId', 'error'], label);
      }
      const d = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [article] });
      const bad = await call('A', 'PUT', `/drafts/${d.body.id}`, { revision: 1, profiles: defaults(), examples: [{ id: 'only-id' }] });
      assert.equal(bad.status, 422);
      assert.deepEqual((await owner.query('SELECT revision FROM anatomy_rule_drafts WHERE id=$1', [d.body.id])).rows[0], { revision: 1 }, 'revision not incremented');
      assert.deepEqual([await drafts(), await saved()], [before[0]! + 1, before[1]! + 1], 'only the valid save persisted and was audited');
      // A pre-existing invalid draft (written before this validation existed) cannot be frozen.
      const legacy = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [article] });
      await owner.query("ALTER TABLE anatomy_rule_drafts DISABLE TRIGGER anat_guard_draft");
      await owner.query("UPDATE anatomy_rule_drafts SET examples = '[{\"id\":\"only-id\"}]' WHERE id=$1", [legacy.body.id]);
      await owner.query("ALTER TABLE anatomy_rule_drafts ENABLE TRIGGER anat_guard_draft");
      const frozenBefore = Number((await owner.query('SELECT count(*) FROM anatomy_rule_candidates')).rows[0].count);
      const f = await call('A', 'POST', `/drafts/${legacy.body.id}/freeze`, { revision: 1 });
      assert.equal(f.status, 422, JSON.stringify(f.body));
      assert.equal(Number((await owner.query('SELECT count(*) FROM anatomy_rule_candidates')).rows[0].count), frozenBefore, 'nothing frozen');
    });

    await t.test('simulation and comparison through the real executor; author cannot review; the full proof approves', async () => {
      const s = await call('A', 'POST', `/candidates/${cand}/simulate`);
      assert.equal(s.status, 200, JSON.stringify(s.body));
      assert.deepEqual([s.body.status, s.body.rows.map((r: { outcome: string }) => r.outcome)], ['complete', ['pass', 'pass']]);
      sim = s.body.simulationId;
      const c = await call('A', 'POST', `/candidates/${cand}/compare`, { baselineRuleSetId: baselineId });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      comparisons = c.body.comparisons;
      assert.equal(comparisons.length, 2); assert.ok(comparisons.some((k) => k.differenceCount > 0));
      const detail = (await call('R', 'GET', `/candidates/${cand}`)).body;
      assert.equal(detail.candidate.state, 'simulated');
      const decisions = detail.comparisons.flatMap((k: { id: string; envelope: { differences: { id: string }[] } }) =>
        k.envelope.differences.map((d) => ({ comparisonId: k.id, differenceId: d.id, decision: 'expected' })));
      const body = { simulationId: sim, outcome: 'approved', rationale: 'Revisão sintética suficiente.', comparisonIds: comparisons.map((k) => k.comparisonId), decisions };
      const own = await call('A', 'POST', `/candidates/${cand}/reviews`, body);
      assert.deepEqual([own.status, own.body.error], [409, 'AUTHOR_CANNOT_REVIEW']);
      const missing = await call('R', 'POST', `/candidates/${cand}/reviews`, { ...body, decisions: decisions.slice(1) });
      assert.deepEqual([missing.status, missing.body.error], [409, 'REVIEW_INCOMPLETE']);
      const ok = await call('R', 'POST', `/candidates/${cand}/reviews`, body);
      assert.equal(ok.status, 201, JSON.stringify(ok.body)); rev = ok.body.reviewId;
      assert.equal((await call('R', 'GET', `/candidates/${cand}`)).body.candidate.state, 'approved');
      assert.equal(await audit("action='ANAT_RULES_REVIEWED' AND entity_id=$1", [rev]), 1);
      assert.equal(await audit("after_data::text LIKE '%Revisão sintética%'"), 0, 'rationale never reaches the audit');
    });

    await t.test('inconclusive simulation blocks approval (P2 §2.5 adjustment through the API)', async () => {
      const d = await call('A', 'POST', '/drafts', { profiles: candidateProfiles(), examples: [quarantinedNegative] });
      const f = await call('A', 'POST', `/drafts/${d.body.id}/freeze`, { revision: 1 });
      const s = await call('A', 'POST', `/candidates/${f.body.candidateId}/simulate`);
      assert.deepEqual([s.body.status, s.body.rows[0].outcome], ['complete', 'inconclusive']);
      const c = await call('A', 'POST', `/candidates/${f.body.candidateId}/compare`, { baselineRuleSetId: baselineId });
      const r = await call('R', 'POST', `/candidates/${f.body.candidateId}/reviews`, { simulationId: s.body.simulationId, outcome: 'approved',
        rationale: 'Tentativa de aprovar inconclusivo.', comparisonIds: c.body.comparisons.map((k: { comparisonId: string }) => k.comparisonId), decisions: [] });
      assert.deepEqual([r.status, r.body.error], [409, 'SIMULATION_NOT_PASSING']);
    });

    await t.test('preview/confirm: token returned once, only its hash stored, never logged; replay, stale, foreign, concurrency', async () => {
      const pv = await call('R', 'POST', '/activation/preview', { action: 'activate', candidateId: cand, reviewId: rev, scope: 'global' });
      assert.equal(pv.status, 201, JSON.stringify(pv.body));
      const { token, intentHash, affectedScope } = pv.body;
      assert.equal(affectedScope.basis, 'shipped_defaults');
      assert.equal(affectedScope.publications.status, 'unsupported'); assert.equal(affectedScope.analyses.status, 'unsupported');
      assert.ok(affectedScope.targets.some((x: { source: string; changed: boolean }) => x.source === 'RFB' && x.changed));
      assert.ok(affectedScope.targets.some((x: { source: string; changed: boolean }) => x.source === 'DOU' && !x.changed));
      const stored = await owner.query("SELECT count(*) FROM anatomy_rule_activation_previews WHERE row_to_json(anatomy_rule_activation_previews)::text LIKE '%' || $1 || '%'", [token]);
      assert.equal(Number(stored.rows[0].count), 0, 'raw token not stored');
      const foreign = await call('R2', 'POST', '/activation/confirm', { token, intentHash, justification: 'Confirmação de outro ator.' });
      assert.deepEqual([foreign.status, foreign.body.error], [409, 'PREVIEW_EXPIRED']);
      const wrongIntent = await call('R', 'POST', '/activation/confirm', { token, intentHash: 'a'.repeat(64), justification: 'Intenção divergente teste.' });
      assert.deepEqual([wrongIntent.status, wrongIntent.body.error], [409, 'PREVIEW_STALE']);
      const unknown = await call('R', 'POST', '/activation/confirm', { token: randomBytes(32).toString('base64url'), intentHash, justification: 'Token desconhecido teste.' });
      assert.deepEqual([unknown.status, unknown.body.error], [409, 'PREVIEW_EXPIRED']);
      // Two concurrent confirms of the same token: one activation; the other replays it.
      const [x, y] = await Promise.all([0, 1].map(() => call('R', 'POST', '/activation/confirm', { token, intentHash, justification: 'Ativação sintética justificada.' })));
      assert.equal(x!.status, 200, JSON.stringify(x!.body)); assert.equal(y!.status, 200, JSON.stringify(y!.body));
      assert.equal(x!.body.activationId, y!.body.activationId);
      assert.deepEqual([x!.body.replayed, y!.body.replayed].sort(), [false, true]);
      const before = await audit("action='ANAT_RULES_ACTIVATED'");
      const replay = await call('R', 'POST', '/activation/confirm', { token, intentHash, justification: 'Ativação sintética justificada.' });
      assert.deepEqual(replay.body, { activationId: x!.body.activationId, replayed: true });
      assert.equal(await audit("action='ANAT_RULES_ACTIVATED'"), before, 'replay adds no success audit');
      assert.equal(before, 1);
      assert.equal((await call('R', 'GET', `/candidates/${cand}`)).body.candidate.state, 'active');
      assert.equal((await call('R', 'GET', '/activations')).body.length, 1);
      assert.ok(!logs.join('\n').includes(token), 'token never logged');
      assert.equal(Number((await owner.query('SELECT count(*) FROM publication_anatomies')).rows[0].count) + Number((await owner.query('SELECT count(*) FROM anatomy_runs')).rows[0].count), 0, 'nothing reprocessed');
    });

    await t.test('D-R1-02: preview scope and observed activation come from the same rule, also against a concurrent confirm', async () => {
      const S = 'scope-preview-race';
      const first = await call('R', 'POST', '/activation/preview', { action: 'activate', candidateId: cand, reviewId: rev, scope: S });
      assert.equal(first.body.affectedScope.basis, 'shipped_defaults', 'first activation: no active rule');
      assert.equal((await owner.query('SELECT observed_activation_id FROM anatomy_rule_activation_previews WHERE id=$1', [first.body.previewId])).rows[0].observed_activation_id, null);
      // A confirm holds the scope lock (open transaction, not yet committed) while a new preview is requested.
      const racer = new pg.Client({ connectionString: runtimeUrl }); await racer.connect();
      try {
        await racer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await racer.query("SELECT set_config('app.user_id', $1, true)", [users.R!.id]);
        const tokenHash = createHash('sha256').update(first.body.token, 'utf8').digest('hex');
        const activation = (await racer.query('SELECT activation_id AS id FROM anat_confirm($1,$2,$3,$4,$5)',
          [tokenHash, first.body.intentHash, ENGINE, 'Ativação concorrente sintética.', randomUUID()])).rows[0].id as string;
        let settled = false;
        const pending = call('R', 'POST', '/activation/preview', { action: 'activate', candidateId: cand, reviewId: rev, scope: S }).finally(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(settled, false, 'the preview waits for the in-flight confirm');
        await racer.query('COMMIT');
        const second = await pending;
        assert.equal(second.status, 201, JSON.stringify(second.body));
        assert.equal(second.body.affectedScope.basis, 'active_candidate', 'scope computed on the rule activated concurrently');
        const observed = (await owner.query('SELECT observed_activation_id FROM anatomy_rule_activation_previews WHERE id=$1', [second.body.previewId])).rows[0].observed_activation_id;
        assert.equal(observed, activation, 'observed activation = the rule the scope was computed on');
      } finally { await racer.end(); }
    });

    await t.test('session context never leaks through the pool; audit unavailable means no mutation', async () => {
      for (let i = 0; i < 4; i++) {
        const c = await pool.connect();
        try { assert.ok(!(await c.query("SELECT current_setting('app.user_id', true) AS v")).rows[0].v, 'no user left on a pooled connection'); } finally { c.release(); }
      }
      const drafts = Number((await owner.query('SELECT count(*) FROM anatomy_rule_drafts')).rows[0].count);
      await owner.query('REVOKE INSERT ON audit_log FROM anat_rules_writer');
      try {
        const r = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [article] });
        assert.deepEqual([r.status, r.body.error], [503, 'audit_unavailable']);
      } finally { await owner.query('GRANT INSERT ON audit_log TO anat_rules_writer'); }
      assert.equal(Number((await owner.query('SELECT count(*) FROM anatomy_rule_drafts')).rows[0].count), drafts);
    });

    await t.test('canonical subset refused before persistence, equal to the database canonicaliser on accepted vectors', async () => {
      const r = await call('A', 'POST', '/drafts', { profiles: [...defaults(), { '\ue000': 1 }], examples: [article] });
      assert.deepEqual([r.status, r.body.error], [422, 'CANONICAL_KEY_UNSUPPORTED']);
      const accepted: unknown[] = [{ b: 1, a: [0.5, -17, 9007199254740991, 'São Paulo e\u0301', null, true] }, { nested: { z: 0.000001, y: 123.456 } }];
      for (const v of accepted) {
        assertCanonicalSubset(v);
        assert.equal((await owner.query('SELECT anat_canonical_json($1::jsonb) AS c', [JSON.stringify(v)])).rows[0].c, contract.canonicalJson(v));
      }
      for (const v of [{ x: 9007199254740993 }, { x: 1e21 }, { x: 1e-7 }, { x: 0.1234567890123456 }, { '\ud83d\ude00': 1 }]) {
        assert.throws(() => assertCanonicalSubset(v), (e) => e instanceof AdminError && e.status === 422);
        await assert.rejects(owner.query('SELECT anat_canonical_json($1::jsonb)', [JSON.stringify(v)]), /CANONICAL_/u);
      }
    });

    await t.test('real HTTP socket: a simulation completes normally; a client abort stops the workers and records nothing', async () => {
      const slow = new SimulationExecutor({ workerUrl: new URL('./support/anatomy-adversarial-worker.ts', import.meta.url) });
      const http = await makeApp(slow);
      try {
        const address = await http.listen({ host: '127.0.0.1', port: 0 });
        const ok = await fetch(`${address}${P}/candidates/${cand}/simulate`, { method: 'POST', headers: users.A!.headers });
        assert.equal(ok.status, 200, 'no spurious abort once the request body is consumed');
        const d = await call('A', 'POST', '/drafts', { profiles: defaults(), examples: [{ ...article, id: 'slow-5000' }] });
        const f = await call('A', 'POST', `/drafts/${d.body.id}/freeze`, { revision: 1 });
        const before = Number((await owner.query('SELECT count(*) FROM anatomy_rule_simulations WHERE candidate_id=$1', [f.body.candidateId])).rows[0].count);
        const ac = new AbortController(); setTimeout(() => ac.abort(), 400);
        await assert.rejects(fetch(`${address}${P}/candidates/${f.body.candidateId}/simulate`, { method: 'POST', headers: users.A!.headers, signal: ac.signal }));
        for (let i = 0; i < 50 && slow.stats().active > 0; i++) await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual([slow.stats().active, slow.stats().liveWorkers], [0, 0], 'workers stopped well before the 2 s budget');
        // The cancelled run is recorded as such (status cancelled), never as a pass.
        const rows = (await owner.query('SELECT status FROM anatomy_rule_simulations WHERE candidate_id=$1', [f.body.candidateId])).rows;
        assert.ok(rows.length === before || rows.every((r) => r.status === 'cancelled'), JSON.stringify(rows));
      } finally { await http.close(); await slow.close(); }
    });

    await t.test('executor unavailable → 503 audited; queue full → 429; errors are sanitised codes only', async () => {
      const noExec = await makeApp(null);
      try {
        const r = await noExec.inject({ method: 'POST', url: `${P}/candidates/${cand}/simulate`, headers: users.A!.headers });
        assert.deepEqual([r.statusCode, r.json()], [503, { error: 'SIMULATION_UNAVAILABLE', correlationId: r.headers['x-correlation-id'] }]);
        assert.equal(await audit("action='ANAT_RULES_ATTEMPT_REJECTED' AND correlation_id=$1", [r.headers['x-correlation-id']]), 1);
      } finally { await noExec.close(); }
      const tiny = new SimulationExecutor({ concurrency: 1, queueLimit: 0 });
      const busy = await makeApp(tiny);
      try {
        const [a, b] = await Promise.all([0, 1].map(() => busy.inject({ method: 'POST', url: `${P}/candidates/${cand}/simulate`, headers: users.A!.headers })));
        assert.deepEqual([a!.statusCode, b!.statusCode].sort(), [200, 429]);
      } finally { await busy.close(); await tiny.close(); }
      const bad = await call('A', 'GET', '/candidates/not-a-uuid');
      assert.deepEqual(bad.body, { error: 'invalid_request' });
    });
  } finally {
    await app.close(); await executor.close(); await pool.end();
    await owner.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined); // the cluster outlives this database locally
    await owner.end();
  }
});
