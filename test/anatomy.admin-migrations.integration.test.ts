import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { DISPOSABLE_URL } from './support/anatomy-admin-db.js';
import { runProjectMigrations } from './support/anatomy-migrations.js';

/**
 * ANAT-ADMIN-01 integration package 2 (issue tribusca-control#116): 078_anat_audit_policy and 079_anat_rules_admin
 * through the REAL runner on a fresh disposable database. Catalog delta, privileges, and the fail-closed rebase check
 * of 078. The administrative behaviour itself is proven by the B1 and API suites with ANAT_PROJECT_MIGRATIONS=1.
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
type Row = { kind: string; name: string; def: string };
const ENTRY = ['anat_audit_attempt', 'anat_confirm', 'anat_freeze', 'anat_preview', 'anat_record_comparison', 'anat_record_review',
  'anat_record_simulation', 'anat_save_draft'];
const CATALOG = `
 SELECT 'policy' AS kind, tablename||'.'||policyname AS name, concat_ws('|', permissive, roles::text, cmd, qual, with_check) AS def
  FROM pg_policies WHERE schemaname = 'public'
 UNION ALL SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
 UNION ALL SELECT 'table', c.relname, coalesce(array_to_string(c.relacl, ','), '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','m','p') AND c.relname <> 'schema_migrations'
 UNION ALL SELECT 'column', table_name||'.'||column_name, data_type||'|'||is_nullable||'|'||coalesce(column_default,'')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
 UNION ALL SELECT 'trigger', tgrelid::regclass::text||'.'||tgname, md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE NOT tgisinternal
 UNION ALL SELECT 'role', rolname, concat_ws('|', rolcanlogin, rolinherit, rolbypassrls, rolsuper) FROM pg_roles WHERE rolname !~ '^pg_'
 ORDER BY 1, 2`;

const skip = process.env.ANAT04_CI_DATABASE_URL === undefined ? 'CI-only database' : false;
test('078/079 through the real migration runner (fresh disposable database)', { skip }, async (t) => {
  const url = assertDisposableEnvironment(process.env); // Must precede any connection.
  const db = new pg.Client({ connectionString: url }); await db.connect();
  try {
    const fresh = await db.query("SELECT to_regclass('public.schema_migrations') IS NULL AS fresh");
    assert.equal(fresh.rows[0].fresh, true, 'requires a fresh disposable database (the dedicated CI job provides one)');
    await runProjectMigrations(url, '077_anat_base.sql');
    const applied = async () => (await db.query("SELECT filename FROM schema_migrations WHERE filename > '077_anat_base.sql' ORDER BY 1")).rows.map((r) => r.filename);

    await t.test('078 refuses to run over an audit policy it does not extend (another front changed it): nothing applied', async () => {
      const policy = (await db.query("SELECT pg_get_functiondef('public.audit_event_policy(text,text)'::regprocedure) AS d")).rows[0].d as string;
      const tampered = policy.replace('{"COMPANY_CREATED|company"', '{"OTHER_FRONT_EVENT|other":{"x":"int"},"COMPANY_CREATED|company"');
      assert.notEqual(tampered, policy);
      await db.query(tampered);
      await assert.rejects(runProjectMigrations(url), /rebase it/u);
      assert.deepEqual(await applied(), []);
      // Rolled back: no ANAT policy on audit_log, no admin table (the role is cluster-wide and may pre-exist; 078 creates it IF NOT EXISTS).
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'audit_log' AND policyname LIKE 'audit_log_anat%'")).rows[0].n, 0);
      assert.equal((await db.query("SELECT to_regclass('public.anatomy_rule_drafts') IS NULL AS ok")).rows[0].ok, true);
      await db.query(policy); // restore exactly what 075 installed
    });

    let before: Row[] = []; let after: Row[] = [];
    await t.test('078 then 079 apply; re-running is a no-op', async () => {
      before = (await db.query(CATALOG)).rows;
      const out = await runProjectMigrations(url);
      assert.match(out, /Applying migration: 078_anat_audit_policy\.sql[\s\S]*Applying migration: 079_anat_rules_admin\.sql/u);
      assert.deepEqual(await applied(), ['078_anat_audit_policy.sql', '079_anat_rules_admin.sql']);
      assert.doesNotMatch(await runProjectMigrations(url), /Applying migration/u);
      after = (await db.query(CATALOG)).rows;
    });

    await t.test('catalog delta: only ANAT objects, audit_event_policy and the four ANAT audit_log policies', async () => {
      const key = (r: Row) => `${r.kind} ${r.name}`;
      const b = new Map(before.map((r) => [key(r), r.def])); const a = new Map(after.map((r) => [key(r), r.def]));
      assert.deepEqual([...b.keys()].filter((k) => !a.has(k)), [], 'nothing removed');
      const changed = [...b.keys()].filter((k) => a.get(k) !== b.get(k)).sort();
      assert.deepEqual(changed, ['function app_current_user_id()', 'function app_user_is_platform_admin()', 'function audit_event_policy(text,text)',
        'table anatomy_rule_sets', 'table audit_log'],
        'existing objects changed: the policy function, anatomy_rule_sets (admin grants, FORCE RLS), audit_log (writer INSERT grant) and EXECUTE for the writer');
      for (const f of ['function app_current_user_id()', 'function app_user_is_platform_admin()']) {
        assert.equal(a.get(f)!.split('|')[0], b.get(f)!.split('|')[0], `${f}: body unchanged`);
        assert.match(a.get(f)!.split('|')[1]!, /anat_rules_writer=X\//u, `${f}: only EXECUTE for anat_rules_writer added`);
        assert.equal(a.get(f)!.split('|')[1]!.replace(/,?anat_rules_writer=X\/\w+/u, ''), b.get(f)!.split('|')[1], f);
      }
      const added = [...a.keys()].filter((k) => !b.has(k));
      const foreign = added.filter((k) => !/^(policy anatomy_rule_\w+\.|policy audit_log\.audit_log_anat_rules_|policy anatomy_rule_sets\.anat_|function anat_|table anatomy_rule_|column anatomy_rule_|trigger anatomy_rule_|role anat_rules_writer$)/u.test(k));
      assert.deepEqual(foreign, [], 'every new object is an ANAT object');
      assert.deepEqual(added.filter((k) => k.startsWith('policy audit_log.')).sort(), ['policy audit_log.audit_log_anat_rules_admin_select',
        'policy audit_log.audit_log_anat_rules_hidden', 'policy audit_log.audit_log_anat_rules_writer_insert', 'policy audit_log.audit_log_anat_rules_writer_only']);
      assert.deepEqual(added.filter((k) => k.startsWith('column anatomy_rule_sets.')).sort(), ['column anatomy_rule_sets.frozen_at',
        'column anatomy_rule_sets.frozen_from_draft', 'column anatomy_rule_sets.snapshot_id']);
    });

    await t.test('privileges: the writer is a NOLOGIN definer role; radar_app only executes the 8 entry points', async () => {
      const role = (await db.query("SELECT rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'anat_rules_writer'")).rows[0];
      assert.deepEqual(role, { rolcanlogin: false, rolinherit: false, rolbypassrls: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false });
      const fns = (await db.query(`SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
        has_function_privilege('radar_app', p.oid, 'EXECUTE') AS app, has_function_privilege('radar_worker', p.oid, 'EXECUTE') AS worker,
        has_function_privilege('public', p.oid, 'EXECUTE') AS pub
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'anat\\_%' ORDER BY 1`)).rows;
      for (const f of fns) {
        assert.deepEqual(f.proconfig, ['search_path=pg_catalog, public, pg_temp'], f.proname);
        assert.equal(f.pub, false, f.proname); assert.equal(f.worker, false, f.proname);
        assert.equal(f.app, ENTRY.includes(f.proname), f.proname);
        if (ENTRY.includes(f.proname)) assert.deepEqual([f.prosecdef, f.owner], [true, 'anat_rules_writer'], f.proname);
      }
      assert.deepEqual(fns.filter((f) => ENTRY.includes(f.proname)).map((f) => f.proname), ENTRY);
      const tables = (await db.query("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'anatomy\\_rule\\_%' ORDER BY 1")).rows.map((r) => r.relname);
      for (const table of tables) {
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          assert.equal((await db.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['radar_app', table, p])).rows[0].ok, false, `radar_app ${p} ${table}`);
        }
      }
      assert.equal((await db.query("SELECT has_schema_privilege('radar_app', 'public', 'CREATE') AS ok")).rows[0].ok, false);
      // Base package grants still hold (079 must not widen or remove them).
      assert.equal((await db.query("SELECT has_table_privilege('radar_worker', 'publication_anatomies', 'INSERT') AS ok")).rows[0].ok, true);
      assert.equal((await db.query("SELECT has_table_privilege('radar_worker', 'anatomy_rule_sets', 'INSERT') AS ok")).rows[0].ok, false);
    });

    await t.test('the 075 rehearsal assumption still holds for the real chain in this branch', async () => {
      const sql = await readFile(new URL('../migrations/078_anat_audit_policy.sql', import.meta.url), 'utf8');
      assert.match(sql, /in force differs from the policy this migration extends/u);
    });
  } finally {
    await db.end();
  }
});
