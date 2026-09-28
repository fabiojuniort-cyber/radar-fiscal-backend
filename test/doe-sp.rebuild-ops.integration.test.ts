import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { createScheduledCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';

/*
 * DOE-SP-33: end-to-end rehearsal of ops/doe-sp against a disposable
 * database. The partial recapture between 30 and the rollback uses the real
 * normalizer/persistence code, so the rollback is proven against what a real
 * run writes (canonical fields changed on preserved ids, new publication,
 * items, run links, checkpoint), not against a hand-written approximation.
 */

const OPS = resolve('ops/doe-sp');
const SQL = join(OPS, 'sql');

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/' + database;
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

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const manifest = (url: string) => sha(psql(url, join(SQL, '11_private_manifest_readonly.sql'), {}, true));
const others = (url: string) => psql(url, join(SQL, '13_other_sources_fingerprint_readonly.sql'), {}, true);
const counts = (url: string) => psql(url, join(SQL, '12_table_counts_readonly.sql'), {}, true);

function rebuildArgs(url: string): { vars: Record<string, string>; blockers: Record<string, number> } {
  const out = psql(url, join(SQL, '20_dry_run_readonly.sql'), {}, true);
  const dry = JSON.parse(out.split('\n').find((line) => line.startsWith('DOE_SP_DRY_RUN='))!.slice('DOE_SP_DRY_RUN='.length));
  const args = out.split('\n').find((line) => line.startsWith('DOE_SP_REBUILD_ARGS='))!.slice('DOE_SP_REBUILD_ARGS='.length);
  const vars: Record<string, string> = {};
  for (const match of args.matchAll(/-v (\w+)=(-?\d+)/g)) vars[match[1]!] = match[2]!;
  return { vars, blockers: dry.blockers };
}

function doeSpAct(n: number, title: string, url: string): ConnectorPublication {
  return {
    title,
    agency: 'Secretaria da Fazenda e Planejamento',
    sphere: 'STATE',
    stateCode: 'SP',
    actType: 'PORTARIA',
    actNumber: String(n),
    publishedAt: new Date('2025-03-0' + n + 'T00:00:00Z'),
    content: 'Texto oficial integral do ato ' + n + ' — ' + title,
    officialUrl: url,
    externalId: randomUUID(),
    contentHashPolicy: 'HTML_PRIMARY_MATERIAL_FILES',
    metadata: { sourceRole: 'PRIMARY', doeDate: '2025-03-0' + n, officialContentCompleteness: 'FULL_OFFICIAL_CONTENT' },
    originMetadata: { authenticatedPdf: 'NOT_REQUESTED_REDUNDANT', contentRepresentation: 'OFFICIAL_HTML' },
  };
}

test('DOE-SP-33: 30 -> real partial recapture -> rollback restores the backup manifest; guards hold', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for the DOE-SP ops rehearsal.');
  const suffix = randomBytes(4).toString('hex');
  const opsDb = 'doe_sp_ops_' + suffix;
  const bakDb = 'doe_sp_ops_bak_' + suffix;
  const opsUrl = withDatabase(adminUrl, opsDb);
  const bakUrl = withDatabase(adminUrl, bakDb);
  const tmp = mkdtempSync(join(tmpdir(), 'doe-sp-ops-'));
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let pool: Pool | undefined;
  let db: Kysely<DB> | undefined;

  try {
    await admin.query(`CREATE DATABASE ${opsDb}`);
    await admin.query(`CREATE DATABASE ${bakDb}`);
    const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    execFileSync('psql', [opsUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, stdio: ['pipe', 'ignore', 'pipe'] });
    pool = new Pool({ connectionString: opsUrl, max: 3 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS norma_clara_translations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        publication_version_id UUID NOT NULL REFERENCES publication_versions(id) ON DELETE CASCADE,
        segment_hash CHAR(64) NOT NULL, engine_version TEXT NOT NULL, model TEXT NOT NULL,
        translation_text TEXT NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(publication_version_id, segment_hash, engine_version))`);

    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

    const doeSp = randomUUID();
    const dou = randomUUID();
    await db.insertInto('sources').values([
      { id: doeSp, code: 'doe-sp', name: 'DOE SP', jurisdiction_level: 'STATE', uf: 'SP', base_url: 'https://doe.sp.gov.br', connector_key: 'doe-sp', schedule_cron: '0 7 * * *' },
      { id: dou, code: 'dou', name: 'DOU', jurisdiction_level: 'FEDERAL', base_url: 'https://in.gov.br', connector_key: 'dou', schedule_cron: '0 8 * * *' },
    ]).execute();

    const run = async (sourceId: string, at: string) => {
      const runId = (await db!.insertInto('collection_runs').values({ source_id: sourceId, scheduled_for: new Date(at), status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      const attemptId = (await db!.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      return { runId, attemptId };
    };
    const persist = async (sourceId: string, ids: { runId: string; attemptId: string }, publication: ConnectorPublication) =>
      db!.transaction().execute((trx) => persistPublication(trx, {
        sourceId, runId: ids.runId, attemptId: ids.attemptId, publication: normalizePublication({ sourceId, publication }),
      }));

    // ---- initial state: 3 DOE-SP acts, 1 DOU act (+ translation), checkpoint
    const doeRun = await run(doeSp, '2026-09-01T10:00:00Z');
    const act1 = doeSpAct(1, 'PORTARIA SRE 1, DE 1 DE MARÇO DE 2025', 'https://doe.sp.gov.br/a1');
    const p1 = await persist(doeSp, doeRun, act1);
    await persist(doeSp, doeRun, doeSpAct(2, 'PORTARIA SRE 2', 'https://doe.sp.gov.br/a2'));
    await persist(doeSp, doeRun, doeSpAct(3, 'PORTARIA SRE 3', 'https://doe.sp.gov.br/a3'));
    await sql`INSERT INTO collection_checkpoints (source_id, connector_key, state_version, generation, payload, payload_sha256, payload_bytes, produced_by_run_id)
      VALUES (${doeSp}, 'doe-sp', 1, 1, '{"coverageFrom":"2025-01-01","pendingRanges":[{"from":"2025-07-29","to":"2025-12-31"}],"days":{}}', ${'0'.repeat(64)}, 10, ${doeRun.runId})`.execute(db);
    const douRun = await run(dou, '2026-09-01T11:00:00Z');
    const douPub = await persist(dou, douRun, {
      title: 'LEI FEDERAL 1', agency: 'Congresso', sphere: 'FEDERAL', actType: 'LEI', actNumber: '1',
      publishedAt: new Date('2026-01-10T00:00:00Z'), content: 'lei federal', officialUrl: 'https://in.gov.br/l1', externalId: 'l1',
      metadata: { sourceRole: 'PRIMARY' },
    });
    await sql`INSERT INTO norma_clara_translations (publication_version_id, segment_hash, engine_version, model, translation_text)
      VALUES (${douPub.publicationVersionId}, ${'8'.repeat(64)}, 'v1', 'm', 'traducao federal')`.execute(db);

    const manifest0 = manifest(opsUrl);
    const others0 = others(opsUrl);
    const counts0 = counts(opsUrl);

    // ---- verified backup (dump + restore into a second database)
    const dump = join(tmp, 'backup.dump');
    execFileSync('pg_dump', [opsUrl, '--format=custom', '--file=' + dump]);
    execFileSync('pg_restore', ['--exit-on-error', '--no-owner', '--dbname=' + bakUrl, dump]);
    assert.equal(manifest(bakUrl), manifest0, 'backup restore reproduces the manifest');

    // ---- pause; after it no scheduled run can be created
    psql(opsUrl, join(SQL, '25_pause_source.sql'));
    assert.equal(await createScheduledCollectionRun(db, { sourceId: doeSp, scheduledFor: new Date('2026-09-28T10:00:00Z'), triggerType: 'SCHEDULED' }), undefined);

    const dry = rebuildArgs(opsUrl);
    assert.ok(Object.values(dry.blockers).every((value) => value === 0), JSON.stringify(dry.blockers));
    assert.equal(dry.vars.expected_publications_kept, '3');

    // ---- guards: foreign item and scope translation abort 30 without changes
    const foreignItem = await db.insertInto('collection_items').values({
      collection_run_id: douRun.runId, source_item_key: 'foreign', status: 'PROCESSED_EXISTING', publication_id: p1.publicationId,
    }).returning('id').executeTakeFirstOrThrow();
    assert.throws(() => psql(opsUrl, join(SQL, '30_rebuild_destructive.sql'), { ...dry.vars, confirm: 'REBUILD_DOE_SP' }), /collection_items of other sources/);
    await db.deleteFrom('collection_items').where('id', '=', foreignItem.id).execute();
    await sql`INSERT INTO norma_clara_translations (publication_version_id, segment_hash, engine_version, model, translation_text)
      VALUES (${p1.publicationVersionId}, ${'9'.repeat(64)}, 'old', 'm', 'traducao antiga do DOE-SP')`.execute(db);
    assert.throws(() => psql(opsUrl, join(SQL, '30_rebuild_destructive.sql'), { ...dry.vars, confirm: 'REBUILD_DOE_SP' }), /norma_clara_translations reference scope versions/);
    await sql`DELETE FROM norma_clara_translations WHERE engine_version = 'old'`.execute(db);
    assert.equal(manifest(opsUrl), manifest0, 'aborted 30 changed nothing');

    // ---- 30 + 40
    assert.match(psql(opsUrl, join(SQL, '30_rebuild_destructive.sql'), { ...dry.vars, confirm: 'REBUILD_DOE_SP' }), /DOE_SP_REBUILD_COMMITTED/);
    assert.match(psql(opsUrl, join(SQL, '40_post_rebuild_validation.sql'), { expected_publications_kept: '3' }, true), /DOE_SP_POST_REBUILD=PASS/);

    // ---- resume and REAL partial recapture
    psql(opsUrl, join(SQL, '50_resume_source.sql'));
    const recaptureRunId = await createScheduledCollectionRun(db, { sourceId: doeSp, scheduledFor: new Date('2026-09-29T10:00:00Z'), triggerType: 'SCHEDULED' });
    assert.ok(recaptureRunId, 'active source gets its scheduled run');
    const recaptureAttempt = (await db.insertInto('collection_attempts').values({ collection_run_id: recaptureRunId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
    const recapture = { runId: recaptureRunId, attemptId: recaptureAttempt };
    const changed = await persist(doeSp, recapture, { ...doeSpAct(1, 'PORTARIA SRE 1 (TÍTULO RETIFICADO)', 'https://doe.sp.gov.br/a1-new'), effectiveAt: new Date('2025-04-01T00:00:00Z') });
    assert.equal(changed.publicationId, p1.publicationId, 'recapture reuses the preserved id');
    const brandNew = await persist(doeSp, recapture, doeSpAct(4, 'PORTARIA SRE 4 (NOVA NA RECAPTURA)', 'https://doe.sp.gov.br/a4'));
    assert.equal(brandNew.disposition, 'NEW_PUBLICATION');
    await sql`INSERT INTO norma_clara_translations (publication_version_id, segment_hash, engine_version, model, translation_text)
      VALUES (${changed.publicationVersionId}, ${'7'.repeat(64)}, 'v1', 'm', 'traducao da janela')`.execute(db);
    await sql`INSERT INTO collection_checkpoints (source_id, connector_key, state_version, generation, payload, payload_sha256, payload_bytes, produced_by_run_id)
      VALUES (${doeSp}, 'doe-sp', 1, 1, '{"coverageFrom":"2025-01-01","pendingRanges":[{"from":"2025-03-02","to":"2026-09-26"}],"days":{}}', ${'1'.repeat(64)}, 10, ${recaptureRunId})`.execute(db);
    await db.updateTable('collection_runs').set({ status: 'PARTIAL_SUCCESS', finished_at: new Date() }).where('id', '=', recaptureRunId).execute();
    const title = await db.selectFrom('publications').select(['title', 'primary_official_url']).where('id', '=', p1.publicationId).executeTakeFirstOrThrow();
    assert.equal(title.primary_official_url, 'https://doe.sp.gov.br/a1-new', 'recapture changed canonical fields');
    assert.notEqual(manifest(opsUrl), manifest0);

    // ---- rollback to the backup state
    psql(opsUrl, join(SQL, '25_pause_source.sql'));
    execFileSync('bash', [join(OPS, 'runner/rollback-stage.sh'), bakUrl, opsUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    const rollback = psql(opsUrl, join(SQL, '60_rollback_import.sql'));
    const result = JSON.parse(rollback.split('\n').find((line) => line.startsWith('DOE_SP_ROLLBACK_RESULT='))!.slice('DOE_SP_ROLLBACK_RESULT='.length));
    assert.equal(result.recaptureRunsRemoved, 1);
    assert.equal(result.windowPublicationsRemoved, 1);
    assert.equal(result.windowTranslationsRemoved, 1);
    assert.equal(result.publicationsRestored, 3);

    assert.equal(manifest(opsUrl), manifest0, 'DOE-SP state equals the backup manifest');
    assert.equal(others(opsUrl), others0, 'other sources and their translations untouched');
    const orphans = await sql<{ n: string }>`SELECT count(*) AS n FROM publications p WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)`.execute(db);
    assert.equal(Number(orphans.rows[0]!.n), 0, 'no orphan publications');
    psql(opsUrl, join(SQL, '50_resume_source.sql'));
    assert.equal(counts(opsUrl), counts0, 'every table count back to the backup');
  } finally {
    await db?.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${opsDb} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${bakDb} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    rmSync(tmp, { recursive: true, force: true });
  }
});

function psqlAsync(url: string, file: string, vars: Record<string, string>): Promise<string> {
  const args = [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
  args.push('-f', file);
  return new Promise((resolvePromise, reject) => {
    execFile('psql', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout);
    });
  });
}

test('DOE-SP-34: 30 sees writes committed while it waits for its table locks (foreign item aborts)', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for the DOE-SP ops rehearsal.');
  const suffix = randomBytes(4).toString('hex');
  const opsDb = 'doe_sp_ops_race_' + suffix;
  const opsUrl = withDatabase(adminUrl, opsDb);
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let pool: Pool | undefined;
  let db: Kysely<DB> | undefined;

  try {
    await admin.query(`CREATE DATABASE ${opsDb}`);
    const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    execFileSync('psql', [opsUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, stdio: ['pipe', 'ignore', 'pipe'] });
    pool = new Pool({ connectionString: opsUrl, max: 3 });
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

    const doeSp = randomUUID();
    const dou = randomUUID();
    await db.insertInto('sources').values([
      { id: doeSp, code: 'doe-sp', name: 'DOE SP', jurisdiction_level: 'STATE', uf: 'SP', base_url: 'https://doe.sp.gov.br', connector_key: 'doe-sp', schedule_cron: '0 7 * * *' },
      { id: dou, code: 'dou', name: 'DOU', jurisdiction_level: 'FEDERAL', base_url: 'https://in.gov.br', connector_key: 'dou', schedule_cron: '0 8 * * *' },
    ]).execute();
    const run = async (sourceId: string, at: string) => {
      const runId = (await db!.insertInto('collection_runs').values({ source_id: sourceId, scheduled_for: new Date(at), status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      const attemptId = (await db!.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      return { runId, attemptId };
    };
    const doeRun = await run(doeSp, '2026-09-01T10:00:00Z');
    const p1 = await db.transaction().execute((trx) => persistPublication(trx, {
      sourceId: doeSp, runId: doeRun.runId, attemptId: doeRun.attemptId,
      publication: normalizePublication({ sourceId: doeSp, publication: doeSpAct(1, 'PORTARIA SRE 1', 'https://doe.sp.gov.br/a1') }),
    }));
    const douRun = await run(dou, '2026-09-01T11:00:00Z');

    psql(opsUrl, join(SQL, '25_pause_source.sql'));
    const dry = rebuildArgs(opsUrl);
    assert.ok(Object.values(dry.blockers).every((value) => value === 0), JSON.stringify(dry.blockers));
    const manifest0 = manifest(opsUrl);

    // Another source's worker is writing an item that points at the scope and
    // commits only while 30 is already running and waiting for its locks.
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        "INSERT INTO collection_items (collection_run_id, source_item_key, status, publication_id) VALUES ($1, 'foreign-late', 'PROCESSED_EXISTING', $2)",
        [douRun.runId, p1.publicationId],
      );
      const rebuild = psqlAsync(opsUrl, join(SQL, '30_rebuild_destructive.sql'), { ...dry.vars, confirm: 'REBUILD_DOE_SP' });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const w = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
          [opsDb],
        );
        waiting = w.rows[0].n > 0;
      }
      assert.ok(waiting, '30 is waiting for the in-flight writer');
      await writer.query('COMMIT');
      await assert.rejects(rebuild, /collection_items of other sources/, '30 must see the item committed during its lock wait');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    await db.deleteFrom('collection_items').where('source_item_key', '=', 'foreign-late').execute();
    assert.equal(manifest(opsUrl), manifest0, 'aborted 30 changed nothing');
  } finally {
    await db?.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${opsDb} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
});

test('DOE-SP-35: 13 fingerprint is equal across collation and time zone (production en_US vs runner C.UTF-8 restore)', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for the DOE-SP ops rehearsal.');
  const suffix = randomBytes(4).toString('hex');
  const enDb = 'doe_sp_fp_en_' + suffix;
  const cDb = 'doe_sp_fp_c_' + suffix;
  const enUrl = withDatabase(adminUrl, enDb);
  const cUrl = withDatabase(adminUrl, cDb);
  const tmp = mkdtempSync(join(tmpdir(), 'doe-sp-fp-'));
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let db: Kysely<DB> | undefined;

  try {
    // Production runs the official image default (en_US.utf8); the runner's
    // temporary server is initdb --locale=C.UTF-8.
    await admin.query(`CREATE DATABASE ${enDb} TEMPLATE template0 LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'`);
    await admin.query(`CREATE DATABASE ${cDb} TEMPLATE template0 LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
    const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    execFileSync('psql', [enUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, stdio: ['pipe', 'ignore', 'pipe'] });
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: enUrl, max: 2 }) }) });

    // Other-source data with both 'run:' and 'run-link:' parts (their order
    // differs between en_US.utf8 and C) and timestamptz columns.
    const dou = randomUUID();
    await db.insertInto('sources').values({ id: dou, code: 'dou', name: 'DOU', jurisdiction_level: 'FEDERAL', base_url: 'https://in.gov.br', connector_key: 'dou', schedule_cron: '0 8 * * *' }).execute();
    for (let r = 0; r < 3; r += 1) {
      const runId = (await db.insertInto('collection_runs').values({ source_id: dou, scheduled_for: new Date(Date.UTC(2026, 8, 1 + r, 11)), status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      const attemptId = (await db.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
      for (let n = 0; n < 4; n += 1) {
        await db.transaction().execute((trx) => persistPublication(trx, {
          sourceId: dou, runId, attemptId,
          publication: normalizePublication({ sourceId: dou, publication: {
            title: `LEI ${r}-${n}`, agency: 'Congresso', sphere: 'FEDERAL', actType: 'LEI', actNumber: `${r}${n}`,
            publishedAt: new Date('2026-01-10T00:00:00Z'), content: `lei ${r}-${n}`, officialUrl: `https://in.gov.br/l${r}${n}`,
            externalId: `l${r}${n}`, metadata: { sourceRole: 'PRIMARY' },
          } }),
        }));
      }
    }

    const dump = join(tmp, 'fp.dump');
    execFileSync('pg_dump', [enUrl, '--format=custom', '--file=' + dump]);
    execFileSync('pg_restore', ['--exit-on-error', '--no-owner', '--dbname=' + cUrl, dump]);

    const fingerprint = (url: string, tz: string) => execFileSync('psql', [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', join(SQL, '13_other_sources_fingerprint_readonly.sql')], {
      encoding: 'utf8', env: { ...process.env, PGTZ: tz, PGOPTIONS: '-c default_transaction_read_only=on' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reference = fingerprint(enUrl, 'UTC');
    assert.match(reference, /^DOE_SP_OTHER_SOURCES_FINGERPRINT=[0-9a-f]{64}$/m);
    assert.equal(counts(cUrl), counts(enUrl), 'restore has the same table counts');
    assert.equal(fingerprint(cUrl, 'UTC'), reference, 'C.UTF-8 restore reproduces the en_US fingerprint');
    assert.equal(fingerprint(enUrl, 'America/Sao_Paulo'), reference, 'session time zone does not change the fingerprint');
    assert.equal(fingerprint(cUrl, 'America/Sao_Paulo'), reference);
  } finally {
    await db?.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${enDb} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${cDb} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    rmSync(tmp, { recursive: true, force: true });
  }
});
