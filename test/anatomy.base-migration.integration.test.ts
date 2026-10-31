import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import { canonicalJson } from '../src/modules/anatomy/contract.js';
import { DEFAULT_PROFILES, ProfileValidationError, resolveEffectiveProfile } from '../src/modules/anatomy/profile.js';
import { DISPOSABLE_URL } from './support/anatomy-admin-db.js';
import { projectMigrationFiles, runProjectMigrations } from './support/anatomy-migrations.js';

/**
 * ANAT-ADMIN-01 integration package 1 (issue tribusca-control#116): migration 077_anat_base applied by the REAL runner
 * on top of the real chain of this branch, in a FRESH disposable database (own CI job per PostgreSQL major).
 * Synthetic data only: no corpus, gold or reserve.
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

const BASE = '077_anat_base.sql';
const TABLES = ['anatomy_rule_sets', 'publication_anatomies', 'anatomy_parts', 'anatomy_entities', 'anatomy_evidence',
  'anatomy_dependencies', 'anatomy_runs', 'anatomy_run_items'];
const ANALYSIS = ['publication_anatomies', 'anatomy_parts', 'anatomy_entities', 'anatomy_evidence', 'anatomy_dependencies'];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, unknown>;

/** Catalog objects that are NOT part of this migration: they must be byte-identical before and after it. */
const CATALOG = `
 SELECT 'policy' AS kind, schemaname||'.'||tablename||'.'||policyname AS name,
  concat_ws('|', permissive, roles::text, cmd, qual, with_check) AS def FROM pg_policies
  WHERE tablename <> ALL($1::text[])
 UNION ALL SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT LIKE 'anatomy\\_%'
 UNION ALL SELECT 'table', c.relname, coalesce(array_to_string(c.relacl, ','), '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','v','m','p') AND c.relname <> ALL($1::text[])
  AND c.relname <> 'schema_migrations'
 UNION ALL SELECT 'column', table_name||'.'||column_name, data_type||'|'||is_nullable||'|'||coalesce(column_default,'')
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> ALL($1::text[]) AND table_name <> 'schema_migrations'
 UNION ALL SELECT 'trigger', tgrelid::regclass::text||'.'||tgname, md5(pg_get_triggerdef(oid)) FROM pg_trigger
  WHERE NOT tgisinternal AND tgrelid::regclass::text <> ALL($1::text[])
 UNION ALL SELECT 'role', rolname, concat_ws('|', rolcanlogin, rolinherit, rolbypassrls, rolsuper) FROM pg_roles WHERE rolname !~ '^pg_'
 ORDER BY 1, 2`;

test('077 disposable guard refuses external configuration before connection', () => {
  const safe = { CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test', ANAT04_CI_DATABASE_URL: DISPOSABLE_URL };
  assert.equal(assertDisposableEnvironment(safe), DISPOSABLE_URL);
  for (const key of Object.keys(safe)) { const m: NodeJS.ProcessEnv = { ...safe }; delete m[key]; assert.throws(() => assertDisposableEnvironment(m)); }
  assert.throws(() => assertDisposableEnvironment({ ...safe, DATABASE_URL: DISPOSABLE_URL }));
});

test('family CHECK mirrors the ANAT-PROFILE/1 literal (pure vectors)', () => {
  // Only the TS side here; the SQL side runs the same vectors in the database test below.
  for (const [family, ok] of FAMILY_VECTORS) {
    let accepted = true;
    try { resolveEffectiveProfile(structuredClone(DEFAULT_PROFILES) as unknown[], { source: 'DOU', family }); } catch (e) {
      assert.ok(e instanceof ProfileValidationError); accepted = false;
    }
    assert.equal(accepted, ok, JSON.stringify(family));
  }
});

const FAMILY_VECTORS: [string, boolean][] = [
  ['lei', true], ['Instrução Normativa', true], ['IN-RFB', true], ['x'.repeat(64), true], ['x'.repeat(65), false],
  ['😀'.repeat(32), true], ['😀'.repeat(33), false], ['', false], [' lei', false], ['lei ', false], ['a  b', false],
  ['a\tb', false], ['a b', false], ['a b', false], ['a　b', false], ['a\u0007b', false], ['a\u007fb', false],
  ['é', false], ['é', true], ['ação fiscal', true],
];

const skip = process.env.ANAT04_CI_DATABASE_URL === undefined ? 'CI-only database; offline checks still run' : false;
test('077_anat_base through the real migration runner (fresh disposable database)', { skip }, async (t) => {
  const url = assertDisposableEnvironment(process.env); // Must precede any connection.
  const db = new pg.Client({ connectionString: url }); await db.connect();
  const asRole = async <T extends Row>(role: string, sql: string, params: unknown[] = [], tenant: string | null = null): Promise<T[]> => {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      if (tenant) await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const r = (await db.query(sql, params)).rows as T[]; await db.query('COMMIT'); return r;
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  };
  const refused = async (p: Promise<unknown>, re: RegExp) => { await assert.rejects(p, (e: Error) => re.test(e.message), re.source); };
  try {
    const fresh = await db.query("SELECT to_regclass('public.schema_migrations') IS NULL AND to_regclass('public.publications') IS NULL AS fresh");
    assert.equal(fresh.rows[0].fresh, true, 'requires a fresh disposable database (the dedicated CI job provides one)');
    const files = await projectMigrationFiles();
    const before = files[files.indexOf(BASE) - 1]!;
    assert.ok(files.includes(BASE) && before, 'the base migration follows the real chain');
    let snapshot: Row[] = [];

    await t.test('the real runner applies the chain, then 077 on top; nothing else in the catalog changes', async () => {
      await runProjectMigrations(url, before);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename = $1", [BASE])).rows[0].n, 0);
      snapshot = (await db.query(CATALOG, [TABLES])).rows;
      // Stops at 077 even on branches that carry later migrations: this suite checks the base package alone.
      const out = await runProjectMigrations(url, BASE);
      assert.match(out, new RegExp(`Applying migration: ${BASE}`, 'u'));
      assert.deepEqual((await db.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename), files.slice(0, files.indexOf(BASE) + 1));
      assert.deepEqual((await db.query(CATALOG, [TABLES])).rows, snapshot, 'existing policies, grants, functions, columns, triggers and roles are unchanged');
      const again = await runProjectMigrations(url, BASE);
      assert.doesNotMatch(again, /Applying migration/u, 're-running is a no-op (checksums match)');
    });

    await t.test('structure equals the CI schema except the reviewed changes', async () => {
      const cols = async (schema: string) => (await db.query(`SELECT table_name||'.'||column_name AS k, data_type||'|'||is_nullable||'|'||coalesce(column_default,'') AS v
        FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY 1`, [schema, TABLES])).rows as { k: string; v: string }[];
      const cons = async (schema: string) => (await db.query(`SELECT conrelid::regclass::text AS t, contype, pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[])) ORDER BY 1, 2, 3`, [schema, TABLES])).rows.map((r) => `${String(r.t).replace(/^ci_ref\./u, '')} ${r.contype} ${r.d}`);
      const real = await cols('public'); const realCons = await cons('public');
      await db.query('BEGIN');
      let ref: { k: string; v: string }[] = []; let refCons: string[] = [];
      try {
        await db.query('CREATE SCHEMA ci_ref'); await db.query('SET LOCAL search_path = ci_ref, public');
        await db.query("SET LOCAL anatomy.ci_disposable = 'true'");
        await db.query(await readFile(new URL('./support/anatomy-ci-schema.sql', import.meta.url), 'utf8'));
        ref = await cols('ci_ref'); refCons = await cons('ci_ref');
      } finally { await db.query('ROLLBACK'); }
      const map = (rows: { k: string; v: string }[]) => new Map(rows.map((r) => [r.k, r.v]));
      const r = map(real); const c = map(ref);
      const changed = [...r.keys()].filter((k) => c.get(k) !== r.get(k)).sort();
      assert.deepEqual(changed, ['anatomy_run_items.publication_version_id', 'publication_anatomies.effective_profile_hash',
        'publication_anatomies.family', 'publication_anatomies.publication_version_id']);
      assert.deepEqual([...c.keys()].filter((k) => !r.has(k)), [], 'no CI column is missing');
      assert.equal(r.get('publication_anatomies.publication_version_id'), 'uuid|NO|');
      assert.equal(r.get('publication_anatomies.effective_profile_hash'), 'text|YES|');
      assert.equal(r.get('publication_anatomies.family'), 'text|YES|');
      // Every CI constraint exists, except the CHECK on source which is now the PROFILE_SOURCES list.
      const extra = realCons.filter((x) => !refCons.includes(x)).sort();
      assert.deepEqual(refCons.filter((x) => !realCons.includes(x)), [], 'no CI constraint is dropped');
      assert.deepEqual(extra.map((x) => x.replace(/ (CHECK|FOREIGN KEY).*$/u, ' $1')), [
        'anatomy_run_items f FOREIGN KEY', 'publication_anatomies c CHECK', 'publication_anatomies c CHECK', 'publication_anatomies c CHECK',
        'publication_anatomies c CHECK', 'publication_anatomies f FOREIGN KEY']);
      for (const x of extra.filter((e) => / f /u.test(e))) assert.match(x, /REFERENCES publication_versions\(id\) ON DELETE RESTRICT$/u);
    });

    await t.test('privileges: worker writes, app reads in-scope analyses only, nobody deletes or updates analyses', async () => {
      const priv = async (role: string, table: string, p: string) => (await db.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, table, p])).rows[0].ok as boolean;
      for (const table of TABLES) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const worker = table === 'anatomy_rule_sets' ? p === 'SELECT' : p === 'SELECT' || p === 'INSERT';
          assert.equal(await priv('radar_worker', table, p), worker, `radar_worker ${p} ${table}`);
          assert.equal(await priv('radar_app', table, p), p === 'SELECT' && ANALYSIS.includes(table), `radar_app ${p} ${table}`);
          assert.equal(await priv('radar_taxonomy_curator', table, p), false, `curator ${p} ${table}`);
          assert.equal(await priv('public', table, p), false, `PUBLIC ${p} ${table}`);
        }
        assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [table])).rows[0].relrowsecurity, true, table);
      }
      const colPriv = async (table: string) => (await db.query(`SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'radar_worker' AND table_name = $1 AND privilege_type = 'UPDATE' ORDER BY 1`, [table])).rows.map((r) => r.column_name);
      assert.deepEqual(await colPriv('anatomy_runs'), ['counters', 'cursor', 'duration_ms', 'ended_at']);
      assert.deepEqual(await colPriv('anatomy_run_items'), ['attempt', 'duration_ms', 'error', 'output_anatomy_id', 'status']);
      for (const table of ANALYSIS) assert.deepEqual(await colPriv(table), [], table);
      assert.equal((await db.query("SELECT has_schema_privilege('radar_app', 'public', 'CREATE') AS ok")).rows[0].ok, false);
    });

    await t.test('family/source CHECK equals the profile contract on the same vectors', async () => {
      for (const [family, ok] of FAMILY_VECTORS) {
        assert.equal((await db.query('SELECT anatomy_profile_literal_ok($1) AS ok', [family])).rows[0].ok, ok, JSON.stringify(family));
      }
    });

    // Synthetic publications: P1 in scope, P2 suppressed through the real 033 transition.
    const pub = async (n: number) => (await db.query(`INSERT INTO publications (identity_hash, identity_strength, identity_basis, jurisdiction_level, title)
      VALUES ($1, 'STRONG', '{}', 'FEDERAL', $2) RETURNING id`, [sha(`anat-int-pub-${n}`), `Publicação sintética ${n}`])).rows[0].id as string;
    const version = async (p: string) => (await db.query(`INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text)
      VALUES ($1, 1, $2, 'Texto sintético.') RETURNING id`, [p, sha(`anat-int-ver-${p}`)])).rows[0].id as string;
    const p1 = await pub(1); const p2 = await pub(2); const v1 = await version(p1); const v2 = await version(p2);
    await db.query(`SELECT * FROM apply_publication_scope_transition($1, 'SUPPRESS', gen_random_uuid(), NULL, 'anat-int-test', 'synthetic',
      'v1', $2, NULL, 'system:ci')`, [p2, sha('evidence')]);
    await db.query(`INSERT INTO anatomy_rule_sets (id, version, status, rule_hash, contract_version, profiles, author)
      VALUES ('rs-1', '1', 'reviewed', $1, 'v1', $2::jsonb, 'system:ci')`, [sha('rules'), JSON.stringify(DEFAULT_PROFILES)]);
    const effective = resolveEffectiveProfile(structuredClone(DEFAULT_PROFILES) as unknown[], { source: 'DOU', family: 'Instrução Normativa' });
    const effectiveHash = sha(canonicalJson(effective));
    const analysis = (id: string, v: string, extra: Partial<Record<'effective_profile_hash' | 'family', string | null>> = {}) => [
      `INSERT INTO publication_anatomies (id, publication_version_id, representation_id, source, input_text_hash, attachment_manifest_hash,
        engine_version, engine_hash, rule_set_id, rule_set_hash, contract_version, status, text_length, coverage, output_hash, effective_profile_hash, family)
       VALUES ($1, $2, 'r1', 'DOU', $3, $3, 'e1', $4, 'rs-1', $5, 'v1', 'complete', 16, '{}', $3, $6, $7)`,
      [id, v, sha(`in-${id}`), ANATOMY_ENGINE_BUILD_HASH, sha('rules'), extra.effective_profile_hash ?? null, extra.family ?? null]] as const;
    const A1 = sha('a1'); const A2 = sha('a2');

    await t.test('the worker writes analyses and runs; effective_profile_hash and family round-trip; nothing is invented', async () => {
      // ANAT-STRUCT-01 changed the reader (groups, considerandos, items): identity b6ccf583… → 0481229a…, regenerated with --write.
      assert.equal(ANATOMY_ENGINE_BUILD_HASH.slice(0, 8), '0481229a', 'engine identity is the current build');
      await asRole('radar_worker', ...analysis(A1, v1, { effective_profile_hash: effectiveHash, family: 'Instrução Normativa' }));
      await asRole('radar_worker', ...analysis(A2, v2));
      await asRole('radar_worker', `INSERT INTO anatomy_parts (anatomy_id, id, parent_id, sibling_order, type, label, start_utf16, end_utf16,
        source_pointers, confidence, coverage, context) VALUES ($1, 'root', NULL, 0, 'document', 'Documento', 0, 16, '[]', 1, 'complete', 'body')`, [A1]);
      const back = (await db.query('SELECT effective_profile_hash, family FROM publication_anatomies WHERE id = $1', [A1])).rows[0];
      assert.deepEqual(back, { effective_profile_hash: effectiveHash, family: 'Instrução Normativa' });
      assert.deepEqual((await db.query('SELECT effective_profile_hash, family FROM publication_anatomies WHERE id = $1', [A2])).rows[0],
        { effective_profile_hash: null, family: null }, 'not recorded stays NULL');
      await refused(asRole('radar_worker', ...analysis(sha('a3'), v1, { family: 'lei' })), /check constraint/u);
      await refused(asRole('radar_worker', ...analysis(sha('a4'), v1, { effective_profile_hash: effectiveHash, family: ' lei' })), /check constraint/u);
      await asRole('radar_worker', `INSERT INTO anatomy_runs (id, manifest_hash, scope, engine_version, rule_set_id, rule_set_hash, initiator, started_at, counters)
        VALUES ('run-1', $1, '{}', 'e1', 'rs-1', $2, 'system:ci', now(), '{}')`, [sha('manifest'), sha('rules')]);
      await asRole('radar_worker', `INSERT INTO anatomy_run_items (run_id, id, publication_version_id, input_text_hash, engine_version, rule_set_id,
        rule_set_hash, status, attempt, expected_analysis_id) VALUES ('run-1', 'i1', $1, $2, 'e1', 'rs-1', $3, 'pending', 1, $4)`,
      [v1, sha(`in-${A1}`), sha('rules'), A1]);
      await asRole('radar_worker', "UPDATE anatomy_run_items SET status = 'complete', output_anatomy_id = $1 WHERE run_id = 'run-1' AND id = 'i1'", [A1]);
      await asRole('radar_worker', "UPDATE anatomy_runs SET ended_at = now(), counters = '{\"complete\":1}' WHERE id = 'run-1'");
      await refused(asRole('radar_worker', "UPDATE anatomy_runs SET initiator = 'x' WHERE id = 'run-1'"), /permission denied/u);
      await refused(asRole('radar_worker', "UPDATE anatomy_run_items SET expected_analysis_id = $1 WHERE id = 'i1'", [A2]), /permission denied/u);
    });

    await t.test('analyses are immutable: refused to the worker (grant) and to the owner (trigger); no DELETE for runtime roles', async () => {
      await refused(asRole('radar_worker', 'UPDATE publication_anatomies SET family = NULL WHERE id = $1', [A1]), /permission denied/u);
      await refused(asRole('radar_worker', 'DELETE FROM publication_anatomies WHERE id = $1', [A1]), /permission denied/u);
      await refused(asRole('radar_app', 'DELETE FROM publication_anatomies WHERE id = $1', [A1]), /permission denied/u);
      await refused(db.query("UPDATE publication_anatomies SET family = 'outra' WHERE id = $1", [A1]), /immutable/u);
      await refused(db.query("UPDATE anatomy_parts SET label = 'x' WHERE anatomy_id = $1", [A1]), /immutable/u);
      await refused(asRole('radar_worker', "INSERT INTO anatomy_rule_sets (id, version, status, rule_hash, contract_version, profiles, author) VALUES ('rs-x','1','draft',$1,'v1','[]','w')", [sha('x')]), /permission denied/u);
    });

    await t.test('reads: the app sees only analyses of in-scope publications, whatever the tenant; nothing of runs or rule sets', async () => {
      for (const tenant of [null, '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2']) {
        const seen = await asRole<{ id: string }>('radar_app', 'SELECT id FROM publication_anatomies ORDER BY id', [], tenant);
        assert.deepEqual(seen.map((r) => r.id), [A1], `tenant ${tenant}`);
        assert.equal((await asRole<{ n: number }>('radar_app', 'SELECT count(*)::int AS n FROM anatomy_parts', [], tenant))[0]!.n, 1);
      }
      await refused(asRole('radar_app', 'SELECT * FROM anatomy_runs'), /permission denied/u);
      await refused(asRole('radar_app', 'SELECT * FROM anatomy_rule_sets'), /permission denied/u);
      await refused(asRole('radar_taxonomy_curator', 'SELECT * FROM publication_anatomies'), /permission denied/u);
      assert.equal((await asRole<{ n: number }>('radar_worker', 'SELECT count(*)::int AS n FROM publication_anatomies'))[0]!.n, 2);
    });

    await t.test('ON DELETE RESTRICT: a version (or publication) with analyses or run items cannot be deleted', async () => {
      // PG16: "violates foreign key constraint"; PG18: "violates RESTRICT setting of foreign key constraint".
      await refused(db.query('DELETE FROM publication_versions WHERE id = $1', [v1]), /violates (RESTRICT setting of )?foreign key constraint/u);
      await refused(db.query('DELETE FROM publications WHERE id = $1', [p1]), /violates (RESTRICT setting of )?foreign key constraint/u);
      const v3 = await version(await pub(3));
      await db.query('DELETE FROM publication_versions WHERE id = $1', [v3]); // no dependency: unchanged behaviour
      assert.equal((await db.query('SELECT count(*)::int AS n FROM publication_anatomies')).rows[0].n, 2);
    });

    await t.test('recovery: the documented drop order is valid (rolled back)', async () => {
      await db.query('BEGIN');
      try {
        for (const table of ['anatomy_run_items', 'anatomy_runs', 'anatomy_dependencies', 'anatomy_evidence', 'anatomy_entities',
          'anatomy_parts', 'publication_anatomies', 'anatomy_rule_sets']) await db.query(`DROP TABLE ${table}`);
        await db.query('DROP FUNCTION anatomy_guard_part(), anatomy_guard_occurrence(), anatomy_guard_analysis_immutable(), anatomy_profile_literal_ok(text)');
      } finally { await db.query('ROLLBACK'); }
      assert.equal((await db.query("SELECT to_regclass('public.publication_anatomies') IS NOT NULL AS ok")).rows[0].ok, true);
    });
  } finally {
    await db.end();
  }
});
