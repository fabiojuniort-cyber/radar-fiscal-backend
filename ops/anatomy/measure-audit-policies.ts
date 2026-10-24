/**
 * ANAT-ADMIN-01 integration package 4: cost of the ANAT audit_log policies (078) on synthetic volume
 * (issue tribusca-control#116). DISPOSABLE DATABASE ONLY (same guard as the integration tests). The project's real
 * runner applies the chain up to 077; synthetic tenants, members and audit rows are seeded once (row triggers off while
 * seeding, owner only); every read path is timed (EXPLAIN ANALYZE execution time, median of N) BEFORE 078/079, then
 * the runner applies 078/079 and the same paths are timed again on the same data. Prints one JSON line.
 * Usage (CI-like env): node --import tsx ops/anatomy/measure-audit-policies.ts [rows] [repeats]
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DISPOSABLE_URL } from '../../test/support/anatomy-admin-db.js';
import { runProjectMigrations } from '../../test/support/anatomy-migrations.js';

const env = process.env;
if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.NODE_ENV !== 'test' || env.ANAT04_CI_DATABASE_URL !== DISPOSABLE_URL
  || env.DATABASE_URL !== undefined || env.DATABASE_ADMIN_URL !== undefined) {
  throw new Error('disposable environment only (CI=true, GITHUB_ACTIONS=true, NODE_ENV=test, ANAT04_CI_DATABASE_URL=disposable, no DATABASE_URL)');
}
const rows = Number(process.argv[2] ?? 1_000_000);
const repeats = Number(process.argv[3] ?? 7);
const TENANTS = 20; const ANAT_SHARE = 0.01; const GLOBAL_SHARE = 0.3;

const db = new pg.Client({ connectionString: DISPOSABLE_URL }); await db.connect();
const fresh = await db.query("SELECT to_regclass('public.schema_migrations') IS NULL AS fresh");
if (fresh.rows[0].fresh !== true) throw new Error('requires a fresh disposable database');
await runProjectMigrations(DISPOSABLE_URL, '077_anat_base.sql');

// Seed: tenants with one active member each, one platform admin; audit rows spread over tenants, global rows of other
// fronts, and a 1 % share of ANAT rows (present in BOTH measurements; only the policies differ).
const tenants: string[] = []; const members: string[] = [];
for (let i = 0; i < TENANTS; i += 1) {
  const t = (await db.query('INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id', [`Tenant sintético ${i}`, `t-sint-${i}-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  const u = randomUUID();
  await db.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [u, `${u}@example.test`]);
  await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'OWNER')", [t, u]);
  tenants.push(t); members.push(u);
}
const admin = randomUUID();
await db.query('INSERT INTO app_users (id, email) VALUES ($1, $2)', [admin, `${admin}@example.test`]);
await db.query("INSERT INTO platform_user_roles (user_id, role, granted_by) VALUES ($1, 'PLATFORM_ADMIN', 'system:ci')", [admin]);
await db.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
await db.query(`INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, occurred_at)
  SELECT CASE WHEN g % 1000 < $2::numeric * 1000 THEN NULL WHEN g % 1000 < $3::numeric * 1000 THEN NULL ELSE ($4::uuid[])[1 + g % $5::int] END,
         CASE WHEN g % 1000 < $2::numeric * 1000 THEN 'ADMIN' ELSE 'SYSTEM' END, 'system:ci',
         CASE WHEN g % 1000 < $2::numeric * 1000 THEN 'ANAT_RULES_DRAFT_SAVED' WHEN g % 1000 < $3::numeric * 1000 THEN 'TAXONOMY_CURATION_PUBLISHED' ELSE 'COMPANY_UPDATED' END,
         CASE WHEN g % 1000 < $2::numeric * 1000 THEN 'anatomy_rules' WHEN g % 1000 < $3::numeric * 1000 THEN 'taxonomy_curation' ELSE 'company' END,
         gen_random_uuid()::text, '{}'::jsonb, now() - (g || ' seconds')::interval
  FROM generate_series(1, $1) g`, [rows, ANAT_SHARE, ANAT_SHARE + GLOBAL_SHARE, tenants, TENANTS]);
await db.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
await db.query('VACUUM ANALYZE audit_log');

type Path = { name: string; role: string; user: string | null; tenant: string | null; sql: string; after?: boolean };
const PATHS: Path[] = [
  { name: 'worker: count global rows', role: 'radar_worker', user: null, tenant: null, sql: 'SELECT count(*) FROM audit_log WHERE tenant_id IS NULL' },
  { name: 'worker: latest 100 of a tenant', role: 'radar_worker', user: null, tenant: tenants[0]!, sql: `SELECT id FROM audit_log WHERE tenant_id = '${tenants[0]}' ORDER BY occurred_at DESC LIMIT 100` },
  { name: 'curator: count global rows', role: 'radar_taxonomy_curator', user: null, tenant: null, sql: 'SELECT count(*) FROM audit_log WHERE tenant_id IS NULL' },
  { name: 'app: tenant member, latest 100', role: 'radar_app', user: members[0]!, tenant: tenants[0]!, sql: `SELECT id FROM audit_log WHERE tenant_id = '${tenants[0]}' ORDER BY occurred_at DESC LIMIT 100` },
  { name: 'app: tenant member, count', role: 'radar_app', user: members[0]!, tenant: tenants[0]!, sql: 'SELECT count(*) FROM audit_log' },
  { name: 'app: platform admin, ANAT audit list (P3-D)', role: 'radar_app', user: admin, tenant: null, after: true,
    sql: "SELECT id FROM audit_log WHERE tenant_id IS NULL AND entity_type = 'anatomy_rules' ORDER BY occurred_at DESC LIMIT 500" },
];
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]! * 100) / 100; };
async function time(p: Path): Promise<{ ms: number; rows: number }> {
  const ms: number[] = []; let n = 0;
  for (let i = 0; i < repeats; i += 1) {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL ROLE ${p.role}`);
      if (p.user) await db.query("SELECT set_config('app.user_id', $1, true)", [p.user]);
      if (p.tenant) await db.query("SELECT set_config('app.tenant_id', $1, true)", [p.tenant]);
      const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${p.sql}`)).rows[0]['QUERY PLAN'][0];
      ms.push(plan['Execution Time']); n = plan.Plan['Actual Rows'];
    } finally { await db.query('ROLLBACK'); }
  }
  return { ms: median(ms), rows: n };
}
const before: Record<string, unknown> = {};
for (const p of PATHS.filter((x) => !x.after)) before[p.name] = await time(p);
await runProjectMigrations(DISPOSABLE_URL);
const after: Record<string, unknown> = {};
for (const p of PATHS) after[p.name] = await time(p);
const version = (await db.query('SHOW server_version')).rows[0].server_version;
await db.end();
console.log(JSON.stringify({ postgres: version, auditRows: rows, tenants: TENANTS, anatShare: ANAT_SHARE, otherGlobalShare: GLOBAL_SHARE,
  repeats, metric: 'EXPLAIN ANALYZE execution time, median, ms', before, after }));
