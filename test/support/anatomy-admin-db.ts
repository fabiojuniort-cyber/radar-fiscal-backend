import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { runProjectMigrations } from './anatomy-migrations.js';

/**
 * ANAT-ADMIN-01 (P3-D onward): prepares a FRESH disposable database with the accepted P3-B1 chain, in the same order as
 * the B1 test (bootstrap → 006 → 074[1–160] → 075 → grants/RLS → base schema → M_AUDIT_ANAT → M_ANAT_ADMIN), plus any
 * extra test/support SQL files. Every file carries its own disposable guard; the caller has already checked the env.
 */
const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
export const DISPOSABLE_URL = 'postgresql://postgres:postgres@localhost:5432/anat04_ci';

/**
 * Real-chain mode (integration readiness): ANAT_MAIN_MIGRATIONS_DIR points to verified, unedited copies of main's
 * migrations (the CI job exports them from a checkout of main and records its SHA). They are applied in order, one
 * transaction per file like src/infrastructure/database/migrate.ts, INSTEAD of the vendored audit chain and bootstraps.
 */
export const REAL_CHAIN_DIR = process.env.ANAT_MAIN_MIGRATIONS_DIR || null;
export async function applyRealChain(client: pg.Client, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/u.test(f)).sort();
  if (files.length === 0) throw new Error('no migrations in ANAT_MAIN_MIGRATIONS_DIR');
  for (const f of files) {
    await client.query('BEGIN');
    try { await client.query(await readFile(join(dir, f), 'utf8')); await client.query('COMMIT'); } catch (error) {
      await client.query('ROLLBACK'); throw new Error(`real migration ${f} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return files;
}
/** The audit policy JSON of the LAST real migration that (re)defines audit_event_policy. */
export async function latestRealPolicyJson(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/u.test(f)).sort();
  let json: string | null = null;
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8');
    if (/FUNCTION public\.audit_event_policy/u.test(sql)) json = /\$json\$(.*?)\$json\$/su.exec(sql)?.[1] ?? json;
  }
  if (!json) throw new Error('no audit_event_policy in the real chain');
  return json;
}
/**
 * Integration package 2: with ANAT_PROJECT_MIGRATIONS=1 the project's REAL runner applies this branch's migrations
 * (main's chain + 077_anat_base + 078_anat_audit_policy + 079_anat_rules_admin) INSTEAD of every rehearsal SQL file.
 */
/**
 * Integration deltas authorised after the accepted rehearsal (COORD integration R1). They live ONLY in the numbered
 * migration 079, between markers; the rehearsal modes (vendored chain, real chain of main) apply the same block on top
 * of the unchanged rehearsal SQL, so every mode exercises the integration boundary.
 */
export async function integrationDeltaSql(): Promise<string> {
  const sql = await readFile(new URL('../../migrations/079_anat_rules_admin.sql', import.meta.url), 'utf8');
  const m = /-- BEGIN INTEGRATION DELTA P-INT-01[^\n]*\n([\s\S]*?)-- END INTEGRATION DELTA P-INT-01/u.exec(sql);
  if (!m) throw new Error('integration delta P-INT-01 not found in 079');
  return m[1]!;
}
export const PROJECT_MIGRATIONS = process.env.ANAT_PROJECT_MIGRATIONS === '1';
const BOOTSTRAPS = new Set(['anatomy-api-ci-bootstrap.sql']); // the real chain carries the real auth tables and grants

export async function prepareAdminDatabase(client: pg.Client, extra: string[] = []): Promise<void> {
  const fresh = await client.query("SELECT to_regclass('public.audit_log') IS NULL AND to_regclass('public.anatomy_rule_sets') IS NULL AS fresh");
  if (fresh.rows[0].fresh !== true) throw new Error('requires a fresh disposable database (the dedicated CI job provides one)');
  const chain = (f: string) => read(`anatomy-audit-chain/${f}`);
  const audit074 = (await chain('074_audit_allowlist_and_backfill.sql')).split('\n').slice(0, 160).join('\n');
  if (PROJECT_MIGRATIONS) {
    await runProjectMigrations(DISPOSABLE_URL);
    for (const name of extra) if (!BOOTSTRAPS.has(name)) {
      await client.query('BEGIN'); await client.query("SET LOCAL anatomy.ci_disposable = 'true'");
      await client.query(await read(name)); await client.query('COMMIT');
    }
    return;
  }
  if (REAL_CHAIN_DIR) await applyRealChain(client, REAL_CHAIN_DIR);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL anatomy.ci_disposable = 'true'");
    if (!REAL_CHAIN_DIR) {
      await client.query(await read('anatomy-audit-bootstrap-pre.sql'));
      await client.query(await chain('006_audit.sql'));
      await client.query(audit074);
      await client.query(await chain('075_audit_historical_event_rules.sql'));
      await client.query(await read('anatomy-audit-bootstrap-post.sql'));
    }
    await client.query(await read('anatomy-ci-schema.sql'));
    await client.query(await read('anatomy-admin-audit-policy.sql'));
    await client.query(await read('anatomy-admin-ci-schema.sql'));
    await client.query(await integrationDeltaSql());
    for (const name of extra) if (!(REAL_CHAIN_DIR && BOOTSTRAPS.has(name))) await client.query(await read(name));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
