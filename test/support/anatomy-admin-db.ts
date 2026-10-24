import { readFile } from 'node:fs/promises';
import type pg from 'pg';

/**
 * ANAT-ADMIN-01 (P3-D onward): prepares a FRESH disposable database with the accepted P3-B1 chain, in the same order as
 * the B1 test (bootstrap → 006 → 074[1–160] → 075 → grants/RLS → base schema → M_AUDIT_ANAT → M_ANAT_ADMIN), plus any
 * extra test/support SQL files. Every file carries its own disposable guard; the caller has already checked the env.
 */
const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
export const DISPOSABLE_URL = 'postgresql://postgres:postgres@localhost:5432/anat04_ci';

export async function prepareAdminDatabase(client: pg.Client, extra: string[] = []): Promise<void> {
  const fresh = await client.query("SELECT to_regclass('public.audit_log') IS NULL AND to_regclass('public.anatomy_rule_sets') IS NULL AS fresh");
  if (fresh.rows[0].fresh !== true) throw new Error('requires a fresh disposable database (the dedicated CI job provides one)');
  const chain = (f: string) => read(`anatomy-audit-chain/${f}`);
  const audit074 = (await chain('074_audit_allowlist_and_backfill.sql')).split('\n').slice(0, 160).join('\n');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL anatomy.ci_disposable = 'true'");
    await client.query(await read('anatomy-audit-bootstrap-pre.sql'));
    await client.query(await chain('006_audit.sql'));
    await client.query(audit074);
    await client.query(await chain('075_audit_historical_event_rules.sql'));
    await client.query(await read('anatomy-audit-bootstrap-post.sql'));
    await client.query(await read('anatomy-ci-schema.sql'));
    await client.query(await read('anatomy-admin-audit-policy.sql'));
    await client.query(await read('anatomy-admin-ci-schema.sql'));
    for (const name of extra) await client.query(await read(name));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
