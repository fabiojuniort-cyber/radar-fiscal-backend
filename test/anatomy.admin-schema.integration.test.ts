import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { canonicalJson, sha256 } from '../src/modules/anatomy/contract.js';
import { applyRealChain, integrationDeltaSql, latestRealPolicyJson, PROJECT_MIGRATIONS } from './support/anatomy-admin-db.js';
import { runProjectMigrations } from './support/anatomy-migrations.js';

/**
 * ANAT-ADMIN-01 / P3-B1 (issue #116): persistence and audit rehearsal in the DISPOSABLE CI database only.
 * Test SQL lives in test/support (never migrations/); nothing here is applied automatically. The database-backed part
 * needs a FRESH database (it commits, so concurrent clients can be exercised) and runs in its own CI job per PostgreSQL
 * major; the file checks are offline. Synthetic data only: no corpus, gold, measurement or production.
 */
const disposableUrl = 'postgresql://postgres:postgres@localhost:5432/anat04_ci';
function assertDisposableEnvironment(env: NodeJS.ProcessEnv): string {
  assert.equal(env.CI, 'true', 'CI=true required');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'GitHub Actions only');
  assert.equal(env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.equal(env.ANAT04_CI_DATABASE_URL, disposableUrl, 'Only the dedicated disposable database is allowed');
  assert.equal(env.DATABASE_URL, undefined, 'Generic runtime database URL must be absent');
  assert.equal(env.DATABASE_ADMIN_URL, undefined, 'Generic admin database URL must be absent');
  return disposableUrl;
}
const support = (name: string) => new URL(`./support/${name}`, import.meta.url);
const read = (name: string) => readFile(support(name), 'utf8');
const gitBlob = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const CHAIN = {
  '006_audit.sql': 'f53c9fbb69e8839733b466f0244eb30dfbedc357',
  '074_audit_allowlist_and_backfill.sql': 'baf49f70ac67c5f9898ddfeb463165c104ed5437',
  '075_audit_historical_event_rules.sql': 'ad832c2d73954c39d763d0d0b7402fbbb5b684f7',
} as const;
const CUT_MARKER = 'CREATE TABLE IF NOT EXISTS public.audit_backfill_checkpoint(';
const policyJson = (sql: string) => /\$json\$(.*?)\$json\$/su.exec(sql)![1]!;

test('disposable CI guard rejects absent, partial and external configuration before connection', () => {
  const safe = { CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test', ANAT04_CI_DATABASE_URL: disposableUrl };
  assert.equal(assertDisposableEnvironment(safe), disposableUrl);
  for (const key of Object.keys(safe)) {
    const missing: NodeJS.ProcessEnv = { ...safe }; delete missing[key];
    assert.throws(() => assertDisposableEnvironment(missing));
  }
  for (const url of ['postgresql://postgres:postgres@remote:5432/anat04_ci', 'postgresql://postgres:postgres@localhost:5432/postgres',
    `${disposableUrl}?host=remote`, 'postgresql://postgres:postgres@localhost:5433/anat04_ci']) {
    assert.throws(() => assertDisposableEnvironment({ ...safe, ANAT04_CI_DATABASE_URL: url }));
  }
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_URL: disposableUrl }));
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_ADMIN_URL: disposableUrl }));
});

test('vendored audit chain is byte-identical to main and M_AUDIT_ANAT only appends to the 075 policy', async () => {
  for (const [file, blob] of Object.entries(CHAIN)) {
    assert.equal(gitBlob(await readFile(support(`anatomy-audit-chain/${file}`))), blob, file);
  }
  const lines = (await read('anatomy-audit-chain/074_audit_allowlist_and_backfill.sql')).split('\n');
  assert.equal(lines[160], CUT_MARKER, '074 excerpt stops right before the backfill checkpoint table');
  const original = policyJson(await read('anatomy-audit-chain/075_audit_historical_event_rules.sql'));
  const extended = policyJson(await read('anatomy-admin-audit-policy.sql'));
  assert.ok(extended.startsWith(`${original.slice(0, -1)},"ANAT_RULES_`), 'old entries byte for byte, then ANAT entries');
  const added = Object.keys(JSON.parse(extended)).filter((k) => !(k in JSON.parse(original)));
  assert.deepEqual(added, ['DRAFT_SAVED', 'CANDIDATE_FROZEN', 'SIMULATED', 'COMPARED', 'REVIEWED', 'ACTIVATION_PREVIEWED', 'ACTIVATED',
    'ATTEMPT_REJECTED'].map((e) => `ANAT_RULES_${e}|anatomy_rules`));
  for (const name of ['anatomy-admin-ci-schema.sql', 'anatomy-admin-audit-policy.sql', 'anatomy-audit-bootstrap-pre.sql', 'anatomy-audit-bootstrap-post.sql']) {
    assert.match(await read(name), /ANAT04_DISPOSABLE_CI_ONLY/u, `${name} carries the disposable guard`);
  }
});

const skip = process.env.ANAT04_CI_DATABASE_URL === undefined ? 'CI-only database; offline checks still run' : false;
test('P3-B1 admin persistence and audit (fresh disposable database)', { skip }, async (t) => {
  const connectionString = assertDisposableEnvironment(process.env); // Must precede construction/connect.
  const db = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  const db2 = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await db.connect(); await db2.connect();
  const E = 'e'.repeat(64); const E2 = 'f'.repeat(64);
  const h = (s: string) => sha256(s);
  const [A, B, R, R2, N] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]; // admins A/B (authors), R/R2 (reviewers); N not admin
  type Row = Record<string, any>;
  async function asRole(role: string, c: pg.Client, actor: string | null, sql: string, params: unknown[] = [], iso = 'READ COMMITTED'): Promise<Row[]> {
    await c.query(`BEGIN ISOLATION LEVEL ${iso}`);
    try {
      await c.query(`SET LOCAL ROLE ${role}`);
      if (actor) await c.query("SELECT set_config('app.user_id', $1, true)", [actor]);
      const result = await c.query(sql, params);
      await c.query('COMMIT');
      return result.rows;
    } catch (error) { await c.query('ROLLBACK').catch(() => undefined); throw error; }
  }
  const asApp = (c: pg.Client, actor: string | null, sql: string, params: unknown[] = [], iso = 'READ COMMITTED') => asRole('radar_app', c, actor, sql, params, iso);
  /** Several statements in ONE transaction as `role` (null = the owner connection itself); no trigger is disabled. */
  async function inTx(role: string | null, actor: string, body: (q: (sql: string, params?: unknown[]) => Promise<Row[]>) => Promise<void>, c = db): Promise<void> {
    await c.query('BEGIN');
    try {
      if (role) await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('app.user_id', $1, true)", [actor]);
      await body(async (sql, params = []) => (await c.query(sql, params)).rows);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK').catch(() => undefined); throw error; }
  }
  const asWriter = (actor: string | null, sql: string, params: unknown[] = []) => asRole('anat_rules_writer', db, actor, sql, params);
  const one = async (...a: Parameters<typeof asApp>) => (await asApp(...a))[0]!;
  const fails = (p: Promise<unknown>, code: RegExp | string) => assert.rejects(p, typeof code === 'string' ? new RegExp(`anat:${code}`, 'u') : code);
  const auditCount = async (where = 'true', params: unknown[] = []) =>
    Number((await db.query(`SELECT count(*) FROM audit_log WHERE entity_type='anatomy_rules' AND ${where}`, params)).rows[0].count);

  // Synthetic fixtures ---------------------------------------------------------------------------------------------
  let nonce = 0;
  const profiles = (tag: string) => [{ source: 'DOU', tag, note: 'Instrução Normativa — sintético', weight: 0.75 }];
  const example = (id: string) => ({ id, purpose: 'sintético', polarity: 'positive', source: 'DOU', family: null,
    input: { text: `Art. 1º Exemplo ${id}.` }, expect: [{ kind: 'part', type: 'article' }] });
  const saveDraft = (actor: string, p: unknown, ex: unknown, id: string | null = null, rev: number | null = null, corr = randomUUID()) =>
    one(db, actor, 'SELECT * FROM anat_save_draft($1,$2,$3::jsonb,$4::jsonb,$5)', [id, rev, JSON.stringify(p), JSON.stringify(ex), corr]);
  const freeze = (actor: string, id: string, rev: number, engine = E, corr = randomUUID()) =>
    one(db, actor, 'SELECT * FROM anat_freeze($1,$2,$3,$4)', [id, rev, engine, corr]);
  const run = (exampleId: string, outcome = 'pass', engine = E) => ({ exampleId, outcome, engineHash: engine,
    inputTextHash: h(`in:${exampleId}`), outputHash: h(`out:${exampleId}:${nonce}`), analysisId: h(`an:${exampleId}:${nonce}`), ruleSetHash: h('rs') });
  const simulate = (actor: string, cand: string, rows: ReturnType<typeof run>[], status = 'complete') =>
    one(db, actor, 'SELECT anat_record_simulation($1,$2,$3::jsonb,$4::jsonb,$5) AS id',
      [cand, status, JSON.stringify({ synthetic: true, rows: rows.length }), JSON.stringify(rows), randomUUID()]).then((r) => r.id as string);
  function envelope(o: { sim: ReturnType<typeof run>; before: string; after: string; engine?: string; diffs?: number }) {
    const differences = Array.from({ length: o.diffs ?? 1 }, (_, i) => {
      const d = { category: 'part', key: `article#${i}`, change: 'added', before: null, after: { type: 'article', label: `Art. ${i + 1}º — São Paulo`, confidence: 0.95 } };
      return { id: sha256(canonicalJson(d)).slice(0, 32), ...d };
    });
    const zero = { before: 0, after: 0 };
    const body = { snapshot: { inputTextHash: o.sim.inputTextHash, inputPresentationHash: null },
      before: { engineHash: o.engine ?? E, ruleSetHash: o.sim.ruleSetHash, outputHash: h(`before:${o.sim.exampleId}`), analysisId: h(`ba:${o.sim.exampleId}`), status: 'complete' },
      after: { engineHash: o.engine ?? E, ruleSetHash: o.sim.ruleSetHash, outputHash: o.sim.outputHash, analysisId: o.sim.analysisId, status: 'complete' },
      provenance: { beforeProfileSetHash: o.before, afterProfileSetHash: o.after }, differences,
      counts: { part: { before: 0, after: differences.length }, entity: zero, relation: zero, limitation: zero, eligibility: zero } };
    return { id: sha256(canonicalJson(body)), ...body };
  }
  const compare = (actor: string, cand: string, exId: string, base: { id: string; hash: string }, env: unknown) =>
    one(db, actor, 'SELECT * FROM anat_record_comparison($1,$2,$3,$4,$5::jsonb,$6)', [cand, exId, base.id, base.hash, JSON.stringify(env), randomUUID()]);
  const review = (actor: string, cand: string, sim: string, comps: string[], decisions: unknown[], outcome = 'approved', corr = randomUUID()) =>
    one(db, actor, 'SELECT anat_record_review($1,$2,$3,$4,$5::uuid[],$6::jsonb,$7) AS id',
      [cand, sim, outcome, 'Revisão sintética suficiente.', comps, JSON.stringify(decisions), corr]).then((r) => r.id as string);

  /** Draft → candidate (two examples) + baseline snapshot + passing simulation + one comparison per example. */
  async function scenario(opts: { author?: string; exampleIds?: string[]; tag?: string } = {}) {
    nonce += 1;
    const author = opts.author ?? A; const ids = opts.exampleIds ?? ['ex-a', 'ex-b'];
    const ex = ids.map(example);
    const baseDraft = await saveDraft(author, profiles(`base-${opts.tag ?? nonce}`), ex);
    await freeze(author, baseDraft.draft_id, 1);
    const baseHash = sha256(canonicalJson(profiles(`base-${opts.tag ?? nonce}`)));
    const base = { id: (await db.query('SELECT id FROM anatomy_rule_sets WHERE rule_hash=$1 AND snapshot_id IS NOT NULL', [baseHash])).rows[0].id as string, hash: baseHash };
    const p = profiles(`cand-${opts.tag ?? nonce}`);
    const draft = await saveDraft(author, p, ex);
    const frozen = await freeze(author, draft.draft_id, 1);
    const ruleHash = sha256(canonicalJson(p));
    const rows = ids.map((id) => run(id));
    const sim = await simulate(author, frozen.candidate_id, rows);
    const envs = rows.map((r) => envelope({ sim: r, before: baseHash, after: ruleHash }));
    const comps: string[] = [];
    for (const [i, id] of ids.entries()) comps.push((await compare(author, frozen.candidate_id, id, base, envs[i])).comparison_id);
    const decisions = envs.flatMap((env, i) => env.differences.map((d) => ({ comparisonId: comps[i], differenceId: d.id, decision: 'expected' })));
    return { author, draftId: draft.draft_id as string, cand: frozen.candidate_id as string, base, ruleHash, rows, sim, envs, comps, decisions, ex, p };
  }

  try {
    // Setup ---------------------------------------------------------------------------------------------------------
    const fresh = await db.query("SELECT to_regclass('public.audit_log') IS NULL AND to_regclass('public.anatomy_rule_sets') IS NULL AS fresh");
    assert.equal(fresh.rows[0].fresh, true, 'requires a fresh disposable database (the dedicated CI job provides one)');
    const chain = async (f: keyof typeof CHAIN) => read(`anatomy-audit-chain/${f}`);
    const audit074 = (await chain('074_audit_allowlist_and_backfill.sql')).split('\n').slice(0, 160).join('\n');
    await t.test('every SQL file refuses to run without the disposable marker', async () => {
      for (const name of ['anatomy-audit-bootstrap-pre.sql', 'anatomy-admin-ci-schema.sql']) {
        await assert.rejects(db.query(await read(name)), /ANAT04_DISPOSABLE_CI_ONLY/u);
      }
    });
    let oldPolicy: Row = {};
    // Integration readiness: with ANAT_MAIN_MIGRATIONS_DIR the REAL chain of main replaces the vendored excerpt.
    const realDir = process.env.ANAT_MAIN_MIGRATIONS_DIR || null;
    const oldKeys = Object.keys(JSON.parse(policyJson(await chain('075_audit_historical_event_rules.sql'))));
    const snapshotPolicy = async () => (await db.query(`SELECT k, audit_event_policy(split_part(k,'|',1), split_part(k,'|',2)) AS rule,
      audit_project(split_part(k,'|',1), split_part(k,'|',2), '{"company_id":"00000000-0000-4000-8000-000000000000","is_active":true,"version":3,"x":"free text"}') AS projected
      FROM unnest($1::text[]) k ORDER BY k`, [oldKeys])).rows;
    let newPolicy: Row[] = [];
    if (PROJECT_MIGRATIONS) {
      // Integration package 2: the real runner applies the real chain and 077, then 078 (M_AUDIT_ANAT) and 079 (M_ANAT_ADMIN).
      await runProjectMigrations(connectionString, '077_anat_base.sql');
      oldPolicy = await snapshotPolicy();
      await runProjectMigrations(connectionString);
      newPolicy = await snapshotPolicy();
    } else {
      if (realDir) await applyRealChain(db, realDir);
      await db.query('BEGIN');
      await db.query("SET LOCAL anatomy.ci_disposable = 'true'");
      if (!realDir) {
        await db.query(await read('anatomy-audit-bootstrap-pre.sql'));
        await db.query(await chain('006_audit.sql'));
        await db.query(audit074);
        await db.query(await chain('075_audit_historical_event_rules.sql'));
        await db.query(await read('anatomy-audit-bootstrap-post.sql'));
      }
      oldPolicy = await snapshotPolicy();
      await db.query(await read('anatomy-ci-schema.sql'));
      await db.query(await read('anatomy-admin-audit-policy.sql'));
      newPolicy = await snapshotPolicy();
      await db.query(await read('anatomy-admin-ci-schema.sql'));
      await db.query(await integrationDeltaSql()); // integration R1 deltas (same block as migration 079)
      await db.query('COMMIT');
    }
    // Platform admins A, B, R, R2 (active, unrevoked) and ordinary user N (036 predicate inputs).
    for (const [id, admin] of [[A, true], [B, true], [R, true], [R2, true], [N, false]] as const) {
      await db.query("INSERT INTO app_users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
      if (admin) await db.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [id]);
    }

    await t.test('real chain (when used): the latest real audit policy is still the one M_AUDIT_ANAT extends', { skip: realDir ? false : 'vendored chain' }, async () => {
      assert.equal(await latestRealPolicyJson(realDir!), policyJson(await chain('075_audit_historical_event_rules.sql')),
        'main changed audit_event_policy after 075: M_AUDIT_ANAT must be rebased');
    });

    await t.test('M_AUDIT_ANAT: every pre-existing event has the same rule and the same projection', () => {
      assert.equal(oldPolicy.length, oldKeys.length);
      assert.deepEqual(newPolicy, oldPolicy);
    });

    await t.test('criterion 6: DB canonical JSON reproduces P2 canonicalJson (Unicode, numbers, key order) or refuses', async () => {
      const vectors: unknown[] = [
        { b: 1, a: 2, B: 3, _: 4, aa: 5, 'a-b': 6, é: 7, Ω: 8, 中: 9, '\ud7ff': 10 },
        ['São Paulo', 'e\u0301', 'Ünïcödé', '😀 emoji', '中文', '\u2028\u2029', 'quote " and \\ backslash', 'tab\tnl\ncr\r\b\f', '\u0001\u001f\u007f', '/'],
        [0, -0, 1, -17, 9007199254740991, -9007199254740991, 1.5, -0.25, 0.1, 123.456, 0.000001, 2.5e3, 99999999999999.9, 0.3, 1e-6, 123456789012.345],
        { nested: { z: [true, false, null, { y: 'ÿ', x: [] }], a: {} }, '': 'empty key' },
      ];
      for (const v of vectors) {
        const row = (await db.query('SELECT anat_canonical_json($1::jsonb) AS c, anat_sha256($1::jsonb) AS h', [JSON.stringify(v)])).rows[0];
        assert.equal(row.c, canonicalJson(v)); assert.equal(row.h, sha256(canonicalJson(v)));
      }
      for (const raw of ['{"\ue000":1}', '{"😀":1}', '9007199254740993', '1e20', '1e21', '999999999999999.9', '1e-7', '0.10', '1.0000000000000002']) {
        await assert.rejects(db.query('SELECT anat_canonical_json($1::jsonb)', [raw]), /anat:CANONICAL_(KEY|NUMBER)_UNSUPPORTED/u, raw);
      }
    });

    await t.test('audit chain: ANAT events typed and flat; unregistered, extra field, foreign actor and tenant events refused', async () => {
      const ins = `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data) VALUES (NULL,'ADMIN',$1,$2,'anatomy_rules',$3,$4::jsonb)`;
      const id = randomUUID();
      // The guard of 074/075 still applies to the only role allowed to write ANAT rows.
      await fails(asWriter(A, ins, [A, 'ANAT_RULES_UNKNOWN', id, '{}']), /audit_event_not_registered/u);
      const projected = (await db.query(`SELECT audit_project('ANAT_RULES_REVIEWED','anatomy_rules',$1::jsonb) AS p`,
        [JSON.stringify({ reviewId: id, outcome: 'APPROVED', rationale: 'texto livre', comparisonCount: 2, nested: { a: 1 } })])).rows[0].p;
      assert.deepEqual(projected, { reviewId: id, outcome: 'APPROVED', comparisonCount: 2 });
      await fails(asWriter(A, ins, [A, 'ANAT_RULES_REVIEWED', id, JSON.stringify({ reviewId: id, rationale: 'texto livre' })]), /audit_field_not_allowed/u);
      await fails(asWriter(A, ins, ['admin@example.test', 'ANAT_RULES_REVIEWED', id, '{}']), /audit_invalid_actor|row-level security/u);
      await fails(asWriter(A, ins, [B, 'ANAT_RULES_REVIEWED', id, '{}']), /row-level security/u); // actor must be the session
      await fails(asWriter(N, ins, [N, 'ANAT_RULES_REVIEWED', id, '{}']), /row-level security/u); // session must be an admin
      await fails(asWriter(A, `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data)
        VALUES (NULL,'ADMIN',$1,'COMPANY_PURGED','company',$2,'{}')`, [A, id]), /row-level security/u); // no widening
      await asWriter(A, ins, [A, 'ANAT_RULES_REVIEWED', id, JSON.stringify({ reviewId: id, outcome: 'APPROVED' })]);
      assert.equal(await auditCount('entity_id=$1', [id]), 1);
      // radar_app cannot write ANAT rows directly, even as an admin (only through the audited entry functions).
      await fails(asApp(db, A, ins, [A, 'ANAT_RULES_REVIEWED', randomUUID(), JSON.stringify({ outcome: 'APPROVED' })]), /row-level security/u);
    });

    await t.test('P-INT-01: anat_list_audit is the only ANAT audit read path (fixed output, bounded limit, definer hygiene)', async () => {
      const fn = (await db.query(`SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, pg_get_function_result(p.oid) AS result,
        has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('radar_app', p.oid, 'EXECUTE') AS app,
        has_function_privilege('radar_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('radar_taxonomy_curator', p.oid, 'EXECUTE') AS curator
        FROM pg_proc p WHERE p.oid = 'public.anat_list_audit(integer)'::regprocedure`)).rows[0];
      assert.deepEqual(fn, { prosecdef: true, owner: 'anat_rules_writer', proconfig: ['search_path=pg_catalog, public, pg_temp'],
        result: 'TABLE(id uuid, action text, entity_id text, actor_id text, data jsonb, correlation_id uuid, occurred_at timestamp with time zone)',
        pub: false, app: true, worker: false, curator: false });
      const writer = (await db.query("SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname='anat_rules_writer'")).rows[0];
      assert.deepEqual(writer, { rolcanlogin: false, rolbypassrls: false, rolsuper: false });
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='audit_log' AND 'radar_app' = ANY(roles) AND policyname LIKE '%anat%'")).rows[0].n, 0,
        'no ANAT policy for radar_app on audit_log');
      for (const bad of [0, -1, 501, null]) await fails(asApp(db, A, 'SELECT * FROM anat_list_audit($1)', [bad]), 'LIMIT_EXCEEDED');
      await saveDraft(A, profiles('list'), [example('ex-list')]);
      assert.equal((await asApp(db, A, 'SELECT * FROM anat_list_audit(1)')).length, 1, 'limit honoured');
      // Worker and curator: no EXECUTE; and their direct reads never include ANAT rows (RESTRICTIVE policies of 078).
      await fails(asRole('radar_worker', db, A, 'SELECT * FROM anat_list_audit(10)'), /permission denied/u);
      await fails(asRole('radar_taxonomy_curator', db, A, 'SELECT * FROM anat_list_audit(10)'), /permission denied/u);
      for (const role of ['radar_worker', 'radar_taxonomy_curator']) assert.equal(await (async () => Number((await asRole(role, db, null,
        "SELECT count(*) AS n FROM audit_log WHERE entity_type='anatomy_rules'"))[0]!.n))(), 0, role);
      // TEMP shadowing: a session table named audit_log (and a hostile search_path) never reaches the entry point.
      const real = (await asApp(db, A, 'SELECT id FROM anat_list_audit(500)')).map((r) => r.id).sort();
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE radar_app');
        await db.query("SELECT set_config('app.user_id', $1, true)", [A]);
        await db.query(`CREATE TEMP TABLE audit_log ON COMMIT DROP AS SELECT gen_random_uuid() AS id, 'ANAT_RULES_DRAFT_SAVED'::text AS action,
          'x'::text AS entity_id, 'x'::text AS actor_id, '{}'::jsonb AS after_data, NULL::uuid AS correlation_id, now() AS occurred_at,
          NULL::uuid AS tenant_id, 'anatomy_rules'::text AS entity_type`);
        await db.query('SET LOCAL search_path = pg_temp, public');
        const seen = (await db.query('SELECT id FROM public.anat_list_audit(500)')).rows.map((r) => r.id).sort();
        assert.deepEqual(seen, real, 'the temporary table is ignored');
      } finally { await db.query('ROLLBACK'); }
    });

    await t.test('B1-R1-03: ANAT audit and admin tables are readable only by an active platform admin', async () => {
      const rd = await saveDraft(A, profiles('rls'), [example('ex-r')]);
      await freeze(A, rd.draft_id, 1);
      // P-INT-01: nobody reads ANAT audit rows of audit_log directly (radar_app has no policy for them); admins read them
      // only through anat_list_audit. Admin tables keep the B1 boundary (admin-only SELECT policy).
      const direct = async (role: string, actor: string | null) => Number((await asRole(role, db, actor,
        "SELECT count(*) AS n FROM audit_log WHERE entity_type='anatomy_rules'"))[0]!.n);
      const drafts = async (actor: string | null) => Number((await asApp(db, actor, 'SELECT count(*) AS n FROM anatomy_rule_drafts'))[0]!.n);
      const listed = async (actor: string | null) => (await asApp(db, actor, 'SELECT * FROM anat_list_audit(500)')).length;
      for (const actor of [A, null, N, R2]) assert.equal(await direct('radar_app', actor), 0, `direct audit read, actor ${actor}`);
      assert.ok(await listed(A) > 0 && await drafts(A) > 0, 'admin sees through the entry point and the admin tables');
      assert.equal(await drafts(null), 0, 'no session user'); await fails(listed(null), 'ACTOR_REQUIRED');
      assert.equal(await drafts(N), 0, 'authenticated, not admin'); await fails(listed(N), 'PLATFORM_ADMIN_REQUIRED');
      await db.query("UPDATE platform_user_roles SET revoked_at=now(), revoked_by='system:ci' WHERE user_id=$1", [R2]);
      assert.equal(await drafts(R2), 0, 'revoked admin'); await fails(listed(R2), 'PLATFORM_ADMIN_REQUIRED');
      await fails(saveDraft(R2, profiles('rls'), [example('ex-r')]), 'PLATFORM_ADMIN_REQUIRED');
      await db.query("UPDATE platform_user_roles SET revoked_at=NULL, revoked_by=NULL WHERE user_id=$1", [R2]);
      await fails(saveDraft(N, profiles('rls'), [example('ex-r')]), 'PLATFORM_ADMIN_REQUIRED');
      await fails(asApp(db, N, 'SELECT anat_audit_attempt($1,$2,$3,$4)', ['FREEZE', 'STALE_REVISION', null, randomUUID()]), 'PLATFORM_ADMIN_REQUIRED');
      // Other roles: curator sees nothing of the admin tables; worker only rule sets/activations (P3 §2.3).
      await fails(asRole('radar_taxonomy_curator', db, A, 'SELECT count(*) FROM anatomy_rule_drafts'), /permission denied/u);
      await fails(asRole('radar_worker', db, A, 'SELECT count(*) FROM anatomy_rule_drafts'), /permission denied/u);
      assert.ok(Number((await asRole('radar_worker', db, null, 'SELECT count(*) AS n FROM anatomy_rule_sets'))[0]!.n) > 0);
      // 009 (worker) and 018 (curator) already allow broad tenant_id NULL audit access; their policies stay as they are,
      // and two RESTRICTIVE ANAT-only policies keep them from writing or reading ANAT rows. Their own events still work.
      const ins = `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data) VALUES (NULL,'ADMIN',$1,'ANAT_RULES_REVIEWED','anatomy_rules',$2,'{}')`;
      for (const role of ['radar_worker', 'radar_taxonomy_curator']) {
        await fails(asRole(role, db, A, ins, [A, randomUUID()]), /row-level security/u);
        assert.equal(Number((await asRole(role, db, A, "SELECT count(*) AS n FROM audit_log WHERE entity_type='anatomy_rules'"))[0]!.n), 0, role);
      }
      const curatorEvent = randomUUID();
      await asRole('radar_taxonomy_curator', db, A, `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data)
        VALUES (NULL,'ADMIN',$1,'TAXONOMY_CURATION_CONCEPT_CREATED','taxonomy_curation',$2,'{}')`, [A, curatorEvent]);
      assert.equal(Number((await asRole('radar_taxonomy_curator', db, A, 'SELECT count(*) AS n FROM audit_log WHERE entity_id=$1', [curatorEvent]))[0]!.n), 1, 'curator events unchanged');
    });

    await t.test('drafts: revision lock, author only, examples validated (reserve, limit), one audit row per save', async () => {
      const corr = randomUUID();
      const d = await saveDraft(A, profiles('d1'), [example('ex-1')], null, null, corr);
      assert.equal(d.revision, 1);
      assert.equal(await auditCount("correlation_id=$1 AND action='ANAT_RULES_DRAFT_SAVED'", [corr]), 1);
      const audit = (await db.query('SELECT after_data FROM audit_log WHERE correlation_id=$1', [corr])).rows[0].after_data;
      assert.deepEqual(audit, { draftId: d.draft_id, revision: 1, profileSetHash: sha256(canonicalJson(profiles('d1'))),
        exampleSetHash: sha256(canonicalJson([example('ex-1')])) });
      assert.equal((await saveDraft(A, profiles('d1b'), [example('ex-1')], d.draft_id, 1)).revision, 2);
      await fails(saveDraft(A, profiles('d1c'), [example('ex-1')], d.draft_id, 1), 'STALE_REVISION');
      await fails(saveDraft(B, profiles('d1c'), [example('ex-1')], d.draft_id, 2), 'DRAFT_NOT_FOUND');
      await fails(saveDraft(A, profiles('r'), [example('12')]), 'RESERVED_EXAMPLE_ID');
      await fails(saveDraft(A, profiles('r'), Array.from({ length: 21 }, (_, i) => example(`x${i}`))), 'LIMIT_EXCEEDED');
      await fails(saveDraft(A, profiles('r'), [example('x'), example('x')]), 'DUPLICATE_EXAMPLE_ID');
      await fails(saveDraft(null as unknown as string, profiles('r'), [example('x')]), 'ACTOR_REQUIRED');
    });

    await t.test('criterion 5: idempotent freeze never rewrites content or authorship; changed hashes create new candidates', async () => {
      const p = profiles('freeze'); const ex = [example('ex-f')];
      const d = await saveDraft(A, p, ex);
      const corr = randomUUID();
      const first = await freeze(A, d.draft_id, 1, E, corr);
      assert.equal(first.created, true);
      const again = await freeze(A, d.draft_id, 1, E, randomUUID());
      assert.deepEqual(again, { candidate_id: first.candidate_id, created: false });
      assert.equal(await auditCount("action='ANAT_RULES_CANDIDATE_FROZEN' AND entity_id=$1", [first.candidate_id]), 1);
      const snap = (await db.query('SELECT * FROM anatomy_rule_sets WHERE rule_hash=$1', [sha256(canonicalJson(p))])).rows;
      assert.equal(snap.length, 1); assert.equal(snap[0].author, A);
      // Same profiles frozen by another author from another draft: same snapshot, original authorship kept.
      const dB = await saveDraft(B, p, ex);
      const byB = await freeze(B, dB.draft_id, 1);
      assert.equal(byB.candidate_id, first.candidate_id); assert.equal(byB.created, false);
      const after = (await db.query('SELECT author, frozen_from_draft, profiles FROM anatomy_rule_sets WHERE rule_hash=$1', [sha256(canonicalJson(p))])).rows[0];
      assert.deepEqual(after, { author: A, frozen_from_draft: d.draft_id, profiles: p });
      assert.equal((await db.query('SELECT draft_author FROM anatomy_rule_candidates WHERE id=$1', [first.candidate_id])).rows[0].draft_author, A);
      // Changed examples → new candidate on the same snapshot; changed engine → new candidate.
      const d2 = await saveDraft(A, p, [example('ex-f'), example('ex-g')]);
      const other = await freeze(A, d2.draft_id, 1);
      assert.notEqual(other.candidate_id, first.candidate_id);
      const engine2 = await freeze(A, d.draft_id, 1, E2);
      assert.equal(engine2.created, true); assert.notEqual(engine2.candidate_id, first.candidate_id);
      await fails(freeze(A, d.draft_id, 7), 'STALE_REVISION');
      await fails(freeze(B, d.draft_id, 1), 'DRAFT_NOT_FOUND');
    });

    await t.test('criterion 4: editing the draft after freeze changes nothing frozen; provenance is never re-read', async () => {
      const s = await scenario();
      const before = (await db.query(`SELECT c.*, s.profiles, e.examples FROM anatomy_rule_candidates c JOIN anatomy_rule_sets s ON s.id=c.rule_set_id
        JOIN anatomy_rule_example_sets e ON e.id=c.example_set_id WHERE c.id=$1`, [s.cand])).rows[0];
      await saveDraft(A, profiles('edited'), [example('ex-z')], s.draftId, 1);
      const after = (await db.query(`SELECT c.*, s.profiles, e.examples FROM anatomy_rule_candidates c JOIN anatomy_rule_sets s ON s.id=c.rule_set_id
        JOIN anatomy_rule_example_sets e ON e.id=c.example_set_id WHERE c.id=$1`, [s.cand])).rows[0];
      assert.deepEqual(after, before);
      assert.equal(after.draft_revision, 1); assert.deepEqual(after.profiles, s.p);
      // author != reviewer still uses the frozen draft_author (A), not the live draft.
      await fails(review(A, s.cand, s.sim, s.comps, s.decisions), 'AUTHOR_CANNOT_REVIEW');
      assert.ok(await review(R, s.cand, s.sim, s.comps, s.decisions));
    });

    await t.test('author != reviewer for draft author, freezer and snapshot author', async () => {
      const s = await scenario({ author: B });
      await fails(review(B, s.cand, s.sim, s.comps, s.decisions), 'AUTHOR_CANNOT_REVIEW');
      // Frozen by A from B's identical content: A is the snapshot author AND the candidate creator? No: the candidate
      // already exists (created by B), so A gains nothing; A is still blocked if A authored the snapshot.
      const dA = await saveDraft(A, profiles('shared-author'), [example('ex-s')]);
      const fA = await freeze(A, dA.draft_id, 1);
      const dB = await saveDraft(B, profiles('shared-author'), [example('ex-s'), example('ex-t')]);
      const fB = await freeze(B, dB.draft_id, 1); // new candidate by B on A's snapshot
      assert.notEqual(fA.candidate_id, fB.candidate_id);
      nonce += 1;
      const rows = [run('ex-s'), run('ex-t')];
      const sim = await simulate(B, fB.candidate_id, rows);
      await fails(review(A, fB.candidate_id, sim, [], [], 'rejected'), 'AUTHOR_CANNOT_REVIEW');
    });

    await t.test('approval rules (§2.5): every gap refused; the complete path accepted', async () => {
      const s = await scenario();
      const fork = async (rows: ReturnType<typeof run>[], status = 'complete') => simulate(A, s.cand, rows, status);
      // (2) simulation not passing: fail, partial, cancelled, inconclusive, failed, missing example, status partial.
      for (const outcome of ['fail', 'partial', 'cancelled', 'inconclusive', 'failed']) {
        const sim = await fork([{ ...s.rows[0]!, outcome }, s.rows[1]!]);
        await fails(review(R, s.cand, sim, s.comps, s.decisions), 'SIMULATION_NOT_PASSING');
      }
      await fails(review(R, s.cand, await fork([s.rows[0]!]), s.comps, s.decisions), 'SIMULATION_NOT_PASSING');
      await fails(review(R, s.cand, await fork(s.rows, 'partial'), s.comps, s.decisions), 'SIMULATION_NOT_PASSING');
      // Simulation of another candidate: structural FK (same candidate).
      const other = await scenario();
      await fails(review(R, s.cand, other.sim, s.comps, s.decisions), /anatomy_rule_reviews_simulation_id_candidate_id_fkey|foreign key/u);
      // (3) comparison coverage and binding.
      await fails(review(R, s.cand, s.sim, [s.comps[0]!], s.decisions.slice(0, 1)), 'REVIEW_INCOMPLETE');
      await fails(review(R, s.cand, s.sim, [s.comps[0]!, other.comps[1]!], s.decisions.slice(0, 1)), /foreign key/u);
      // criterion 1: an envelope for the right candidate/example/engine/base but NOT what this simulation executed.
      const foreignRun = { ...s.rows[1]!, outputHash: h('other output'), analysisId: h('other analysis') };
      const stray = envelope({ sim: foreignRun, before: s.base.hash, after: s.ruleHash });
      const strayCmp = (await compare(A, s.cand, 'ex-b', s.base, stray)).comparison_id;
      const strayDecisions = [s.decisions[0]!, ...stray.differences.map((d) => ({ comparisonId: strayCmp, differenceId: d.id, decision: 'expected' }))];
      await fails(review(R, s.cand, s.sim, [s.comps[0]!, strayCmp], strayDecisions), 'COMPARISON_MISMATCH');
      const otherInput = envelope({ sim: { ...s.rows[1]!, inputTextHash: h('another input') }, before: s.base.hash, after: s.ruleHash });
      const inputCmp = (await compare(A, s.cand, 'ex-b', s.base, otherInput)).comparison_id;
      await fails(review(R, s.cand, s.sim, [s.comps[0]!, inputCmp], [s.decisions[0]!, ...otherInput.differences.map((d) => ({ comparisonId: inputCmp, differenceId: d.id, decision: 'expected' }))]), 'COMPARISON_MISMATCH');
      // Two comparisons for the same example (and none for the other).
      await fails(review(R, s.cand, s.sim, [s.comps[1]!, inputCmp], []), 'REVIEW_INCOMPLETE');
      // Recording refuses another example, another engine, a swapped base, a foreign candidate's profiles.
      await fails(compare(A, s.cand, 'ex-zz', s.base, s.envs[0]), 'COMPARISON_MISMATCH');
      await fails(compare(A, s.cand, 'ex-a', s.base, envelope({ sim: s.rows[0]!, before: s.base.hash, after: s.ruleHash, engine: E2 })), 'COMPARISON_MISMATCH');
      await fails(compare(A, s.cand, 'ex-a', other.base, s.envs[0]), 'COMPARISON_MISMATCH');
      await fails(compare(A, s.cand, 'ex-a', s.base, envelope({ sim: s.rows[0]!, before: s.base.hash, after: other.ruleHash })), 'COMPARISON_MISMATCH');
      await fails(compare(A, s.cand, 'ex-a', s.base, { ...s.envs[0]!, id: h('forged') }), 'COMPARISON_MISMATCH');
      // (4) decisions: missing, regression, not_evaluated, unknown id, duplicate.
      await fails(review(R, s.cand, s.sim, s.comps, s.decisions.slice(1)), 'REVIEW_INCOMPLETE');
      for (const decision of ['regression', 'not_evaluated']) {
        await fails(review(R, s.cand, s.sim, s.comps, [{ ...s.decisions[0]!, decision }, ...s.decisions.slice(1)]), 'REVIEW_INCOMPLETE');
      }
      await fails(review(R, s.cand, s.sim, s.comps, [...s.decisions, { ...s.decisions[0]!, differenceId: 'f'.repeat(32) }]), 'REVIEW_INCOMPLETE');
      await fails(review(R, s.cand, s.sim, s.comps, [...s.decisions, s.decisions[0]!]), /duplicate key/u);
      // No direct INSERT for radar_app; and even the writer role cannot skip the rules: the deferred trigger re-checks at COMMIT.
      const directReview = `INSERT INTO anatomy_rule_reviews (candidate_id, simulation_id, reviewer, outcome, rationale)
        VALUES ($1,$2,$3,'approved','Sem vínculos de comparação.')`;
      await fails(asApp(db, R, directReview, [s.cand, s.sim, R]), /permission denied/u);
      await fails(asWriter(R, directReview, [s.cand, s.sim, R]), 'REVIEW_INCOMPLETE');
      assert.equal(Number((await db.query("SELECT count(*) FROM anatomy_rule_reviews WHERE candidate_id=$1", [s.cand])).rows[0].count), 0);
      // Valid path.
      const corr = randomUUID();
      const ok = await review(R, s.cand, s.sim, s.comps, s.decisions, 'approved', corr);
      assert.deepEqual((await db.query('SELECT after_data FROM audit_log WHERE correlation_id=$1', [corr])).rows[0].after_data,
        { reviewId: ok, candidateId: s.cand, simulationId: s.sim, outcome: 'APPROVED', comparisonCount: 2, decisionCount: 2 });
      assert.equal((await db.query('SELECT rationale FROM anatomy_rule_reviews WHERE id=$1', [ok])).rows[0].rationale, 'Revisão sintética suficiente.');
      assert.equal(await auditCount("after_data::text LIKE '%Revisão%'"), 0, 'rationale never reaches audit_log');
    });

    await t.test('B1-R2-01: a session TEMP table cannot shadow any domain table of the privileged chain (fresh connections)', async () => {
      const s = await scenario();
      const failing = await simulate(A, s.cand, [{ ...s.rows[0]!, outcome: 'fail' }, s.rows[1]!]);
      const shadowable = ['anatomy_rule_reviews', 'anatomy_rule_simulations', 'anatomy_rule_simulation_examples', 'anatomy_rule_candidates',
        'anatomy_rule_example_sets', 'anatomy_rule_comparisons', 'anatomy_rule_comparison_envelopes', 'anatomy_rule_review_comparisons',
        'anatomy_rule_review_decisions', 'anatomy_rule_sets', 'anatomy_rule_activations', 'anatomy_rule_activation_previews', 'audit_log'];
      /** New connection; as radar_app (admin R) create empty TEMP copies granted to the writer, then run `sql` in one transaction. */
      async function shadowed(tables: string[], sql: string, params: unknown[]): Promise<Row[]> {
        const c = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
        await c.connect();
        try {
          await c.query('SET ROLE radar_app');
          await c.query("SELECT set_config('app.user_id', $1, false)", [R]);
          for (const table of tables) {
            await c.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
            await c.query(`GRANT SELECT, INSERT ON pg_temp.${table} TO anat_rules_writer`);
          }
          await c.query('BEGIN');
          try { const r = (await c.query(sql, params)).rows; await c.query('COMMIT'); return r; } catch (error) { await c.query('ROLLBACK'); throw error; }
        } finally { await c.end(); }
      }
      const approve = 'SELECT anat_record_review($1,$2,$3,$4,$5::uuid[],$6::jsonb,$7) AS id';
      const invalid = [s.cand, failing, 'approved', 'Aprovação indevida via TEMP.', [], '[]', randomUUID()];
      const approvedOn = async (sim: string) => Number((await db.query("SELECT count(*) FROM anatomy_rule_reviews WHERE simulation_id=$1 AND outcome='approved'", [sim])).rows[0].count);
      // Control without TEMP: refused.
      await fails(review(R, s.cand, failing, [], []), 'SIMULATION_NOT_PASSING');
      // The reproduced case (anatomy_rule_reviews shadowed; it approved and committed on 9ce09ff) and every other table.
      for (const table of shadowable) {
        await assert.rejects(shadowed([table], approve, invalid), /anat:/u, `${table} shadow`);
        assert.equal(await approvedOn(failing), 0, `${table}: no approval persisted`);
      }
      await assert.rejects(shadowed(shadowable, approve, invalid), /anat:/u, 'all tables shadowed at once');
      assert.equal(await approvedOn(failing), 0);
      // Valid control with every table shadowed: the real (public) proof is used and the approval is recorded once.
      const ok = await shadowed(shadowable, approve, [s.cand, s.sim, 'approved', 'Revisão sintética suficiente.', s.comps, JSON.stringify(s.decisions), randomUUID()]);
      assert.equal(await approvedOn(s.sim), 1);
      assert.equal((await db.query('SELECT reviewer FROM anatomy_rule_reviews WHERE id=$1', [ok[0]!.id])).rows[0].reviewer, R);
      assert.equal(await auditCount("action='ANAT_RULES_REVIEWED' AND entity_id=$1", [ok[0]!.id]), 1);
      // Missing required records are explicit refusals (no NULL pass-through), and rejected reviews keep working.
      await fails(asWriter(R, 'SELECT anat_assert_approval($1)', [randomUUID()]), 'REVIEW_NOT_FOUND');
      assert.ok(await review(R, s.cand, failing, [], [], 'rejected'));
    });

    await t.test('criterion 2: identical envelopes are stored once; every candidate keeps its own association', async () => {
      const p = profiles('dedupe'); const ruleHash = sha256(canonicalJson(p));
      const base = await scenario();
      const d1 = await saveDraft(A, p, [example('ex-a')]); const c1 = await freeze(A, d1.draft_id, 1);
      const d2 = await saveDraft(A, p, [example('ex-a'), example('ex-b')]); const c2 = await freeze(A, d2.draft_id, 1);
      assert.notEqual(c1.candidate_id, c2.candidate_id);
      const r = run('ex-a');
      const env = envelope({ sim: r, before: base.base.hash, after: ruleHash });
      const k1 = await compare(A, c1.candidate_id, 'ex-a', base.base, env);
      const k2 = await compare(A, c2.candidate_id, 'ex-a', base.base, env);
      assert.notEqual(k1.comparison_id, k2.comparison_id);
      assert.equal(Number((await db.query('SELECT count(*) FROM anatomy_rule_comparison_envelopes WHERE comparison_hash=$1', [env.id])).rows[0].count), 1);
      assert.deepEqual((await db.query('SELECT candidate_id FROM anatomy_rule_comparisons WHERE comparison_hash=$1 ORDER BY candidate_id', [env.id])).rows
        .map((x) => x.candidate_id), [c1.candidate_id, c2.candidate_id].sort());
      const replay = await compare(A, c1.candidate_id, 'ex-a', base.base, env);
      assert.deepEqual(replay, { comparison_id: k1.comparison_id, created: false });
      assert.equal(await auditCount("action='ANAT_RULES_COMPARED' AND after_data->>'comparisonHash'=$1", [env.id]), 2);
      // Both associations are usable by their own reviews.
      const sim1 = await simulate(A, c1.candidate_id, [r]);
      assert.ok(await review(R, c1.candidate_id, sim1, [k1.comparison_id], env.differences.map((d) => ({ comparisonId: k1.comparison_id, differenceId: d.id, decision: 'expected' }))));
    });

    // Activation ------------------------------------------------------------------------------------------------------
    const token = () => randomBytes(32).toString('base64url');
    const preview = (actor: string, s: { cand: string }, rev: string, scope: string, tok: string, action = 'activate', engine = E) =>
      one(db, actor, 'SELECT * FROM anat_preview($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
        [action, s.cand, rev, scope, engine, h(tok), JSON.stringify({ publications: { status: 'synthetic' }, analyses: 'unsupported' }), randomUUID()]);
    const confirm = (c: pg.Client, actor: string, tok: string, intent: string, engine = E, iso = 'SERIALIZABLE') =>
      asApp(c, actor, 'SELECT * FROM anat_confirm($1,$2,$3,$4,$5)', [h(tok), intent, engine, 'Ativação sintética justificada.', randomUUID()], iso).then((r) => r[0]!);
    async function confirmRetry(c: pg.Client, actor: string, tok: string, intent: string): Promise<Row> {
      for (let attempt = 1; ; attempt += 1) {
        try { return await confirm(c, actor, tok, intent); } catch (error) {
          if ((error as { code?: string }).code !== '40001' || attempt === 3) throw error;
        }
      }
    }
    async function approved(tag?: string) { const s = await scenario({ tag }); return { ...s, rev: await review(R, s.cand, s.sim, s.comps, s.decisions) }; }

    await t.test('criterion 3: preview/confirm tokens — first activation, replay, wrong/expired/foreign/stale refused', async () => {
      const scope = 'scope-tokens';
      const s = await approved();
      await fails(preview(R, s, s.rev, scope, token(), 'activate', E2), 'ENGINE_MISMATCH');
      const tok = token();
      const pv = await preview(R, s, s.rev, scope, tok);
      assert.equal(await auditCount("action='ANAT_RULES_ACTIVATION_PREVIEWED' AND entity_id=$1", [pv.preview_id]), 1);
      await fails(confirm(db, R, token(), pv.intent_hash), 'PREVIEW_EXPIRED'); // wrong token
      await fails(confirm(db, R2, tok, pv.intent_hash), 'PREVIEW_EXPIRED'); // other actor
      await fails(confirm(db, R, tok, h('other intent')), 'PREVIEW_STALE'); // other intent
      await fails(confirm(db, R, tok, pv.intent_hash, E2), 'ENGINE_MISMATCH');
      const first = await confirm(db, R, tok, pv.intent_hash);
      assert.equal(first.replayed, false);
      const act = (await db.query('SELECT * FROM anatomy_rule_activations WHERE id=$1', [first.activation_id])).rows[0];
      assert.equal(act.previous_activation_id, null); assert.equal(act.superseded_at, null);
      const audited = (await db.query("SELECT after_data FROM audit_log WHERE action='ANAT_RULES_ACTIVATED' AND entity_id=$1", [first.activation_id])).rows;
      assert.deepEqual(audited, [{ after_data: { activationId: first.activation_id, candidateId: s.cand, reviewId: s.rev, previewId: pv.preview_id, action: 'ACTIVATE' } }]);
      // Replay with the same token, actor and intent: same activation, nothing new.
      const auditsBefore = await auditCount();
      const replay = await confirm(db, R, tok, pv.intent_hash);
      assert.deepEqual(replay, { activation_id: first.activation_id, replayed: true });
      assert.equal(await auditCount(), auditsBefore);
      assert.equal(Number((await db.query('SELECT count(*) FROM anatomy_rule_activations WHERE scope=$1', [scope])).rows[0].count), 1);
      await fails(confirm(db, R2, tok, pv.intent_hash), 'PREVIEW_EXPIRED');
      await fails(confirm(db, R, tok, h('x')), 'PREVIEW_STALE');
      // Stale: a preview observed "no activation", but one now exists.
      const tok2 = token();
      const stalePv = await preview(R, s, s.rev, 'scope-stale', tok2);
      const other = await approved();
      const tok3 = token();
      const otherPv = await preview(R, other, other.rev, 'scope-stale', tok3);
      await confirm(db, R, tok3, otherPv.intent_hash);
      await fails(confirm(db, R, tok2, stalePv.intent_hash), 'PREVIEW_STALE');
      // Expired and unconsumed (row written directly by the owner with past times; intent computed by the same function).
      const tok4 = token();
      await inTx(null, R, async (q) => { await q(`INSERT INTO anatomy_rule_activation_previews (token_hash, action, actor, scope, candidate_id, review_id, observed_activation_id,
        intent_hash, affected_scope, created_at, expires_at)
        SELECT $1,'activate',$2,$3,$4,$5,$6, anat_intent_hash('activate',$4,$5,$6,$3, now()-interval '1 minute'), '{}', now()-interval '11 minutes', now()-interval '1 minute'`,
      [h(tok4), R, scope, s.cand, s.rev, first.activation_id]); });
      const expiredIntent = (await db.query('SELECT intent_hash FROM anatomy_rule_activation_previews WHERE token_hash=$1', [h(tok4)])).rows[0].intent_hash;
      await fails(confirm(db, R, tok4, expiredIntent), 'PREVIEW_EXPIRED');
      // Second activation supersedes; rollback returns to the first candidate without reprocessing.
      const next = await approved();
      const tok5 = token(); const pv5 = await preview(R, next, next.rev, scope, tok5);
      const second = await confirm(db, R, tok5, pv5.intent_hash);
      const rows = (await db.query('SELECT id, previous_activation_id, superseded_at IS NOT NULL AS superseded FROM anatomy_rule_activations WHERE scope=$1 ORDER BY activated_at', [scope])).rows;
      assert.deepEqual(rows, [{ id: first.activation_id, previous_activation_id: null, superseded: true },
        { id: second.activation_id, previous_activation_id: first.activation_id, superseded: false }]);
      await fails(preview(R, next, next.rev, scope, token(), 'rollback'), 'PREVIEW_STALE'); // never active before
      const tok6 = token(); const pv6 = await preview(R, s, s.rev, scope, tok6, 'rollback');
      const back = await confirm(db, R, tok6, pv6.intent_hash);
      assert.equal((await db.query('SELECT kind, candidate_id FROM anatomy_rule_activations WHERE id=$1', [back.activation_id])).rows[0].candidate_id, s.cand);
      // The raw token is stored nowhere (domain tables or audit).
      for (const raw of [tok, tok2, tok3, tok5, tok6]) {
        const hits = await db.query(`SELECT count(*) FROM (SELECT row_to_json(x)::text t FROM anatomy_rule_activation_previews x UNION ALL
          SELECT row_to_json(y)::text FROM anatomy_rule_activations y UNION ALL SELECT row_to_json(z)::text FROM audit_log z) all_rows WHERE t LIKE '%' || $1 || '%'`, [raw]);
        assert.equal(Number(hits.rows[0].count), 0);
      }
    });

    await t.test('concurrency: two confirms of one token give one activation; two previews of one state give one winner', async () => {
      const s = await approved();
      const tok = token(); const pv = await preview(R, s, s.rev, 'scope-race', tok);
      const auditsBefore = await auditCount("action='ANAT_RULES_ACTIVATED'");
      const [x, y] = await Promise.all([confirmRetry(db, R, tok, pv.intent_hash), confirmRetry(db2, R, tok, pv.intent_hash)]);
      assert.equal(x.activation_id, y.activation_id);
      assert.deepEqual([x.replayed, y.replayed].sort(), [false, true]);
      assert.equal(Number((await db.query("SELECT count(*) FROM anatomy_rule_activations WHERE scope='scope-race'")).rows[0].count), 1);
      assert.equal(await auditCount("action='ANAT_RULES_ACTIVATED'"), auditsBefore + 1);
      const u = await approved(); const v = await approved();
      const tu = token(); const tv = token();
      const pu = await preview(R, u, u.rev, 'scope-race-2', tu); const pw = await preview(R, v, v.rev, 'scope-race-2', tv);
      const results = await Promise.allSettled([confirmRetry(db, R, tu, pu.intent_hash), confirmRetry(db2, R, tv, pw.intent_hash)]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(lost.reason), /anat:PREVIEW_STALE/u);
      assert.equal(Number((await db.query("SELECT count(*) FROM anatomy_rule_activations WHERE scope='scope-race-2'")).rows[0].count), 1);
    });

    await t.test('B1-R1-01: granted surface preserves the flow — direct DML refused for radar_app and checked for any writer', async () => {
      // 1. Session B updates A's draft with a correct revision increment.
      const d = await saveDraft(A, profiles('own'), [example('ex-o')]);
      const upd = 'UPDATE anatomy_rule_drafts SET profiles=$2::jsonb, revision=revision+1 WHERE id=$1';
      await fails(asApp(db, B, upd, [d.draft_id, JSON.stringify(profiles('stolen'))]), /permission denied/u);
      await fails(asWriter(B, upd, [d.draft_id, JSON.stringify(profiles('stolen'))]), 'ACTOR_MISMATCH');
      await fails(inTx(null, B, async (q) => { await q(upd, [d.draft_id, JSON.stringify(profiles('stolen'))]); }), 'ACTOR_MISMATCH'); // owner too
      await fails(saveDraft(B, profiles('stolen'), [example('ex-o')], d.draft_id, 1), 'DRAFT_NOT_FOUND');
      await fails(asApp(db, A, `INSERT INTO anatomy_rule_drafts (author, profiles, examples, revision) VALUES ($1,'[]','[{"id":"x"}]',1)`, [A]), /permission denied/u);
      await fails(asWriter(A, `INSERT INTO anatomy_rule_drafts (author, profiles, examples, revision) VALUES ($1,'[]','[{"id":"x"}]',1)`, [B]), 'ACTOR_MISMATCH');
      assert.deepEqual((await db.query('SELECT profiles, revision FROM anatomy_rule_drafts WHERE id=$1', [d.draft_id])).rows[0], { profiles: profiles('own'), revision: 1 });
      // 2. Direct activation with an expired, consumed, foreign or mismatched preview.
      const s = await approved(); const other = await approved();
      const tok = token(); const pv = await preview(R, s, s.rev, 'scope-direct', tok);
      const insAct = `INSERT INTO anatomy_rule_activations (id, scope, candidate_id, review_id, kind, preview_id, affected_scope, actor, justification)
        VALUES ($1,$2,$3,$4,'activate',$5,'{}',$6,'Ativação direta indevida.')`;
      const consume = 'UPDATE anatomy_rule_activation_previews SET consumed_at=now(), consumed_activation_id=$2 WHERE id=$1';
      await fails(asApp(db, R, insAct, [randomUUID(), 'scope-direct', s.cand, s.rev, pv.preview_id, R]), /permission denied/u);
      await fails(inTx('anat_rules_writer', R, async (q) => { await q(insAct, [randomUUID(), 'scope-direct', s.cand, s.rev, pv.preview_id, R]); }), 'PREVIEW_REQUIRED');
      await fails(inTx('anat_rules_writer', R, async (q) => { const id = randomUUID();
        await q(insAct, [id, 'scope-other', s.cand, s.rev, pv.preview_id, R]); await q(consume, [pv.preview_id, id]); }), 'PREVIEW_STALE'); // other scope
      await fails(inTx('anat_rules_writer', R, async (q) => { const id = randomUUID();
        await q(insAct, [id, 'scope-direct', other.cand, other.rev, pv.preview_id, R]); await q(consume, [pv.preview_id, id]); }), 'PREVIEW_STALE'); // other candidate
      await fails(inTx('anat_rules_writer', R2, async (q) => { const id = randomUUID();
        await q(insAct, [id, 'scope-direct', s.cand, s.rev, pv.preview_id, R2]); await q(consume, [pv.preview_id, id]); }), 'PREVIEW_EXPIRED'); // other actor
      const tokE = token();
      await inTx(null, R, async (q) => { await q(`INSERT INTO anatomy_rule_activation_previews (token_hash, action, actor, scope, candidate_id, review_id,
        intent_hash, affected_scope, created_at, expires_at) VALUES ($1,'activate',$2,'scope-direct',$3,$4,$5,'{}', now()-interval '11 minutes', now()-interval '1 minute')`,
      [h(tokE), R, s.cand, s.rev, h('expired intent')]); });
      const expired = (await db.query('SELECT id FROM anatomy_rule_activation_previews WHERE token_hash=$1', [h(tokE)])).rows[0].id;
      await fails(inTx('anat_rules_writer', R, async (q) => { const id = randomUUID();
        await q(insAct, [id, 'scope-direct', s.cand, s.rev, expired, R]); await q(consume, [expired, id]); }), 'PREVIEW_EXPIRED');
      const first = await confirm(db, R, tok, pv.intent_hash);
      await fails(inTx('anat_rules_writer', R, async (q) => { await q(insAct, [randomUUID(), 'scope-direct-2', s.cand, s.rev, pv.preview_id, R]); }), /duplicate key/u); // consumed
      assert.equal(Number((await db.query("SELECT count(*) FROM anatomy_rule_activations WHERE scope LIKE 'scope-direct%' OR scope='scope-other'")).rows[0].count), 1);
      // 3. Superseding the only active activation without an audited replacement fails at COMMIT (writer and owner).
      const supersede = 'UPDATE anatomy_rule_activations SET superseded_at=now() WHERE id=$1';
      await fails(asApp(db, R, supersede, [first.activation_id]), /permission denied/u);
      await fails(asWriter(R, supersede, [first.activation_id]), 'REPLACEMENT_REQUIRED');
      await fails(inTx(null, R, async (q) => { await q(supersede, [first.activation_id]); }), 'REPLACEMENT_REQUIRED');
      assert.equal((await db.query('SELECT superseded_at FROM anatomy_rule_activations WHERE id=$1', [first.activation_id])).rows[0].superseded_at, null);
      // 5. The author's session inserting a review attributed to a third party.
      const insReview = `INSERT INTO anatomy_rule_reviews (candidate_id, simulation_id, reviewer, outcome, rationale) VALUES ($1,$2,$3,'rejected','Atribuída a terceiro.')`;
      await fails(asApp(db, A, insReview, [s.cand, s.sim, R2]), /permission denied/u);
      await fails(asWriter(A, insReview, [s.cand, s.sim, R2]), 'ACTOR_MISMATCH');
      await fails(inTx(null, A, async (q) => { await q(insReview, [s.cand, s.sim, R2]); }), 'ACTOR_MISMATCH');
      // Every other provenance field is bound to the session as well.
      await fails(asWriter(A, `INSERT INTO anatomy_rule_comparisons (comparison_hash, candidate_id, example_id, baseline_rule_set_id, baseline_rule_hash, created_by)
        VALUES ($1,$2,'ex-a',$3,$4,$5)`, [s.envs[0]!.id, s.cand, s.base.id, s.base.hash, B]), 'ACTOR_MISMATCH');
      // No direct audit row from radar_app (only through the entry points).
      await fails(asApp(db, A, `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data)
        VALUES (NULL,'ADMIN',$1,'ANAT_RULES_ACTIVATED','anatomy_rules',$2,'{}')`, [A, randomUUID()]), /row-level security/u);
    });

    await t.test('B1-R1-02: an approved simulation is sealed; rows, counters and report hash agree at COMMIT', async () => {
      const s = await approved();
      const extra = (id: string, outcome: string) => [s.sim, id, outcome, E];
      // Executed outcomes carry their hashes (table CHECK); 'failed'/'cancelled' may omit them.
      const ins = `INSERT INTO anatomy_rule_simulation_examples (simulation_id, example_id, outcome, engine_hash, input_text_hash, output_hash, analysis_id, rule_set_hash)
        SELECT $1, $2, $3, $4, h, h, h, h FROM (SELECT CASE WHEN $3 IN ('failed','cancelled') THEN NULL ELSE repeat('a', 64) END AS h) x`;
      await fails(asApp(db, A, ins, extra('ex-new', 'failed')), /permission denied/u);
      await fails(asWriter(A, ins, extra('ex-new', 'failed')), 'SIMULATION_SEALED');
      await fails(inTx(null, A, async (q) => { await q(ins, extra('ex-new', 'failed')); }), 'SIMULATION_SEALED'); // owner too
      await fails(asWriter(A, ins, extra('ex-a', 'failed')), 'SIMULATION_SEALED');
      // A partial simulation (2 of 3 examples) cannot be completed later with the missing, valid example id.
      nonce += 1;
      const d = await saveDraft(A, profiles(`seal-${nonce}`), ['ex-a', 'ex-b', 'ex-c'].map(example));
      const f = await freeze(A, d.draft_id, 1);
      const partial = await simulate(A, f.candidate_id, [run('ex-a'), run('ex-b')], 'partial');
      await fails(asWriter(A, ins, [partial, 'ex-c', 'pass', E]), 'SIMULATION_SEALED');
      assert.equal(Number((await db.query('SELECT count(*) FROM anatomy_rule_simulation_examples WHERE simulation_id=$1', [partial])).rows[0].count), 2);
      // The review over the sealed proof still passes every rule, and activation re-validates it.
      const tokS = token(); const pvS = await preview(R, s, s.rev, 'scope-seal', tokS);
      assert.equal((await confirm(db, R, tokS, pvS.intent_hash)).replayed, false);
      // Counters, rows and report hash must agree (writer inserting a simulation directly with forged counters).
      const insSim = `INSERT INTO anatomy_rule_simulations (id, candidate_id, report, report_hash, status, pass_count, fail_count, partial_count,
        cancelled_count, inconclusive_count, example_count, requested_by) VALUES ($1,$2,'{}',$3,'complete',$4,0,0,0,0,$5,$6)`;
      const goodHash = sha256(canonicalJson({}));
      await fails(inTx('anat_rules_writer', A, async (q) => { const id = randomUUID();
        await q(insSim, [id, f.candidate_id, goodHash, 3, 3, A]); await q(ins, [id, 'ex-a', 'fail', E]); await q(ins, [id, 'ex-b', 'pass', E]); await q(ins, [id, 'ex-c', 'pass', E]); }), 'SIMULATION_INCONSISTENT');
      await fails(inTx('anat_rules_writer', A, async (q) => { const id = randomUUID();
        await q(insSim, [id, f.candidate_id, goodHash, 1, 2, A]); await q(ins, [id, 'ex-a', 'pass', E]); }), 'SIMULATION_INCONSISTENT'); // missing row
      await fails(inTx('anat_rules_writer', A, async (q) => { const id = randomUUID();
        await q(insSim, [id, f.candidate_id, h('forged report'), 1, 1, A]); await q(ins, [id, 'ex-a', 'pass', E]); }), 'SIMULATION_INCONSISTENT'); // report hash
      await fails(inTx('anat_rules_writer', A, async (q) => { const id = randomUUID();
        await q(insSim, [id, f.candidate_id, goodHash, 1, 1, A]); await q(ins, [id, 'ex-zz', 'pass', E]); }), 'INVALID_EXAMPLE');
      await fails(inTx('anat_rules_writer', A, async (q) => { const id = randomUUID();
        await q(insSim, [id, f.candidate_id, goodHash, 1, 1, A]); await q(ins, [id, 'ex-a', 'pass', E2]); }), 'ENGINE_MISMATCH');
    });

    await t.test('immutability: UPDATE/DELETE/TRUNCATE refused for radar_app (grants) and for the owner (triggers)', async () => {
      const s = await approved();
      const immutable: [string, string][] = [['anatomy_rule_sets', `rule_hash='${s.ruleHash}'`], ['anatomy_rule_example_sets', 'true'],
        ['anatomy_rule_candidates', `id='${s.cand}'`], ['anatomy_rule_simulations', `id='${s.sim}'`], ['anatomy_rule_simulation_examples', `simulation_id='${s.sim}'`],
        ['anatomy_rule_comparison_envelopes', 'true'], ['anatomy_rule_comparisons', `candidate_id='${s.cand}'`], ['anatomy_rule_reviews', `id='${s.rev}'`],
        ['anatomy_rule_review_comparisons', `review_id='${s.rev}'`], ['anatomy_rule_review_decisions', `review_id='${s.rev}'`]];
      for (const [table, where] of immutable) {
        const column = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position LIMIT 1`, [table])).rows[0].column_name;
        await fails(asApp(db, A, `UPDATE ${table} SET ${column}=${column} WHERE ${where}`), /permission denied/u);
        await fails(db.query(`UPDATE ${table} SET ${column}=${column} WHERE ${where}`), /anat:IMMUTABLE UPDATE/u);
        await fails(asApp(db, A, `DELETE FROM ${table} WHERE ${where}`), /permission denied/u);
        await fails(db.query(`DELETE FROM ${table} WHERE ${where}`), /anat:IMMUTABLE DELETE/u);
        await fails(db.query(`TRUNCATE ${table} CASCADE`), /anat:IMMUTABLE TRUNCATE/u);
      }
      await fails(db.query(`UPDATE anatomy_rule_sets SET profiles='[]' WHERE rule_hash=$1`, [s.ruleHash]), /anat:IMMUTABLE UPDATE/u);
      await fails(db.query(`UPDATE anatomy_rule_comparison_envelopes SET envelope='{}' WHERE comparison_hash=$1`, [s.envs[0]!.id]), /anat:IMMUTABLE UPDATE/u);
      await fails(db.query(`UPDATE anatomy_rule_reviews SET outcome='rejected' WHERE id=$1`, [s.rev]), /anat:IMMUTABLE UPDATE/u);
      // Allowed transitions only.
      const act = (await db.query("SELECT id FROM anatomy_rule_activations WHERE superseded_at IS NOT NULL LIMIT 1")).rows[0].id;
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activations SET superseded_at=now() WHERE id=$1', [act]), /permission denied/u);
      await fails(asWriter(A, 'UPDATE anatomy_rule_activations SET superseded_at=now() WHERE id=$1', [act]), 'IMMUTABLE');
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activations SET justification=$2 WHERE id=$1', [act, 'x'.repeat(20)]), /permission denied/u);
      const current = (await db.query('SELECT id FROM anatomy_rule_activations WHERE superseded_at IS NULL LIMIT 1')).rows[0].id;
      await fails(db.query('UPDATE anatomy_rule_activations SET justification=$2, superseded_at=now() WHERE id=$1', [current, 'y'.repeat(20)]), /anat:IMMUTABLE/u);
      const consumed = (await db.query('SELECT id FROM anatomy_rule_activation_previews WHERE consumed_at IS NOT NULL LIMIT 1')).rows[0].id;
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activation_previews SET consumed_at=NULL, consumed_activation_id=NULL WHERE id=$1', [consumed]), /permission denied/u);
      await fails(asWriter(A, 'UPDATE anatomy_rule_activation_previews SET consumed_at=NULL, consumed_activation_id=NULL WHERE id=$1', [consumed]), 'IMMUTABLE');
      await fails(db.query('DELETE FROM anatomy_rule_activations'), /anat:IMMUTABLE DELETE/u);
      await fails(db.query('DELETE FROM anatomy_rule_activation_previews'), /anat:IMMUTABLE DELETE/u);
      await fails(db.query('DELETE FROM anatomy_rule_drafts'), /anat:IMMUTABLE DELETE/u);
      await fails(asApp(db, A, 'UPDATE anatomy_rule_drafts SET author=$1 WHERE id=$2', [B, s.draftId]), /permission denied/u);
    });

    await t.test('privileges per role (§2.3) with has_table_privilege / has_column_privilege; PUBLIC has nothing', async () => {
      const tables = ['anatomy_rule_drafts', 'anatomy_rule_sets', 'anatomy_rule_example_sets', 'anatomy_rule_candidates', 'anatomy_rule_simulations',
        'anatomy_rule_simulation_examples', 'anatomy_rule_comparison_envelopes', 'anatomy_rule_comparisons', 'anatomy_rule_reviews',
        'anatomy_rule_review_comparisons', 'anatomy_rule_review_decisions', 'anatomy_rule_activations', 'anatomy_rule_activation_previews'];
      const priv = async (role: string, table: string, p: string) => (await db.query('SELECT has_table_privilege($1,$2,$3) AS ok', [role, table, p])).rows[0].ok as boolean;
      const col = async (role: string, table: string, c: string, p: string) => (await db.query('SELECT has_column_privilege($1,$2,$3,$4) AS ok', [role, table, c, p])).rows[0].ok as boolean;
      for (const table of tables) {
        assert.equal(await priv('radar_app', table, 'SELECT'), true, table);
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv('radar_app', table, p), false, `${table} ${p}`);
        assert.equal(await priv('anat_rules_writer', table, 'SELECT'), true, table);
        assert.equal(await priv('anat_rules_writer', table, 'INSERT'), true, table);
        for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv('anat_rules_writer', table, p), false, `${table} writer ${p}`);
        assert.equal(await priv('radar_taxonomy_curator', table, 'SELECT'), false, table);
        assert.equal(await priv('radar_worker', table, 'SELECT'), ['anatomy_rule_sets', 'anatomy_rule_activations'].includes(table), table);
        for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(await priv('radar_worker', table, p), false, `${table} worker ${p}`);
        const pub = await db.query(`SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_name=$1`, [table]);
        assert.equal(Number(pub.rows[0].count), 0, `${table} PUBLIC`);
        const rls = (await db.query('SELECT relrowsecurity AND relforcerowsecurity AS ok FROM pg_class WHERE oid=$1::regclass', [table])).rows[0].ok;
        assert.equal(rls, true, `${table} RLS forced`);
      }
      const updatable: Record<string, string[]> = { anatomy_rule_drafts: ['profiles', 'examples', 'revision', 'updated_at'],
        anatomy_rule_activation_previews: ['consumed_at', 'consumed_activation_id'], anatomy_rule_activations: ['superseded_at'] };
      for (const table of tables) {
        const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map((r) => r.column_name as string);
        for (const c of cols) {
          assert.equal(await col('radar_app', table, c, 'UPDATE'), false, `${table}.${c} app`);
          assert.equal(await col('anat_rules_writer', table, c, 'UPDATE'), (updatable[table] ?? []).includes(c), `${table}.${c} writer`);
        }
      }
      // Functions: radar_app executes only the eight entry points; those (and the four commit-time checks) are the only
      // SECURITY DEFINER ones, owned by the NOLOGIN writer, with a fixed search_path; nobody else has CREATE on public.
      // Eight accepted entry points plus anat_list_audit (integration delta P-INT-01: the ninth, read-only).
      // ANAT-CONFIG-01 (082): four more audited entry points of the accessible configuration, only with the project's migrations.
      const entry = ['anat_audit_attempt', 'anat_confirm', 'anat_freeze', 'anat_list_audit', 'anat_preview', 'anat_record_comparison', 'anat_record_review', 'anat_record_simulation', 'anat_save_draft',
        ...(PROJECT_MIGRATIONS ? ['anat_config_audit_attempt', 'anat_config_record_analysis', 'anat_config_restore', 'anat_config_save'] : [])];
      const commitChecks = ['anat_check_activation_at_commit', 'anat_check_approval_at_commit', 'anat_check_review_at_commit', 'anat_check_simulation_at_commit'];
      const fn = (await db.query(`SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
        has_function_privilege('radar_app', p.oid, 'EXECUTE') AS app, has_function_privilege('radar_worker', p.oid, 'EXECUTE') AS worker,
        has_function_privilege('radar_taxonomy_curator', p.oid, 'EXECUTE') AS curator
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'anat\\_%' ORDER BY p.proname`)).rows;
      assert.ok(fn.length > 20);
      for (const r of fn) {
        assert.deepEqual([r.app, r.worker, r.curator], [entry.includes(r.proname), false, false], r.proname);
        const definer = entry.includes(r.proname) || commitChecks.includes(r.proname);
        assert.equal(r.prosecdef, definer, `${r.proname} SECURITY DEFINER`);
        if (definer) { assert.equal(r.owner, 'anat_rules_writer', r.proname); assert.deepEqual(r.proconfig, ['search_path=pg_catalog, public, pg_temp'], r.proname); }
      }
      // B1-R2-01: every anat_* function (helpers, triggers, entry points) resolves names with pg_temp explicitly last.
      for (const r of fn) assert.deepEqual(r.proconfig, ['search_path=pg_catalog, public, pg_temp'], `${r.proname} search_path`);
      const writer = (await db.query("SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname='anat_rules_writer'")).rows[0];
      assert.deepEqual(writer, { rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolinherit: false });
      const creators = (await db.query(`SELECT r.rolname FROM pg_roles r WHERE has_schema_privilege(r.oid, 'public', 'CREATE') AND NOT r.rolsuper
        AND r.rolname IN ('radar_app','radar_worker','radar_taxonomy_curator','anat_rules_writer')`)).rows;
      assert.deepEqual(creators, [], 'no runtime role can create objects in public (search_path hijack)');
    });

    await t.test('audit: atomic with success; rollback leaves nothing; attempt in a separate transaction; audit down ⇒ no mutation', async () => {
      const corr = randomUUID();
      await fails(saveDraft(A, profiles('a'), [example('04')], null, null, corr), 'RESERVED_EXAMPLE_ID');
      assert.equal(await auditCount('correlation_id=$1', [corr]), 0);
      const d = await saveDraft(A, profiles('atomic'), [example('ex-1')]);
      const failCorr = randomUUID();
      await fails(saveDraft(A, profiles('atomic2'), [example('ex-1')], d.draft_id, 9, failCorr), 'STALE_REVISION');
      assert.equal(await auditCount('correlation_id=$1', [failCorr]), 0);
      await asApp(db, A, 'SELECT anat_audit_attempt($1,$2,$3,$4)', ['DRAFT_SAVE', 'STALE_REVISION', d.draft_id, failCorr]);
      assert.deepEqual((await db.query('SELECT action, entity_id, after_data FROM audit_log WHERE correlation_id=$1', [failCorr])).rows,
        [{ action: 'ANAT_RULES_ATTEMPT_REJECTED', entity_id: d.draft_id, after_data: { operation: 'DRAFT_SAVE', code: 'STALE_REVISION', targetId: d.draft_id } }]);
      await fails(asApp(db, A, 'SELECT anat_audit_attempt($1,$2,$3,$4)', ['DRAFT_SAVE', 'free text code', d.draft_id, randomUUID()]), /audit_field_not_allowed/u);
      // Audit unavailable: INSERT on audit_log revoked from the only writer, inside the transaction → every mutation
      // through the entry points is rolled back with it (B1-R1-01 scenario 4; radar_app has no other write path).
      const down = async (sql: string, params: unknown[]) => {
        await db.query('BEGIN');
        try {
          await db.query('REVOKE INSERT ON audit_log FROM anat_rules_writer');
          await db.query('SET LOCAL ROLE radar_app');
          await db.query("SELECT set_config('app.user_id', $1, true)", [A]);
          await assert.rejects(db.query(sql, params), /permission denied for table audit_log/u);
        } finally { await db.query('ROLLBACK'); }
      };
      const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM anatomy_rule_drafts) d, (SELECT count(*) FROM anatomy_rule_candidates) c,
        (SELECT count(*) FROM anatomy_rule_simulations) s, (SELECT count(*) FROM anatomy_rule_activation_previews) p, (SELECT count(*) FROM audit_log) a`)).rows[0];
      const before = await counts();
      await down('SELECT * FROM anat_save_draft($1,1,$2::jsonb,$3::jsonb,$4)', [d.draft_id, JSON.stringify(profiles('down')), JSON.stringify([example('ex-1')]), randomUUID()]);
      await down('SELECT * FROM anat_save_draft(NULL,NULL,$1::jsonb,$2::jsonb,$3)', [JSON.stringify(profiles('down')), JSON.stringify([example('ex-1')]), randomUUID()]);
      await down('SELECT * FROM anat_freeze($1,1,$2,$3)', [d.draft_id, E, randomUUID()]);
      const s = await scenario();
      const mid = await counts();
      await down('SELECT anat_record_simulation($1,$2,$3::jsonb,$4::jsonb,$5)', [s.cand, 'complete', '{}', JSON.stringify(s.rows), randomUUID()]);
      assert.deepEqual(await counts(), mid);
      const after = (await db.query('SELECT revision, profiles FROM anatomy_rule_drafts WHERE id=$1', [d.draft_id])).rows[0];
      assert.deepEqual(after, { revision: 1, profiles: profiles('atomic') });
      assert.ok(Number(before.d) <= Number(mid.d));
      assert.equal((await db.query("SELECT has_table_privilege('anat_rules_writer','audit_log','INSERT') AS ok")).rows[0].ok, true, 'grant restored by rollback');
    });

    await t.test('nothing is reprocessed: no analyses, runs or run items were written', async () => {
      for (const table of ['publication_anatomies', 'anatomy_runs', 'anatomy_run_items', 'anatomy_parts']) {
        assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, table);
      }
    });
  } finally {
    await db.end(); await db2.end();
  }
});
