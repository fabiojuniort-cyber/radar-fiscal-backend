import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * ANAT-ADMIN-01 integration package 2 (issue tribusca-control#116): the numbered migrations are the accepted rehearsal
 * SQL, and the ONLY differences are the ones listed here (no database needed). The behaviour of the migrations is
 * proven by the B1 and API suites run with ANAT_PROJECT_MIGRATIONS=1 (real runner, fresh disposable database).
 */
const file = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const json = (sql: string) => [...sql.matchAll(/\$json\$(.*?)\$json\$/gsu)].map((m) => m[1]!);
const GUARD_078 = `DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;
`;
const GUARD_079 = `DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_user<>'postgres'
 OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 OR inet_server_port() IS DISTINCT FROM 5432 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;
`;
const dropHeader = (sql: string) => sql.replace(/^(--[^\n]*\n)+/u, '');

test('078_anat_audit_policy = rehearsal M_AUDIT_ANAT without the guard, plus a fail-closed check of the policy in force', async () => {
  const rehearsal = await file('test/support/anatomy-admin-audit-policy.sql');
  const migration = await file('migrations/078_anat_audit_policy.sql');
  assert.ok(rehearsal.includes(GUARD_078));
  assert.doesNotMatch(migration, /ANAT04_DISPOSABLE_CI_ONLY|anatomy\.ci_disposable|anat04_ci/u);
  const check = /^DO \$\$ DECLARE cur text; nxt jsonb; old jsonb; BEGIN\n[\s\S]*?\nEND \$\$;\n/mu.exec(dropHeader(migration))![0];
  assert.equal(dropHeader(migration).slice(check.length), dropHeader(rehearsal.replace(GUARD_078, '')));
  // The check compares the policy in force with exactly the JSON this migration installs.
  const [checked, installed] = json(migration);
  assert.equal(checked, installed); assert.equal(installed, json(rehearsal)[0]);
  assert.match(check, /RAISE EXCEPTION 'M_AUDIT_ANAT: audit_event_policy in force differs/u);
});

test('079_anat_rules_admin = rehearsal M_ANAT_ADMIN with exactly two documented edits', async () => {
  const rehearsal = await file('test/support/anatomy-admin-ci-schema.sql');
  const migration = await file('migrations/079_anat_rules_admin.sql');
  const dup = 'CREATE POLICY anat_worker_select ON anatomy_rule_sets FOR SELECT TO radar_worker USING (true);\n';
  assert.equal(rehearsal.split(dup).length, 2, 'the duplicated policy exists once in the rehearsal');
  const expected = dropHeader(rehearsal).replace(GUARD_079, '').replace(dup, '-- (anat_worker_select ON anatomy_rule_sets: created by 077_anat_base)\n');
  assert.equal(dropHeader(migration).replace(/^\n/u, ''), expected.replace(/^\n/u, ''));
  assert.match(await file('migrations/077_anat_base.sql'), /CREATE POLICY anat_worker_select ON anatomy_rule_sets FOR SELECT TO radar_worker USING \(true\);/u);
  assert.doesNotMatch(migration, /ANAT04_DISPOSABLE_CI_ONLY|anatomy\.ci_disposable|anat04_ci/u);
});

test('migration order: base, then audit policy (creates anat_rules_writer), then admin schema', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter((f) => /^\d{3}_/u.test(f)).sort();
  const at = (f: string) => files.indexOf(f);
  assert.deepEqual(files.slice(-3), ['077_anat_base.sql', '078_anat_audit_policy.sql', '079_anat_rules_admin.sql']);
  assert.ok(at('077_anat_base.sql') < at('078_anat_audit_policy.sql') && at('078_anat_audit_policy.sql') < at('079_anat_rules_admin.sql'));
  assert.match(await file('migrations/078_anat_audit_policy.sql'), /CREATE ROLE anat_rules_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/u);
});
