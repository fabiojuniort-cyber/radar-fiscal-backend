import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';
import { dropScratchDatabase, ignoreIdleClientErrors } from './scratch-database.js';

/*
 * DOE-SP-38: ops/doe-sp/runner/execute.sh is the only way the rebuild steps
 * reach production. This drives the real script against a disposable
 * database: refusals before any connection, the full 25 -> 20 -> 30 dry ->
 * 30 commit (+40) -> 50 sequence, a partial recapture and the self-validating
 * rollback from a dump on the "volume".
 */

const OPS = resolve('ops/doe-sp');
const SQL = join(OPS, 'sql');

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/' + database;
  return parsed.toString();
}

/** Server binaries (initdb/pg_ctl) with client tools of the same major. */
function pgBinDir(): string {
  const root = '/usr/lib/postgresql';
  assert.ok(existsSync(root), 'PostgreSQL server binaries are required for the rollback step');
  const majors = readdirSync(root).filter((d) => existsSync(join(root, d, 'bin', 'initdb'))).sort((a, b) => Number(b) - Number(a));
  assert.ok(majors.length > 0, 'initdb not found under /usr/lib/postgresql/*/bin');
  return join(root, majors[0]!, 'bin');
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('DOE-SP-38: execute.sh refuses unsafe input and runs pause -> rebuild -> resume -> rollback', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for the DOE-SP execution runner test.');
  const bin = pgBinDir();
  const suffix = randomBytes(4).toString('hex');
  const opsDb = 'doe_sp_ops_exec_' + suffix;
  const opsUrl = withDatabase(adminUrl, opsDb);
  const dataDir = mkdtempSync(join(tmpdir(), 'doe-sp-exec-'));
  chmodSync(dataDir, 0o711);
  const admin = ignoreIdleClientErrors(new Pool({ connectionString: adminUrl, max: 1 }));
  let db: Kysely<DB> | undefined;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  const psql = (file: string, readOnly = false) => execFileSync('psql', [opsUrl, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8', env: { ...env, ...(readOnly ? { PGOPTIONS: '-c default_transaction_read_only=on' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const manifest = () => sha(psql(join(SQL, '11_private_manifest_readonly.sql'), true));
  const others = () => psql(join(SQL, '13_other_sources_fingerprint_readonly.sql'), true);
  const counts = () => psql(join(SQL, '12_table_counts_readonly.sql'), true);
  const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19) + 'Z';
  let seq = 0;

  function run(step: string, extra: Record<string, string> = {}, execId = `t-${suffix}-${++seq}`) {
    const r = spawnSync('bash', [join(OPS, 'runner/execute.sh')], {
      encoding: 'utf8',
      env: {
        ...env,
        PROD_DATABASE_URL: opsUrl, DATA_DIR: dataDir, OPS_DIR: OPS,
        AS_POSTGRES: process.getuid?.() === 0 ? 'runuser -u postgres --' : '',
        DOE_SP_STEP: step, DOE_SP_EXEC_ID: execId, DOE_SP_NOT_AFTER: future, ...extra,
      },
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('DOE_SP_EXEC_RESULT='));
    assert.ok(line, `no result line for ${step}: ${r.stdout}\n${r.stderr}`);
    return { code: r.status, out: r.stdout, err: r.stderr, result: JSON.parse(line.slice('DOE_SP_EXEC_RESULT='.length)) as { status: string; detail: string } };
  }

  try {
    await admin.query(`CREATE DATABASE ${opsDb}`);
    const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('psql', [opsUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, env, stdio: ['pipe', 'ignore', 'pipe'] });
    const pool = ignoreIdleClientErrors(new Pool({ connectionString: opsUrl, max: 2 }));
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    await pool.query(`CREATE TABLE norma_clara_translations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      publication_version_id UUID NOT NULL REFERENCES publication_versions(id) ON DELETE CASCADE, segment_hash CHAR(64) NOT NULL,
      engine_version TEXT NOT NULL, model TEXT NOT NULL, translation_text TEXT NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(publication_version_id, segment_hash, engine_version))`);

    const doeSp = randomUUID();
    const dou = randomUUID();
    await db.insertInto('sources').values([
      { id: doeSp, code: 'doe-sp', name: 'DOE SP', jurisdiction_level: 'STATE', uf: 'SP', base_url: 'https://doe.sp.gov.br', connector_key: 'doe-sp', schedule_cron: '0 7 * * *' },
      { id: dou, code: 'dou', name: 'DOU', jurisdiction_level: 'FEDERAL', base_url: 'https://in.gov.br', connector_key: 'dou', schedule_cron: '0 8 * * *' },
    ]).execute();
    const newRun = async (sourceId: string, at: string) => {
      const runId = (await db!.insertInto('collection_runs').values({ source_id: sourceId, scheduled_for: new Date(at), status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      const attemptId = (await db!.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      return { runId, attemptId };
    };
    const persist = (sourceId: string, ids: { runId: string; attemptId: string }, publication: ConnectorPublication) =>
      db!.transaction().execute((trx) => persistPublication(trx, { sourceId, runId: ids.runId, attemptId: ids.attemptId, publication: normalizePublication({ sourceId, publication }) }));
    const doeRun = await newRun(doeSp, '2026-09-01T10:00:00Z');
    for (let n = 1; n <= 3; n += 1) {
      await persist(doeSp, doeRun, {
        title: 'PORTARIA SRE ' + n, agency: 'Secretaria da Fazenda e Planejamento', sphere: 'STATE', stateCode: 'SP', actType: 'PORTARIA', actNumber: String(n),
        publishedAt: new Date('2025-03-0' + n + 'T00:00:00Z'), content: 'Texto oficial integral do ato ' + n, officialUrl: 'https://doe.sp.gov.br/a' + n,
        externalId: randomUUID(), contentHashPolicy: 'HTML_PRIMARY_MATERIAL_FILES',
        metadata: { sourceRole: 'PRIMARY', doeDate: '2025-03-0' + n, officialContentCompleteness: 'FULL_OFFICIAL_CONTENT' },
        originMetadata: { authenticatedPdf: 'NOT_REQUESTED_REDUNDANT', contentRepresentation: 'OFFICIAL_HTML' },
      });
    }
    await sql`INSERT INTO collection_checkpoints (source_id, connector_key, state_version, generation, payload, payload_sha256, payload_bytes, produced_by_run_id)
      VALUES (${doeSp}, 'doe-sp', 1, 1, '{"coverageFrom":"2025-01-01","pendingRanges":[{"from":"2025-07-29","to":"2025-12-31"}],"days":{}}', ${'0'.repeat(64)}, 10, ${doeRun.runId})`.execute(db);
    const douRun = await newRun(dou, '2026-09-01T11:00:00Z');
    const douPub = await persist(dou, douRun, {
      title: 'LEI FEDERAL 1', agency: 'Congresso', sphere: 'FEDERAL', actType: 'LEI', actNumber: '1', publishedAt: new Date('2026-01-10T00:00:00Z'),
      content: 'lei federal', officialUrl: 'https://in.gov.br/l1', externalId: 'l1', metadata: { sourceRole: 'PRIMARY' },
    });
    await sql`INSERT INTO norma_clara_translations (publication_version_id, segment_hash, engine_version, model, translation_text)
      VALUES (${douPub.publicationVersionId}, ${'8'.repeat(64)}, 'v1', 'm', 'traducao federal')`.execute(db);

    const manifest0 = manifest();
    const others0 = others();
    const counts0 = counts();

    // Verified backup on the "volume", as prep.sh leaves it.
    const backupDir = join(dataDir, 'doe-sp-31', 'test', 'backup');
    mkdirSync(backupDir, { recursive: true });
    const dump = join(backupDir, 'radar-fiscal-test.dump');
    execFileSync('pg_dump', [opsUrl, '--format=custom', '--file=' + dump], { env });
    const dumpSha = execFileSync('sha256sum', [dump], { encoding: 'utf8' }).split(' ')[0]!;
    chmodSync(join(dataDir, 'doe-sp-31'), 0o711);

    // ---- refusals before any database access
    assert.equal(run('drop_everything').result.detail, 'unknown_step');
    assert.equal(run('pause').result.detail, 'confirm_mismatch');
    assert.equal(run('pause', { DOE_SP_CONFIRM: 'REBUILD_DOE_SP' }).result.detail, 'confirm_mismatch');
    assert.equal(run('dry_run', {}, 'BAD ID').result.detail, 'invalid_exec_id');
    assert.equal(run('dry_run', { DOE_SP_NOT_AFTER: '2020-01-01T00:00:00Z' }).result.detail, 'deadline_passed');
    assert.equal(run('rebuild_dry', { DOE_SP_REBUILD_ARGS: '-v expected_publications_kept=3; DROP TABLE sources' }).result.detail, 'invalid_rebuild_args');
    assert.equal(run('rollback', { DOE_SP_CONFIRM: 'ROLLBACK_DOE_SP', DOE_SP_ROLLBACK_DUMP_SHA256: 'x' }).result.detail, 'invalid_dump_sha256');
    const once = `t-${suffix}-once`;
    assert.equal(run('dry_run', {}, once).result.status, 'PASS');
    assert.equal(run('dry_run', {}, once).result.detail, 'exec_id_already_used', 'an accidental redeploy never runs twice');
    assert.equal(manifest(), manifest0, 'refusals changed nothing');

    // ---- pause, dry-run
    const paused = run('pause', { DOE_SP_CONFIRM: 'PAUSE_DOE_SP' });
    assert.equal(paused.result.status, 'PASS');
    assert.match(paused.out, /^DOE_SP_PAUSED$/m);
    const dry = run('dry_run');
    const args = dry.out.split('\n').find((l) => l.startsWith('DOE_SP_REBUILD_ARGS='))!.slice('DOE_SP_REBUILD_ARGS='.length);
    assert.match(args, /-v expected_publications_kept=3 /);

    // ---- 30 guarded by a fresh dry-run in the same execution
    const wrong = args.replace('expected_publications_kept=3', 'expected_publications_kept=4');
    assert.equal(run('rebuild_dry', { DOE_SP_REBUILD_ARGS: wrong }).result.detail, 'rebuild_args_differ_from_fresh_dry_run');
    assert.equal(run('rebuild_commit', { DOE_SP_REBUILD_ARGS: args }).result.detail, 'confirm_mismatch');
    const dryExec = run('rebuild_dry', { DOE_SP_REBUILD_ARGS: args });
    assert.equal(dryExec.result.status, 'PASS');
    assert.match(dryExec.out, /DOE_SP_REBUILD_ROLLED_BACK/);
    assert.equal(manifest(), manifest0, 'dry execution left data intact');
    const commit = run('rebuild_commit', { DOE_SP_REBUILD_ARGS: args, DOE_SP_CONFIRM: 'REBUILD_DOE_SP' });
    assert.equal(commit.result.status, 'PASS', commit.err);
    assert.match(commit.out, /^DOE_SP_REBUILD_COMMITTED$/m);
    assert.match(commit.out, /^DOE_SP_POST_REBUILD=PASS$/m);
    assert.equal(run('validate_40', { DOE_SP_REBUILD_ARGS: args }).result.status, 'PASS');
    assert.equal(run('rebuild_commit', { DOE_SP_REBUILD_ARGS: args, DOE_SP_CONFIRM: 'REBUILD_DOE_SP' }).result.status, 'FAILED', 'a second commit is blocked by the fresh dry-run');

    // ---- resume, partial recapture, pause, rollback from the dump
    assert.equal(run('resume', { DOE_SP_CONFIRM: 'RESUME_DOE_SP' }).result.status, 'PASS');
    assert.match(psql(join(OPS, 'rehearsal/partial_recapture_sim.sql')), /DOE_SP_SIM_RECAPTURE=/);
    assert.notEqual(manifest(), manifest0);
    // 41 closes the recapture only on RUNBOOK §6 step 11: a partial one fails.
    const partial = run('validate_41');
    assert.equal(partial.result.status, 'FAILED', partial.out);
    assert.equal(partial.result.detail, 'post_recapture_criteria_not_met');
    assert.match(partial.out, /^DOE_SP_POST_RECAPTURE=/m);
    assert.match(partial.out, /^DOE_SP_POST_RECAPTURE_UNMET=\["pendingRanges","publicationsWithoutVersionOrOrigin"\]$/m);
    // Converge it: the last preserved publication recaptured, no pending range.
    await sql`WITH orphan AS (
        SELECT p.id, gen_random_uuid() AS version_id FROM publications p
        WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)),
      origin AS (INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, metadata)
        SELECT o.id, ${doeSp}, 'conv-' || o.id, 'https://doe.sp.gov.br/conv/' || o.id, '{}' FROM orphan o)
      INSERT INTO publication_versions (id, publication_id, version_no, content_hash, content_text, source_metadata, is_current)
      SELECT o.version_id, o.id, 1, encode(sha256(convert_to('conv' || o.id, 'UTF8')), 'hex'), 'texto recapturado', '{"contentHashVersion":2}', true FROM orphan o`.execute(db);
    await sql`INSERT INTO collection_checkpoints (source_id, connector_key, state_version, generation, payload, payload_sha256, payload_bytes, produced_by_run_id)
      SELECT ${doeSp}, 'doe-sp', 1, 2, '{"coverageFrom":"2025-01-01","pendingRanges":[],"days":{}}', ${'c'.repeat(64)}, 60, cr.id
      FROM collection_runs cr WHERE cr.source_id = ${doeSp} ORDER BY cr.created_at DESC LIMIT 1`.execute(db);
    const converged = run('validate_41');
    assert.equal(converged.result.status, 'PASS', converged.out);
    assert.doesNotMatch(converged.out, /DOE_SP_POST_RECAPTURE_UNMET/);
    assert.equal(run('pause', { DOE_SP_CONFIRM: 'PAUSE_DOE_SP' }).result.status, 'PASS');
    assert.equal(run('rollback', { DOE_SP_CONFIRM: 'ROLLBACK_DOE_SP', DOE_SP_ROLLBACK_DUMP_SHA256: 'f'.repeat(64) }).result.detail, 'dump_not_found_on_volume');
    const rollback = run('rollback', { DOE_SP_CONFIRM: 'ROLLBACK_DOE_SP', DOE_SP_ROLLBACK_DUMP_SHA256: dumpSha });
    assert.equal(rollback.result.status, 'PASS', rollback.out + rollback.err);
    assert.equal(rollback.result.detail, 'manifest_equals_backup');
    assert.match(rollback.out, /^DOE_SP_ROLLBACK_RESULT=/m);
    assert.equal(manifest(), manifest0, 'production manifest equals the backup');
    assert.equal(others(), others0, 'other sources untouched');
    assert.equal(run('resume', { DOE_SP_CONFIRM: 'RESUME_DOE_SP' }).result.status, 'PASS');
    assert.equal(counts(), counts0, 'every table count back to the backup');
    assert.equal(readdirSync(dataDir).filter((d) => d.startsWith('doe-sp-exec-pgtmp')).length, 0, 'temporary PostgreSQL removed');
  } finally {
    await db?.destroy();
    await dropScratchDatabase(admin, opsDb).catch(() => undefined);
    await admin.end();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
