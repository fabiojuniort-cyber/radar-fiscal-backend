import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';
import { dropScratchDatabase, ignoreIdleClientErrors } from './scratch-database.js';

const SQL = join(resolve('ops/doe-sp'), 'sql');

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(url: string, file: string, vars: Record<string, string> = {}, readOnly = false): string {
  const args = [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
  args.push('-f', file);
  return execFileSync('psql', args, {
    encoding: 'utf8',
    env: { ...process.env, ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function rebuildArgs(url: string): { vars: Record<string, string>; blockers: Record<string, number> } {
  const out = psql(url, join(SQL, '20_dry_run_readonly.sql'), {}, true);
  const dryLine = out.split('\n').find((line) => line.startsWith('DOE_SP_DRY_RUN='));
  const argsLine = out.split('\n').find((line) => line.startsWith('DOE_SP_REBUILD_ARGS='));
  assert.ok(dryLine);
  assert.ok(argsLine);

  const dry = JSON.parse(dryLine.slice('DOE_SP_DRY_RUN='.length)) as {
    blockers: Record<string, number>;
  };
  const vars: Record<string, string> = {};
  for (const match of argsLine.slice('DOE_SP_REBUILD_ARGS='.length).matchAll(/-v (\w+)=(-?\d+)/g)) {
    vars[match[1]!] = match[2]!;
  }
  return { vars, blockers: dry.blockers };
}

test('DOE-SP rebuild explicitly blocks publication NCM evidence tied to scope versions', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const database = `doe_sp_ncm_guard_${randomBytes(4).toString('hex')}`;
  const databaseUrl = withDatabase(adminUrl, database);
  const admin = ignoreIdleClientErrors(new Pool({ connectionString: adminUrl, max: 1 }));
  let pool: Pool | undefined;
  let db: Kysely<DB> | undefined;

  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const schema = execFileSync(
      'pg_dump',
      ['--schema-only', '--no-owner', '--no-privileges', adminUrl],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
      input: schema,
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    pool = ignoreIdleClientErrors(new Pool({ connectionString: databaseUrl, max: 3 }));
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

    const source = await db.insertInto('sources').values({
      code: 'doe-sp',
      name: 'DOE SP',
      jurisdiction_level: 'STATE',
      uf: 'SP',
      base_url: 'https://doe.sp.gov.br',
      connector_key: 'doe-sp',
      schedule_cron: '0 7 * * *',
      is_active: false,
    }).returning('id').executeTakeFirstOrThrow();

    const run = await db.insertInto('collection_runs').values({
      source_id: source.id,
      scheduled_for: new Date('2026-09-01T10:00:00Z'),
      status: 'SUCCESS',
    }).returning('id').executeTakeFirstOrThrow();

    const attempt = await db.insertInto('collection_attempts').values({
      collection_run_id: run.id,
      attempt_no: 1,
      status: 'SUCCESS',
    }).returning('id').executeTakeFirstOrThrow();

    const persisted = await db.transaction().execute((trx) => persistPublication(trx, {
      sourceId: source.id,
      runId: run.id,
      attemptId: attempt.id,
      publication: normalizePublication({
        sourceId: source.id,
        publication: {
          title: 'PORTARIA SRE 1',
          agency: 'Secretaria da Fazenda e Planejamento',
          sphere: 'STATE',
          stateCode: 'SP',
          actType: 'PORTARIA',
          actNumber: '1',
          publishedAt: new Date('2025-03-01T00:00:00Z'),
          content: 'Texto oficial com referência ao NCM 31052000.',
          officialUrl: 'https://doe.sp.gov.br/ncm-guard-1',
          externalId: 'ncm-guard-1',
          metadata: { sourceRole: 'PRIMARY' },
        },
      }),
    }));

    await pool.query(
      `INSERT INTO publication_ncm_mentions (
         publication_version_id, ncm_code, method_type,
         detector_key, detector_version, excerpt
       ) VALUES ($1, '31052000', 'RULE', 'ncm-regex', '1', 'NCM 31052000')`,
      [persisted.publicationVersionId],
    );

    const dry = rebuildArgs(databaseUrl);
    assert.equal(dry.blockers.ncm_mentions, 1);
    assert.equal(dry.blockers.unknown_foreign_keys, 0);

    assert.throws(
      () => psql(
        databaseUrl,
        join(SQL, '30_rebuild_destructive.sql'),
        { ...dry.vars, confirm: 'REBUILD_DOE_SP' },
      ),
      /NCM mentions reference scope versions/,
    );

    const preserved = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM publication_versions WHERE id = $1',
      [persisted.publicationVersionId],
    );
    assert.equal(preserved.rows[0]?.count, '1', 'aborted rebuild preserves the publication version');
  } finally {
    if (db) await db.destroy();
    else if (pool) await pool.end();
    await dropScratchDatabase(admin, database);
    await admin.end();
  }
});
