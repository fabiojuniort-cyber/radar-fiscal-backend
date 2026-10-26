import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * ANAT-ADMIN-01 integration package 2 (issue tribusca-control#116): the numbered migrations are the ACCEPTED rehearsal
 * SQL plus the integration deltas COORD authorised (integration R1: P-INT-01 audit read entry point in 079, P-INT-03
 * fail-closed policy check in 078). The ONLY differences are the ones listed here, each named (no database needed). The behaviour of the migrations is
 * proven by the B1 and API suites run with ANAT_PROJECT_MIGRATIONS=1 (real runner, fresh disposable database).
 */
const file = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const installedJson = (sql: string) => /SELECT \$json\$(.*?)\$json\$::jsonb ->/su.exec(sql)![1]!;
const checkedJson = (sql: string) => /nxt := \$json\$(.*?)\$json\$::jsonb;/su.exec(sql)![1]!;
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

test('078_anat_audit_policy = accepted rehearsal M_AUDIT_ANAT without the guard + delta P-INT-03 (fail-closed check)', async () => {
  const rehearsal = await file('test/support/anatomy-admin-audit-policy.sql');
  const migration = await file('migrations/078_anat_audit_policy.sql');
  assert.ok(rehearsal.includes(GUARD_078));
  assert.doesNotMatch(migration, /ANAT04_DISPOSABLE_CI_ONLY|anatomy\.ci_disposable|anat04_ci/u);
  // Delta P-INT-03: exactly one DO block before the accepted SQL; everything after it is the rehearsal byte for byte.
  const check = /^DO \$\$ DECLARE def text; raw text; cur jsonb; nxt jsonb; base jsonb; added text\[\]; BEGIN\n[\s\S]*?\nEND \$\$;\n/mu.exec(dropHeader(migration))![0];
  assert.equal(dropHeader(migration).slice(check.length), dropHeader(rehearsal.replace(GUARD_078, '')), 'accepted SQL unchanged');
  // The check derives the expected base from exactly the JSON this migration installs (= the accepted rehearsal JSON).
  assert.equal(checkedJson(check), installedJson(migration)); assert.equal(installedJson(migration), installedJson(rehearsal));
  for (const refusal of ['not found', 'unrecognised format', 'JSON not found', 'JSON is invalid', 'JSON is not an object', 'expected exactly 8 ANAT events',
    'in force differs from the policy this migration extends']) assert.ok(check.includes(refusal), refusal);
  assert.match(check, /IF cur IS DISTINCT FROM base THEN/u, 'NULL-safe comparison');
  assert.doesNotMatch(check, /\s(=|<>)\s*base\b/u, 'no NULL-unsafe comparison against the base');
});

test('079_anat_rules_admin = accepted rehearsal M_ANAT_ADMIN with two documented edits + delta P-INT-01', async () => {
  const rehearsal = await file('test/support/anatomy-admin-ci-schema.sql');
  const migration = await file('migrations/079_anat_rules_admin.sql');
  const dup = 'CREATE POLICY anat_worker_select ON anatomy_rule_sets FOR SELECT TO radar_worker USING (true);\n';
  assert.equal(rehearsal.split(dup).length, 2, 'the duplicated policy exists once in the rehearsal');
  const expected = dropHeader(rehearsal).replace(GUARD_079, '').replace(dup, '-- (anat_worker_select ON anatomy_rule_sets: created by 077_anat_base)\n');
  // Delta P-INT-01 is one delimited block appended at the end; before it, the accepted SQL with the two edits above.
  const marker = '\n-- ===============================================================================================================\n-- BEGIN INTEGRATION DELTA P-INT-01';
  assert.equal(migration.split(marker).length, 2, 'one P-INT-01 block');
  const [accepted, delta] = migration.split(marker) as [string, string];
  assert.equal(dropHeader(accepted).replace(/^\n/u, '').trimEnd(), expected.replace(/^\n/u, '').trimEnd());
  assert.match(delta, /DROP POLICY audit_log_anat_rules_admin_select ON public\.audit_log;/u);
  assert.match(delta, /CREATE FUNCTION anat_list_audit\(p_limit integer\)/u);
  assert.match(delta, /OWNER TO anat_rules_writer;[\s\S]*REVOKE ALL ON FUNCTION anat_list_audit\(integer\) FROM PUBLIC;[\s\S]*GRANT EXECUTE ON FUNCTION anat_list_audit\(integer\) TO radar_app;/u);
  assert.match(delta, /-- END INTEGRATION DELTA P-INT-01\n?$/u);
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
