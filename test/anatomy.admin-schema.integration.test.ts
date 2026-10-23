import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { canonicalJson, sha256 } from '../src/modules/anatomy/contract.js';

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
  const [A, B, R, R2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]; // authors A/B, reviewers R/R2
  type Row = Record<string, any>;
  async function asApp(c: pg.Client, actor: string | null, sql: string, params: unknown[] = [], iso = 'READ COMMITTED'): Promise<Row[]> {
    await c.query(`BEGIN ISOLATION LEVEL ${iso}`);
    try {
      await c.query('SET LOCAL ROLE radar_app');
      if (actor) await c.query("SELECT set_config('app.user_id', $1, true)", [actor]);
      const result = await c.query(sql, params);
      await c.query('COMMIT');
      return result.rows;
    } catch (error) { await c.query('ROLLBACK').catch(() => undefined); throw error; }
  }
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
    await db.query('BEGIN');
    await db.query("SET LOCAL anatomy.ci_disposable = 'true'");
    await db.query(await read('anatomy-audit-bootstrap-pre.sql'));
    await db.query(await chain('006_audit.sql'));
    await db.query(audit074);
    await db.query(await chain('075_audit_historical_event_rules.sql'));
    await db.query(await read('anatomy-audit-bootstrap-post.sql'));
    const oldKeys = Object.keys(JSON.parse(policyJson(await chain('075_audit_historical_event_rules.sql'))));
    const snapshotPolicy = async () => (await db.query(`SELECT k, audit_event_policy(split_part(k,'|',1), split_part(k,'|',2)) AS rule,
      audit_project(split_part(k,'|',1), split_part(k,'|',2), '{"company_id":"00000000-0000-4000-8000-000000000000","is_active":true,"version":3,"x":"free text"}') AS projected
      FROM unnest($1::text[]) k ORDER BY k`, [oldKeys])).rows;
    oldPolicy = await snapshotPolicy();
    await db.query(await read('anatomy-ci-schema.sql'));
    await db.query(await read('anatomy-admin-audit-policy.sql'));
    const newPolicy = await snapshotPolicy();
    await db.query(await read('anatomy-admin-ci-schema.sql'));
    await db.query('COMMIT');

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
      await fails(asApp(db, A, ins, [A, 'ANAT_RULES_UNKNOWN', id, '{}']), /audit_event_not_registered/u);
      const projected = (await db.query(`SELECT audit_project('ANAT_RULES_REVIEWED','anatomy_rules',$1::jsonb) AS p`,
        [JSON.stringify({ reviewId: id, outcome: 'APPROVED', rationale: 'texto livre', comparisonCount: 2, nested: { a: 1 } })])).rows[0].p;
      assert.deepEqual(projected, { reviewId: id, outcome: 'APPROVED', comparisonCount: 2 });
      await fails(asApp(db, A, ins, [A, 'ANAT_RULES_REVIEWED', id, JSON.stringify({ reviewId: id, rationale: 'texto livre' })]), /audit_field_not_allowed/u);
      await fails(asApp(db, A, ins, ['admin@example.test', 'ANAT_RULES_REVIEWED', id, '{}']), /audit_invalid_actor|row-level security/u);
      await fails(asApp(db, A, ins, [B, 'ANAT_RULES_REVIEWED', id, '{}']), /row-level security/u); // actor must be the session
      await fails(asApp(db, A, `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data)
        VALUES (NULL,'ADMIN',$1,'COMPANY_PURGED','company',$2,'{}')`, [A, id]), /row-level security/u); // no widening
      await asApp(db, A, ins, [A, 'ANAT_RULES_REVIEWED', id, JSON.stringify({ reviewId: id, outcome: 'APPROVED' })]);
      assert.equal(await auditCount('entity_id=$1', [id]), 1);
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
      // Direct INSERT path cannot skip the rules: the deferred trigger re-checks at COMMIT.
      await fails(asApp(db, R, `INSERT INTO anatomy_rule_reviews (candidate_id, simulation_id, reviewer, outcome, rationale)
        VALUES ($1,$2,$3,'approved','Sem vínculos de comparação.')`, [s.cand, s.sim, R]), 'REVIEW_INCOMPLETE');
      assert.equal(Number((await db.query("SELECT count(*) FROM anatomy_rule_reviews WHERE candidate_id=$1", [s.cand])).rows[0].count), 0);
      // Valid path.
      const corr = randomUUID();
      const ok = await review(R, s.cand, s.sim, s.comps, s.decisions, 'approved', corr);
      assert.deepEqual((await db.query('SELECT after_data FROM audit_log WHERE correlation_id=$1', [corr])).rows[0].after_data,
        { reviewId: ok, candidateId: s.cand, simulationId: s.sim, outcome: 'APPROVED', comparisonCount: 2, decisionCount: 2 });
      assert.equal((await db.query('SELECT rationale FROM anatomy_rule_reviews WHERE id=$1', [ok])).rows[0].rationale, 'Revisão sintética suficiente.');
      assert.equal(await auditCount("after_data::text LIKE '%Revisão%'"), 0, 'rationale never reaches audit_log');
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
      await db.query(`INSERT INTO anatomy_rule_activation_previews (token_hash, action, actor, scope, candidate_id, review_id, observed_activation_id,
        intent_hash, affected_scope, created_at, expires_at)
        SELECT $1,'activate',$2,$3,$4,$5,$6, anat_intent_hash('activate',$4,$5,$6,$3, now()-interval '1 minute'), '{}', now()-interval '11 minutes', now()-interval '1 minute'`,
      [h(tok4), R, scope, s.cand, s.rev, first.activation_id]);
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
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activations SET superseded_at=now() WHERE id=$1', [act]), 'IMMUTABLE');
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activations SET justification=$2 WHERE id=$1', [act, 'x'.repeat(20)]), /permission denied/u);
      const current = (await db.query('SELECT id FROM anatomy_rule_activations WHERE superseded_at IS NULL LIMIT 1')).rows[0].id;
      await fails(db.query('UPDATE anatomy_rule_activations SET justification=$2, superseded_at=now() WHERE id=$1', [current, 'y'.repeat(20)]), /anat:IMMUTABLE/u);
      const consumed = (await db.query('SELECT id FROM anatomy_rule_activation_previews WHERE consumed_at IS NOT NULL LIMIT 1')).rows[0].id;
      await fails(asApp(db, A, 'UPDATE anatomy_rule_activation_previews SET consumed_at=NULL, consumed_activation_id=NULL WHERE id=$1', [consumed]), 'IMMUTABLE');
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
        assert.equal(await priv('radar_app', table, 'INSERT'), true, table);
        for (const p of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv('radar_app', table, p), false, `${table} ${p}`);
        assert.equal(await priv('radar_taxonomy_curator', table, 'SELECT'), false, table);
        assert.equal(await priv('radar_worker', table, 'SELECT'), ['anatomy_rule_sets', 'anatomy_rule_activations'].includes(table), table);
        for (const p of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(await priv('radar_worker', table, p), false, `${table} worker ${p}`);
        const pub = await db.query(`SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_name=$1`, [table]);
        assert.equal(Number(pub.rows[0].count), 0, `${table} PUBLIC`);
      }
      const updatable: Record<string, string[]> = { anatomy_rule_drafts: ['profiles', 'examples', 'revision', 'updated_at'],
        anatomy_rule_activation_previews: ['consumed_at', 'consumed_activation_id'], anatomy_rule_activations: ['superseded_at'] };
      for (const table of tables) {
        const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map((r) => r.column_name as string);
        for (const c of cols) assert.equal(await col('radar_app', table, c, 'UPDATE'), (updatable[table] ?? []).includes(c), `${table}.${c}`);
      }
      const fn = await db.query(`SELECT p.proname, has_function_privilege('radar_app', p.oid, 'EXECUTE') AS app,
        has_function_privilege('radar_worker', p.oid, 'EXECUTE') AS worker, has_function_privilege('radar_taxonomy_curator', p.oid, 'EXECUTE') AS curator
        FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'anat\\_%'`);
      assert.ok(fn.rows.length > 10);
      for (const r of fn.rows) assert.deepEqual([r.app, r.worker, r.curator], [true, false, false], r.proname);
      assert.equal((await db.query("SELECT bool_or(prosecdef) AS any FROM pg_proc WHERE proname LIKE 'anat\\_%'")).rows[0].any, false, 'no SECURITY DEFINER');
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
      // Audit unavailable: INSERT on audit_log revoked inside the transaction → the draft update is rolled back too.
      await db.query('BEGIN');
      try {
        await db.query('REVOKE INSERT ON audit_log FROM radar_app');
        await db.query('SET LOCAL ROLE radar_app');
        await db.query("SELECT set_config('app.user_id', $1, true)", [A]);
        await assert.rejects(db.query('SELECT * FROM anat_save_draft($1,1,$2::jsonb,$3::jsonb,$4)',
          [d.draft_id, JSON.stringify(profiles('down')), JSON.stringify([example('ex-1')]), randomUUID()]), /permission denied for table audit_log/u);
      } finally { await db.query('ROLLBACK'); }
      const after = (await db.query('SELECT revision, profiles FROM anatomy_rule_drafts WHERE id=$1', [d.draft_id])).rows[0];
      assert.deepEqual(after, { revision: 1, profiles: profiles('atomic') });
      assert.equal((await db.query("SELECT has_table_privilege('radar_app','audit_log','INSERT') AS ok")).rows[0].ok, true, 'grant restored by rollback');
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
