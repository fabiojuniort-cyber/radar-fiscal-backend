import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';
import { dropScratchDatabase, ignoreIdleClientErrors } from './scratch-database.js';

/**
 * P-INT-02 (ANAT-ADMIN-01 integration R1; forwarded to the DOE-SP front): the DOE-SP rebuild recognises ONLY the two
 * ANAT foreign keys of 077 by exact definition and stops, before deleting anything, when ANAT analyses or run items
 * reference scope versions. Scratch databases copied from the regression schema, synthetic DOE-SP data only.
 */
const SQL = join(resolve('ops/doe-sp'), 'sql');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ANAT_TABLES = ['anatomy_run_items', 'anatomy_runs', 'anatomy_dependencies', 'anatomy_evidence', 'anatomy_entities', 'anatomy_parts',
  'publication_anatomies', 'anatomy_rule_sets'];

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url); parsed.pathname = `/${database}`; return parsed.toString();
}
function psql(url: string, file: string, vars: Record<string, string> = {}, readOnly = false): string {
  const args = [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
  args.push('-f', file);
  return execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}) } });
}
function dryRun(url: string): { vars: Record<string, string>; blockers: Record<string, number> } {
  const out = psql(url, join(SQL, '20_dry_run_readonly.sql'), {}, true);
  const dry = out.split('\n').find((l) => l.startsWith('DOE_SP_DRY_RUN='))!;
  const args = out.split('\n').find((l) => l.startsWith('DOE_SP_REBUILD_ARGS='))!;
  const vars: Record<string, string> = {};
  for (const m of args.slice('DOE_SP_REBUILD_ARGS='.length).matchAll(/-v (\w+)=(-?\d+)/g)) vars[m[1]!] = m[2]!;
  return { vars, blockers: (JSON.parse(dry.slice('DOE_SP_DRY_RUN='.length)) as { blockers: Record<string, number> }).blockers };
}

type Case = { url: string; pool: Pool; versionId: string; snapshot: () => Promise<string> };
async function withScratch(label: string, body: (c: Case) => Promise<void>, prepare?: (pool: Pool) => Promise<void>): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL; assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');
  const database = `doe_sp_anat_${label}_${randomBytes(3).toString('hex')}`;
  const url = withDatabase(adminUrl, database);
  const admin = ignoreIdleClientErrors(new Pool({ connectionString: adminUrl, max: 1 }));
  let pool: Pool | undefined; let db: Kysely<DB> | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, stdio: ['pipe', 'ignore', 'pipe'] });
    pool = ignoreIdleClientErrors(new Pool({ connectionString: url, max: 3 }));
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    if (prepare) await prepare(pool);
    const source = await db.insertInto('sources').values({ code: 'doe-sp', name: 'DOE SP', jurisdiction_level: 'STATE', uf: 'SP',
      base_url: 'https://doe.sp.gov.br', connector_key: 'doe-sp', schedule_cron: '0 7 * * *', is_active: false }).returning('id').executeTakeFirstOrThrow();
    const run = await db.insertInto('collection_runs').values({ source_id: source.id, scheduled_for: new Date('2026-09-01T10:00:00Z'), status: 'SUCCESS' })
      .returning('id').executeTakeFirstOrThrow();
    const attempt = await db.insertInto('collection_attempts').values({ collection_run_id: run.id, attempt_no: 1, status: 'SUCCESS' })
      .returning('id').executeTakeFirstOrThrow();
    const persisted = await db.transaction().execute((trx) => persistPublication(trx, { sourceId: source.id, runId: run.id, attemptId: attempt.id,
      publication: normalizePublication({ sourceId: source.id, publication: { title: 'PORTARIA SRE 9', agency: 'Secretaria da Fazenda e Planejamento',
        sphere: 'STATE', stateCode: 'SP', actType: 'PORTARIA', actNumber: '9', publishedAt: new Date('2025-03-01T00:00:00Z'),
        content: 'Texto sintético.', officialUrl: 'https://doe.sp.gov.br/anat-guard-9', externalId: 'anat-guard-9', metadata: { sourceRole: 'PRIMARY' } } }) }));
    const snapshot = async () => JSON.stringify((await pool!.query(`SELECT
      (SELECT count(*) FROM publications) AS p, (SELECT count(*) FROM publication_versions) AS v, (SELECT count(*) FROM publication_origins) AS o,
      (SELECT CASE WHEN to_regclass('public.publication_anatomies') IS NULL THEN -1 ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.publication_anatomies', false, true, '')))[1]::text::int END) AS a,
      (SELECT CASE WHEN to_regclass('public.anatomy_run_items') IS NULL THEN -1 ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.anatomy_run_items', false, true, '')))[1]::text::int END) AS i`)).rows[0]);
    await body({ url, pool, versionId: persisted.publicationVersionId, snapshot });
  } finally {
    if (db) await db.destroy(); else if (pool) await pool.end();
    await dropScratchDatabase(admin, database);
    await admin.end();
  }
}
const ruleSet = (pool: Pool) => pool.query(`INSERT INTO anatomy_rule_sets (id, version, status, rule_hash, contract_version, profiles, author)
  VALUES ('rs-doe', '1', 'reviewed', $1, 'v1', '[]', 'system:ci')`, [sha('rules')]);
const analysis = (pool: Pool, versionId: string) => pool.query(`INSERT INTO publication_anatomies (id, publication_version_id, representation_id, source,
  input_text_hash, attachment_manifest_hash, engine_version, engine_hash, rule_set_id, rule_set_hash, contract_version, status, text_length, coverage, output_hash)
  VALUES ($1, $2, 'r1', 'DOE-SP', $3, $3, 'e1', $3, 'rs-doe', $4, 'v1', 'complete', 16, '{}', $3)`, [sha('a-doe'), versionId, sha('in'), sha('rules')]);
const rebuild = (c: Case, vars: Record<string, string>) => psql(c.url, join(SQL, '30_rebuild_destructive.sql'), { ...vars, confirm: 'REBUILD_DOE_SP' });

test('schema before 077 (no ANAT table): dry-run and rebuild work, no ANAT name is resolved', async () => {
  await withScratch('pre077', async (c) => {
    const dry = dryRun(c.url);
    assert.deepEqual([dry.blockers.unknown_foreign_keys, dry.blockers.anatomy_analyses, dry.blockers.anatomy_run_items], [0, 0, 0]);
    assert.match(rebuild(c, dry.vars), /DOE_SP_REBUILD_COMMITTED/);
  }, async (pool) => {
    for (const t of ANAT_TABLES) await pool.query(`DROP TABLE IF EXISTS public.${t} CASCADE`);
    assert.equal((await pool.query("SELECT to_regclass('public.publication_anatomies') IS NULL AS ok")).rows[0].ok, true);
  });
});

test('077 present with empty ANAT tables: the two ANAT FKs are recognised, nothing blocks, rebuild commits', async () => {
  await withScratch('empty', async (c) => {
    const dry = dryRun(c.url);
    assert.deepEqual([dry.blockers.unknown_foreign_keys, dry.blockers.anatomy_analyses, dry.blockers.anatomy_run_items], [0, 0, 0]);
    assert.match(rebuild(c, dry.vars), /DOE_SP_REBUILD_COMMITTED/);
  });
});

test('an ANAT analysis of a scope version blocks dry-run and rebuild; data intact after the refusal', async () => {
  await withScratch('analysis', async (c) => {
    await ruleSet(c.pool); await analysis(c.pool, c.versionId);
    const dry = dryRun(c.url);
    assert.equal(dry.blockers.anatomy_analyses, 1); assert.equal(dry.blockers.unknown_foreign_keys, 0);
    const before = await c.snapshot();
    assert.throws(() => rebuild(c, dry.vars), /anatomy analyses reference scope versions/);
    assert.equal(await c.snapshot(), before, 'refused rebuild changed nothing');
  });
});

test('an ANAT run item of a scope version blocks dry-run and rebuild; data intact after the refusal', async () => {
  await withScratch('runitem', async (c) => {
    await ruleSet(c.pool);
    await c.pool.query(`INSERT INTO anatomy_runs (id, manifest_hash, scope, engine_version, rule_set_id, rule_set_hash, initiator, started_at, counters)
      VALUES ('run-doe', $1, '{}', 'e1', 'rs-doe', $2, 'system:ci', now(), '{}')`, [sha('m'), sha('rules')]);
    await c.pool.query(`INSERT INTO anatomy_run_items (run_id, id, publication_version_id, input_text_hash, engine_version, rule_set_id, rule_set_hash,
      status, attempt, expected_analysis_id) VALUES ('run-doe', 'i1', $1, $2, 'e1', 'rs-doe', $3, 'pending', 1, $4)`, [c.versionId, sha('in'), sha('rules'), sha('x')]);
    const dry = dryRun(c.url);
    assert.equal(dry.blockers.anatomy_run_items, 1); assert.equal(dry.blockers.anatomy_analyses, 0);
    const before = await c.snapshot();
    assert.throws(() => rebuild(c, dry.vars), /anatomy run items reference scope versions/);
    assert.equal(await c.snapshot(), before, 'refused rebuild changed nothing');
  });
});

test('unknown FK to publication_versions still blocks (schema drift), and an ANAT name alone is not enough', async () => {
  await withScratch('unknownfk', async (c) => {
    await c.pool.query('CREATE TABLE stray_version_ref (v uuid REFERENCES publication_versions(id))');
    const dry = dryRun(c.url);
    assert.equal(dry.blockers.unknown_foreign_keys, 1);
    const before = await c.snapshot();
    assert.throws(() => rebuild(c, dry.vars), /unknown foreign keys reference publications\/versions/);
    assert.equal(await c.snapshot(), before);
  });
  await withScratch('lookalike', async (c) => {
    // Same constraint name, different behaviour (CASCADE): not the 077 definition, so it is unknown.
    await c.pool.query(`ALTER TABLE publication_anatomies DROP CONSTRAINT publication_anatomies_publication_version_id_fkey,
      ADD CONSTRAINT publication_anatomies_publication_version_id_fkey FOREIGN KEY (publication_version_id) REFERENCES publication_versions(id) ON DELETE CASCADE`);
    const dry = dryRun(c.url);
    assert.equal(dry.blockers.unknown_foreign_keys, 1);
    assert.throws(() => rebuild(c, dry.vars), /unknown foreign keys/);
  });
});
