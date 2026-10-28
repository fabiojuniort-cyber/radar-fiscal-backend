import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { DISPOSABLE_URL, prepareAdminDatabase, PROJECT_MIGRATIONS } from './support/anatomy-admin-db.js';

/**
 * ANAT-CONFIG-01 (issue tribusca-control#116): accessible anatomy configuration over the REAL buildApp(), the project's
 * migrations (real runner, 081 included) and the isolated executor. Fresh disposable database, synthetic samples only.
 * Covers: flag, authorisation, guided changes, validation in Portuguese, before/after counts, save = apply in one
 * action, optimistic concurrency, audit, failure keeps the version in force, restore (audited), the consumer reading
 * the saved version, privileges/RLS, no rewrite of stored analyses, and the legacy double approval being replaced.
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

const NOTE_STYLE = { scope: { level: 'source', source: 'CONFAZ' }, path: 'classes.editorialNote', action: 'add', literal: 'NotaAlteracao' } as const;
const skip = process.env.ANAT04_CI_DATABASE_URL === undefined || !PROJECT_MIGRATIONS ? 'CI-only database with ANAT_PROJECT_MIGRATIONS=1' : false;

test('ANAT-CONFIG-01: save validates and applies, with history, audit, concurrency and the consumer (fresh disposable database)', { skip }, async (t) => {
  const url = assertDisposableEnvironment(process.env);
  const owner = new pg.Client({ connectionString: url }); await owner.connect();
  await prepareAdminDatabase(owner);
  const login = `anat_config_ci_${randomBytes(4).toString('hex')}`; const password = randomBytes(24).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN INHERIT PASSWORD '${password}' IN ROLE radar_app`);
  const runtimeUrl = url.replace('postgres:postgres@', `${login}:${password}@`);
  process.env.DATABASE_URL = runtimeUrl; process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex'); process.env.LOG_LEVEL = 'silent';
  const { buildApp } = await import('../src/app.js');
  const { env } = await import('../src/config/env.js');
  const { analyzeWithActiveConfiguration } = await import('../src/modules/anatomy/config/config.service.js');
  delete process.env.DATABASE_URL;
  const P = '/api/v1/admin/anatomy-config';
  const user = async (admin: boolean) => {
    const id = randomUUID(); const sid = randomUUID();
    await owner.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    if (admin) await owner.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [id]);
    await owner.query("INSERT INTO auth_sessions (user_id, id, idle_expires_at, absolute_expires_at) VALUES ($1, $2, now() + interval '1 hour', now() + interval '2 hours')", [id, sid]);
    return { id, as: (app: { jwt: { sign: (p: object) => string } }) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, sid, typ: 'access' })}` }) };
  };
  const adminA = await user(true); const adminB = await user(true); const plain = await user(false);
  const counts = async () => (await owner.query(`SELECT (SELECT count(*) FROM publication_anatomies)::int AS anatomies, (SELECT count(*) FROM anatomy_runs)::int AS runs,
    (SELECT count(*) FROM anatomy_rule_activations)::int AS activations, (SELECT count(*) FROM publications)::int AS publications`)).rows[0];
  const audit = async (action: string) => (await owner.query("SELECT actor_id, after_data FROM audit_log WHERE action = $1 ORDER BY occurred_at, id", [action])).rows;
  const flags = env as { ANAT_CONFIG_ENABLED: string; ANAT_RULES_ADMIN_ENABLED: string };
  try {
    await t.test('flag off (default): no route', async () => {
      assert.equal(env.ANAT_CONFIG_ENABLED, 'false');
      const app = await buildApp(); await app.ready();
      try { assert.equal((await app.inject({ method: 'GET', url: P, headers: adminA.as(app) })).statusCode, 404); } finally { await app.close(); }
    });

    flags.ANAT_CONFIG_ENABLED = 'true';
    const before = await counts();
    const app = await buildApp(); await app.ready();
    try {
      await t.test('authorisation: 401 without a token, 403 for a non-admin (in Portuguese), RLS hides the tables', async () => {
        assert.equal((await app.inject({ method: 'GET', url: P })).statusCode, 401);
        const r = await app.inject({ method: 'GET', url: P, headers: plain.as(app) });
        assert.equal(r.statusCode, 403); assert.match(r.json().message, /administradores/u);
        const save = await app.inject({ method: 'POST', url: `${P}/save`, headers: plain.as(app), payload: { basedOnVersion: 0, changes: [NOTE_STYLE], corrections: [] } });
        assert.equal(save.statusCode, 403);
        const c = new pg.Client({ connectionString: runtimeUrl }); await c.connect();
        try {
          await c.query('BEGIN'); await c.query("SELECT set_config('app.user_id', $1, true)", [plain.id]);
          assert.equal((await c.query('SELECT count(*)::int AS n FROM anatomy_config_versions')).rows[0].n, 0, 'RLS: non-admins read nothing');
          await assert.rejects(c.query('SELECT anat_config_save(0, $1::jsonb, \'[]\'::jsonb, $2, null, $3)', ['[]', 'a'.repeat(64), randomUUID()]), /anat:/u);
          await c.query('ROLLBACK');
        } finally { await c.end(); }
      });

      await t.test('initial state: shipped defaults (version 0), catalog and samples in Portuguese', async () => {
        const r = await app.inject({ method: 'GET', url: P, headers: adminA.as(app) });
        assert.equal(r.statusCode, 200, r.body);
        const body = r.json();
        assert.equal(body.current.version, 0); assert.equal(body.current.origin, 'shipped');
        assert.ok(body.catalog.some((f: { path: string; title: string }) => f.path === 'classes.editorialNote' && /nota editorial/u.test(f.title)));
        assert.ok(body.samples.length >= 6 && body.samples.every((s: { provenance: { kind: string } }) => s.provenance.kind === 'synthetic'));
        assert.ok(body.current.rules.some((row: { path: string; literals: string[] }) => row.path === 'classes.editorialNote' && row.literals.includes('Remisso')));
      });

      let preview: { totals: { changedPassages: number }; samples: { id: string; diff: { changed: { fromLabel: string; toLabel: string }[] }; after: { review: unknown[] }; before: { review: unknown[] } }[] };
      await t.test('analysis: real before/after counts on the samples; nothing is persisted', async () => {
        const r = await app.inject({ method: 'POST', url: `${P}/analysis`, headers: adminA.as(app), payload: { changes: [NOTE_STYLE] } });
        assert.equal(r.statusCode, 200, r.body);
        preview = r.json();
        const s = preview.samples.find((x) => x.id === 'sint-confaz-estilo-novo')!;
        assert.deepEqual(s.diff.changed.map((c) => [c.fromLabel, c.toLabel]), [['A conferir (não reconhecido)', 'Nota editorial']]);
        assert.equal(preview.totals.changedPassages, 1, 'only that passage changes in the whole sample set');
        assert.ok(s.after.review.length < s.before.review.length, 'the review list shrinks');
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM anatomy_config_versions')).rows[0].n, 0);
      });

      await t.test('suggestions: a rule for similar passages is proposed from the passage itself', async () => {
        const r = await app.inject({ method: 'POST', url: `${P}/suggestions`, headers: adminA.as(app),
          payload: { sampleId: 'sint-confaz-estilo-novo', text: 'Acrescentado pelo Ajuste SINIEF Exemplo 45/99, efeitos a partir de 01.09.99.', wanted: 'editorial_note' } });
        assert.equal(r.statusCode, 200, r.body);
        const sug = r.json().suggestions[0];
        assert.deepEqual([sug.path, sug.literal, sug.scope], ['classes.editorialNote', 'NotaAlteracao', { level: 'source', source: 'CONFAZ' }]);
        const none = await app.inject({ method: 'POST', url: `${P}/suggestions`, headers: adminA.as(app),
          payload: { sampleId: 'sint-doe-sp-resolucao', text: 'RESOLUÇÃO SFP EXEMPLO', wanted: 'historical' } });
        assert.match(none.json().unsupported, /correção do trecho/u);
      });

      await t.test('validation: specific messages in Portuguese, nothing saved, previous version kept', async () => {
        const removeProtection = { scope: { level: 'source', source: 'CONFAZ' }, path: 'classes.editorialNote', action: 'remove', literal: 'Remisso' };
        const r = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0, changes: [removeProtection], corrections: [] } });
        assert.equal(r.statusCode, 422, r.body);
        assert.match(r.json().issues[0].message, /"Remisso" é proteção de fábrica em estilo de nota editorial/u);
        const blank = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0, changes: [{ ...NOTE_STYLE, literal: '  ' }], corrections: [] } });
        assert.equal(blank.statusCode, 422); assert.match(blank.json().issues[0].message, /Informe o texto/u);
        const spaced = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0, changes: [{ ...NOTE_STYLE, literal: 'Nota Alteracao' }], corrections: [] } });
        assert.match(spaced.json().issues[0].message, /não pode ter espaço/u);
        const malformed = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0 } });
        assert.equal(malformed.statusCode, 422); assert.match(malformed.json().message, /incompleto ou inválido/u);
        const nothing = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0, changes: [], corrections: [] } });
        assert.match(nothing.json().issues[0].message, /Não há alterações/u);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM anatomy_config_versions')).rows[0].n, 0);
        assert.equal((await audit('ANAT_RULES_CONFIG_SAVED')).length, 0);
      });

      let v1 = '';
      await t.test('save = validate + apply in one action by ONE administrator; audited; the consumer uses it', async () => {
        const corrections = [{ sampleId: 'sint-confaz-convenio', partKey: 'a'.repeat(16), expected: 'structure', note: 'assinatura' }];
        const r = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 0, changes: [NOTE_STYLE], corrections, note: 'Estilo de nota do CONFAZ' } });
        assert.equal(r.statusCode, 201, r.body);
        v1 = r.json().versionId; assert.equal(r.json().version, 1);
        const cur = (await app.inject({ method: 'GET', url: P, headers: adminA.as(app) })).json().current;
        assert.deepEqual([cur.version, cur.origin, cur.corrections.length], [1, 'saved', 1]);
        const rows = await audit('ANAT_RULES_CONFIG_SAVED');
        assert.equal(rows.length, 1); assert.equal(rows[0].actor_id, adminA.id);
        assert.deepEqual([rows[0].after_data.kind, rows[0].after_data.version, rows[0].after_data.versionId], ['SAVE', 1, v1]);
        // The consumer, as the worker role, reads the version in force and records it in the analysis identity.
        const w = new pg.Client({ connectionString: url }); await w.connect();
        try {
          await w.query('BEGIN'); await w.query('SET LOCAL ROLE radar_worker');
          const sample = (await import('../src/modules/anatomy/config/sample-inputs.js')).SYNTHETIC_SAMPLES.find((s) => s.id === 'sint-confaz-estilo-novo')!;
          const out = await analyzeWithActiveConfiguration(w as unknown as pg.PoolClient, { publicationVersionId: 'ci', referenceDate: '2026-10-28',
            input: { source: 'CONFAZ', representationId: 'ci', html: sample.content } });
          assert.deepEqual([out.configVersion, out.configVersionId, out.result.identity.ruleSetId, out.result.identity.ruleSetVersion], [1, v1, 'anatomy-config', '1']);
          const note = out.result.parts.find((p) => out.result.canonicalText.slice(p.span.start, p.span.end).startsWith('Acrescentado'))!;
          assert.equal(note.type, 'editorial_note', 'the saved rule is what the processing applies');
          assert.equal(note.legalStatus, 'unknown', 'a note never decides validity');
          await assert.rejects(w.query("SELECT anat_config_save(1, '[]'::jsonb, '[]'::jsonb, $1, null, $2)", ['a'.repeat(64), randomUUID()]), /permission denied/u);
          await w.query('ROLLBACK');
        } finally { await w.end(); }
      });

      await t.test('concurrency: two administrators saving on the same version → exactly one wins, the other gets 409 (audited)', async () => {
        const more = (lit: string) => ({ basedOnVersion: 1, changes: [{ ...NOTE_STYLE, literal: lit }], corrections: [] });
        const [a, b] = await Promise.all([
          app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: more('NotaA') }),
          app.inject({ method: 'POST', url: `${P}/save`, headers: adminB.as(app), payload: more('NotaB') }),
        ]);
        assert.deepEqual([a.statusCode, b.statusCode].sort(), [201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        assert.match(loser.json().message, /Outra pessoa salvou/u);
        assert.equal((await owner.query('SELECT version FROM anatomy_config_current')).rows[0].version, 2);
        const rejected = await audit('ANAT_RULES_CONFIG_REJECTED');
        assert.equal(rejected.length, 1); assert.deepEqual([rejected[0].after_data.operation, rejected[0].after_data.code], ['SAVE', 'STALE_VERSION']);
      });

      await t.test('a persistence failure (audit unavailable) keeps the version in force and writes nothing', async () => {
        await owner.query(`CREATE FUNCTION ci_fail_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.action = 'ANAT_RULES_CONFIG_SAVED' THEN RAISE EXCEPTION 'ci: audit down' USING ERRCODE = '42501'; END IF; RETURN NEW; END $$`);
        await owner.query('CREATE TRIGGER ci_fail_config_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ci_fail_config_audit()');
        try {
          const r = await app.inject({ method: 'POST', url: `${P}/save`, headers: adminA.as(app), payload: { basedOnVersion: 2, changes: [{ ...NOTE_STYLE, literal: 'NotaC' }], corrections: [] } });
          assert.ok(r.statusCode >= 500, r.body);
          assert.deepEqual((await owner.query('SELECT version FROM anatomy_config_current')).rows[0], { version: 2 });
          assert.equal((await owner.query('SELECT count(*)::int AS n FROM anatomy_config_versions')).rows[0].n, 2);
        } finally {
          await owner.query('DROP TRIGGER ci_fail_config_audit ON audit_log'); await owner.query('DROP FUNCTION ci_fail_config_audit()');
        }
      });

      await t.test('restore: a NEW version with the earlier content; audited as RESTORE; history is immutable', async () => {
        const r = await app.inject({ method: 'POST', url: `${P}/restore`, headers: adminB.as(app), payload: { basedOnVersion: 2, versionId: v1, note: 'Voltar à versão 1' } });
        assert.equal(r.statusCode, 201, r.body); assert.equal(r.json().version, 3);
        const [one, three] = (await owner.query('SELECT profile_set_hash, kind, restored_from FROM anatomy_config_versions WHERE version IN (1,3) ORDER BY version')).rows;
        assert.equal(three.profile_set_hash, one.profile_set_hash); assert.deepEqual([three.kind, three.restored_from], ['restore', v1]);
        const row = (await audit('ANAT_RULES_CONFIG_SAVED')).at(-1);
        assert.deepEqual([row.actor_id, row.after_data.kind, row.after_data.restoredFromVersionId], [adminB.id, 'RESTORE', v1]);
        const stale = await app.inject({ method: 'POST', url: `${P}/restore`, headers: adminB.as(app), payload: { basedOnVersion: 2, versionId: v1 } });
        assert.equal(stale.statusCode, 409);
        const missing = await app.inject({ method: 'POST', url: `${P}/restore`, headers: adminB.as(app), payload: { basedOnVersion: 3, versionId: randomUUID() } });
        assert.equal(missing.statusCode, 404);
        await assert.rejects(owner.query('UPDATE anatomy_config_versions SET note = $1 WHERE version = 1', ['x']), /anat:IMMUTABLE/u);
        await assert.rejects(owner.query('DELETE FROM anatomy_config_versions WHERE version = 1'), /anat:IMMUTABLE/u);
        const versions = (await app.inject({ method: 'GET', url: `${P}/versions`, headers: adminA.as(app) })).json();
        assert.deepEqual(versions.map((v: { version: number }) => v.version), [3, 2, 1]);
        assert.equal(versions[0].current, true); assert.equal(versions[0].restoredFromVersion, 1);
        const auditApi = (await app.inject({ method: 'GET', url: `${P}/audit`, headers: adminA.as(app) })).json();
        assert.ok(auditApi.length >= 4 && auditApi.every((a: { action: string }) => a.action.startsWith('ANAT_RULES_CONFIG_')));
      });

      await t.test('nothing stored is reprocessed or rewritten; the legacy activations are not touched', async () => {
        assert.deepEqual(await counts(), before);
      });
    } finally { await app.close(); }

    await t.test('the legacy double-approval routes are not registered while the new flow is on', async () => {
      flags.ANAT_RULES_ADMIN_ENABLED = 'true';
      const both = await buildApp(); await both.ready();
      try {
        assert.equal(both.hasRoute({ method: 'POST', url: '/api/v1/admin/anatomy-rules/activation/confirm' }), false);
        assert.equal(both.hasRoute({ method: 'POST', url: `${P}/save` }), true);
      } finally { await both.close(); flags.ANAT_RULES_ADMIN_ENABLED = 'false'; }
    });
  } finally {
    flags.ANAT_CONFIG_ENABLED = 'false';
    await owner.query(`DROP OWNED BY ${login}`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    await owner.end();
  }
});
