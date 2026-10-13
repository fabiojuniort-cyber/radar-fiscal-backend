import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import type { ConnectorPublication } from '../src/modules/collection/connector.contract.js';
import { publicationPageUrl } from '../src/modules/collection/doe-sp.client.js';
import { DoeSpIdentityRepairError, repairDoeSpIdentityCollision, type DoeSpOfficialAct } from '../src/modules/collection/doe-sp-identity-repair.js';
import { doeSpNormativeIdentity } from '../src/modules/collection/doe-sp.rules.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { persistPublication } from '../src/modules/collection/publication.persistence.js';
import { dropScratchDatabase, ignoreIdleClientErrors } from './scratch-database.js';

/*
 * DOE-SP-40 repairs (tribusca-control Issue #1) against a disposable database:
 * A) ops/doe-sp/sql/70_delete_orphan_publications.sql;
 * B) repairDoeSpIdentityCollision, on a collision produced by the real
 *    normalizer/persistence with the pre-fix act number ("17/2023").
 */

const SQL = resolve('ops/doe-sp/sql');

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/' + database;
  return parsed.toString();
}

function psql(url: string, file: string, vars: Record<string, string> = {}): string {
  const args = [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
  args.push('-f', file);
  return execFileSync('psql', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function scratch(prefix: string): Promise<{ url: string; admin: Pool; name: string }> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for the DOE-SP-40 repair tests.');
  const name = prefix + randomBytes(4).toString('hex');
  const admin = ignoreIdleClientErrors(new Pool({ connectionString: adminUrl, max: 1 }));
  await admin.query(`CREATE DATABASE ${name}`);
  const schema = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', adminUrl], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const url = withDatabase(adminUrl, name);
  execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: schema, stdio: ['pipe', 'ignore', 'pipe'] });
  return { url, admin, name };
}

const ORPHANS = [
  'edb93609-1b91-48a5-8b97-73acf2338b0d', 'fa400479-0ee3-4190-9602-042921cd610a',
  'c7b1dd94-dad1-4680-ace5-4c5bb83084a2', '1e080fc5-fc71-4b81-ad0f-7077ff82abca',
  'bad1986a-99b5-4258-9e01-4c5b7909d6b6', '9cb11b7b-a9cd-48dc-8de4-c5fe33c6c883',
];

async function sources(db: Kysely<DB>): Promise<{ doeSp: string; dou: string }> {
  const doeSp = randomUUID();
  const dou = randomUUID();
  await db.insertInto('sources').values([
    { id: doeSp, code: 'doe-sp', name: 'DOE SP', jurisdiction_level: 'STATE', uf: 'SP', base_url: 'https://doe.sp.gov.br', connector_key: 'doe-sp', schedule_cron: '0 7 * * *' },
    { id: dou, code: 'dou', name: 'DOU', jurisdiction_level: 'FEDERAL', base_url: 'https://in.gov.br', connector_key: 'dou', schedule_cron: '0 8 * * *' },
  ]).execute();
  return { doeSp, dou };
}

async function newRun(db: Kysely<DB>, sourceId: string): Promise<{ runId: string; attemptId: string }> {
  const runId = (await db.insertInto('collection_runs').values({ source_id: sourceId, scheduled_for: new Date(), status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
  const attemptId = (await db.insertInto('collection_attempts').values({ collection_run_id: runId, attempt_no: 1, status: 'SUCCESS' }).returning('id').executeTakeFirstOrThrow()).id;
  return { runId, attemptId };
}

test('DOE-SP-40 A: 70 deletes only the 6 orphans, keeps run history, dry execution rolls back, guards abort', async () => {
  const { url, admin, name } = await scratch('doe_sp_r40a_');
  const pool = ignoreIdleClientErrors(new Pool({ connectionString: url, max: 2 }));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  try {
    const { doeSp } = await sources(db);
    const run = await newRun(db, doeSp);
    for (const [index, id] of ORPHANS.entries()) {
      await db.insertInto('publications').values({
        id, identity_hash: 'h' + index, identity_strength: 'SOURCE_SCOPED', identity_basis: '{}',
        jurisdiction_level: 'STATE', uf: 'SP', title: 'orphan ' + index,
      }).execute();
      await db.insertInto('collection_items').values({
        collection_run_id: run.runId, first_attempt_id: run.attemptId, source_item_key: 'k' + index,
        external_id: randomUUID(), status: 'PROCESSED_NEW', publication_id: id,
      }).execute();
    }
    await db.insertInto('collection_run_publications').values({ collection_run_id: run.runId, publication_id: ORPHANS[0]!, disposition: 'NEW_PUBLICATION' }).execute();
    // A real DOE-SP publication that must stay.
    const kept = await db.transaction().execute((trx) => persistPublication(trx, {
      sourceId: doeSp, runId: run.runId, attemptId: run.attemptId,
      publication: normalizePublication({ sourceId: doeSp, publication: {
        title: 'PORTARIA SRE 1', agency: 'SEFAZ-SP/SRE', sphere: 'STATE', stateCode: 'SP', actType: 'PORTARIA', actNumber: '1/2026',
        publishedAt: new Date('2026-09-01T00:00:00Z'), content: 'texto', officialUrl: 'https://doe.sp.gov.br/p1', externalId: randomUUID(),
      } }),
    }));

    const count = async () => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM publications`.execute(db)).rows[0]!.n);
    assert.equal(await count(), 7);

    const dry = psql(url, join(SQL, '70_delete_orphan_publications.sql'));
    const result = JSON.parse(dry.split('\n').find((line) => line.startsWith('DOE_SP_ORPHANS_RESULT='))!.slice('DOE_SP_ORPHANS_RESULT='.length));
    assert.deepEqual(result, { mode: 'DRY', publicationsDeleted: 6, collectionItemsUnlinked: 6, runLinksDeleted: 1, postConditions: 'PASS' });
    assert.match(dry, /DOE_SP_ORPHANS_ROLLED_BACK/);
    assert.equal(await count(), 7);

    // Commit requires the counts of the dry execution.
    assert.throws(() => psql(url, join(SQL, '70_delete_orphan_publications.sql'), { confirm: 'DELETE_DOE_SP_ORPHANS' }));
    assert.throws(() => psql(url, join(SQL, '70_delete_orphan_publications.sql'), { confirm: 'DELETE_DOE_SP_ORPHANS', expected_items: '5', expected_run_links: '1' }));
    assert.equal(await count(), 7);

    // A shell that gained a version is no orphan: abort, nothing deleted.
    const version = await db.insertInto('publication_versions').values({
      publication_id: ORPHANS[2]!, version_no: 1, content_hash: 'x', is_current: true,
    }).returning('id').executeTakeFirstOrThrow();
    assert.throws(() => psql(url, join(SQL, '70_delete_orphan_publications.sql')), /versions exist/);
    await db.deleteFrom('publication_versions').where('id', '=', version.id).execute();

    const committed = psql(url, join(SQL, '70_delete_orphan_publications.sql'), { confirm: 'DELETE_DOE_SP_ORPHANS', expected_items: '6', expected_run_links: '1' });
    assert.match(committed, /DOE_SP_ORPHANS_COMMITTED/);
    assert.equal(await count(), 1);
    assert.ok(await db.selectFrom('publications').select('id').where('id', '=', kept.publicationId).executeTakeFirst());
    const items = await db.selectFrom('collection_items').select(['publication_id']).where('collection_run_id', '=', run.runId).execute();
    assert.equal(items.length, 7);
    assert.equal(items.filter((item) => item.publication_id === null).length, 6);
    assert.equal(Number((await sql<{ n: string }>`SELECT count(*) AS n FROM collection_run_publications`.execute(db)).rows[0]!.n), 1);
  } finally {
    await db.destroy();
    await dropScratchDatabase(admin, name);
    await admin.end();
  }
});

const LAW_A = { id: '4135051d-80c1-410d-a127-4bb80330a516', title: 'LEI Nº 17.834, DE 1º DE NOVEMBRO DE 2023', slug: 'executivo/leis/lei-n-17-834-de-1-de-novembro-de-2023-8344217', text: 'Institui o Endereçamento Rural Digital.' };
const LAW_B = { id: '7b252fbe-ab50-4e8a-8a48-937cdfa0109f', title: 'LEI Nº 17. 839, DE 1º DE NOVEMBRO DE 2023', slug: 'executivo/leis/lei-n-17-839-de-1-de-novembro-de-2023-8344222', text: 'Declara de utilidade pública o Instituto Boas Novas.' };

/** DOE-SP law as the connector builds it; `actNumber` forced to reproduce the pre-fix collision. */
function law(act: typeof LAW_A, actNumber?: string): ConnectorPublication {
  const identity = doeSpNormativeIdentity({ title: act.title, category: 'LEGISLATION' })!;
  return {
    title: act.title, agency: identity.agency, sphere: 'STATE', stateCode: 'SP', actType: identity.actType,
    actNumber: actNumber ?? identity.actNumber, publishedAt: new Date('2023-11-06T00:00:00Z'), content: act.text,
    officialUrl: publicationPageUrl(act.slug), externalId: act.id, contentHashPolicy: 'HTML_PRIMARY_MATERIAL_FILES',
    metadata: { sourceRole: 'PRIMARY', doeDate: '2023-11-06', slug: act.slug, captureCategory: 'LEGISLATION' },
    originMetadata: { authenticatedPdf: 'NOT_REQUESTED_REDUNDANT', contentRepresentation: 'OFFICIAL_HTML' },
  };
}

test('DOE-SP-40 B: a collision of two laws is split with the official titles; dry run changes nothing; a later capture finds each law', async () => {
  const { url, admin, name } = await scratch('doe_sp_r40b_');
  const pool = ignoreIdleClientErrors(new Pool({ connectionString: url, max: 2 }));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  try {
    const { doeSp } = await sources(db);
    const run = await newRun(db, doeSp);
    const persist = (ids: { runId: string; attemptId: string }, publication: ConnectorPublication) =>
      db.transaction().execute((trx) => persistPublication(trx, { sourceId: doeSp, ...ids, publication: normalizePublication({ sourceId: doeSp, publication }) }));

    // Pre-fix capture: both laws read as "17/2023" -> one publication, B becomes version 2 of A.
    const a = await persist(run, law(LAW_A, '17/2023'));
    const b = await persist(run, law(LAW_B, '17/2023'));
    assert.equal(a.disposition, 'NEW_PUBLICATION');
    assert.equal(b.disposition, 'NEW_VERSION');
    assert.equal(b.publicationId, a.publicationId);
    const collided = a.publicationId;

    const official = new Map<string, DoeSpOfficialAct>([
      [LAW_A.id, { title: LAW_A.title, slug: LAW_A.slug, publicationType: 'Lei' }],
      [LAW_B.id, { title: LAW_B.title, slug: LAW_B.slug, publicationType: 'Lei' }],
    ]);
    const fetchAct = async (id: string) => official.get(id)!;
    const snapshot = async () => ({
      publications: await db.selectFrom('publications').selectAll().orderBy('id').execute(),
      versions: await db.selectFrom('publication_versions').select(['id', 'publication_id', 'version_no', 'is_current']).orderBy('id').execute(),
      origins: await db.selectFrom('publication_origins').select(['id', 'publication_id']).orderBy('id').execute(),
      items: await db.selectFrom('collection_items').select(['id', 'publication_id', 'status']).orderBy('id').execute(),
      links: await db.selectFrom('collection_run_publications').selectAll().orderBy('publication_id').execute(),
    });

    const before = await snapshot();
    const dry = await repairDoeSpIdentityCollision(db, { publicationId: collided, fetchAct, confirm: false });
    assert.equal(dry.mode, 'DRY');
    assert.deepEqual(await snapshot(), before);

    // A title that does not belong to the origin aborts.
    await assert.rejects(() => repairDoeSpIdentityCollision(db, {
      publicationId: collided, confirm: true, fetchAct: async (id) => ({ ...official.get(id)!, slug: 'outra' }),
    }), (error: unknown) => error instanceof DoeSpIdentityRepairError && error.code === 'SLUG_MISMATCH');
    assert.deepEqual(await snapshot(), before);

    const report = await repairDoeSpIdentityCollision(db, { publicationId: collided, fetchAct, confirm: true });
    assert.equal(report.mode, 'COMMITTED');
    assert.equal(report.kept.actNumber, '17834/2023');
    assert.equal(report.created.length, 1);
    assert.equal(report.created[0]!.actNumber, '17839/2023');
    const created = report.created[0]!.publicationId;

    const pubA = await db.selectFrom('publications').selectAll().where('id', '=', collided).executeTakeFirstOrThrow();
    const pubB = await db.selectFrom('publications').selectAll().where('id', '=', created).executeTakeFirstOrThrow();
    assert.equal(pubA.title, LAW_A.title);
    assert.equal(pubA.act_number, '17834/2023');
    assert.equal(pubB.title, LAW_B.title);
    assert.equal(pubB.act_number, '17839/2023');
    assert.equal(pubA.identity_hash, normalizePublication({ sourceId: doeSp, publication: law(LAW_A) }).identityHash);
    assert.equal(pubB.identity_hash, normalizePublication({ sourceId: doeSp, publication: law(LAW_B) }).identityHash);

    const versions = await db.selectFrom('publication_versions').select(['publication_id', 'version_no', 'is_current', 'content_text']).orderBy('publication_id').execute();
    assert.deepEqual(versions.find((v) => v.publication_id === collided), { publication_id: collided, version_no: 1, is_current: true, content_text: LAW_A.text });
    assert.deepEqual(versions.find((v) => v.publication_id === created), { publication_id: created, version_no: 1, is_current: true, content_text: LAW_B.text });
    const origins = await db.selectFrom('publication_origins').select(['publication_id', 'external_id']).execute();
    assert.deepEqual(new Map(origins.map((o) => [o.external_id, o.publication_id])), new Map([[LAW_A.id, collided], [LAW_B.id, created]]));
    const items = await db.selectFrom('collection_items').select(['external_id', 'publication_id', 'status']).execute();
    assert.deepEqual(items.find((i) => i.external_id === LAW_B.id), { external_id: LAW_B.id, publication_id: created, status: 'PROCESSED_NEW' });
    assert.deepEqual(items.find((i) => i.external_id === LAW_A.id), { external_id: LAW_A.id, publication_id: collided, status: 'PROCESSED_NEW' });
    const links = await db.selectFrom('collection_run_publications').select(['publication_id', 'disposition']).execute();
    assert.deepEqual(new Map(links.map((l) => [l.publication_id, l.disposition])), new Map([[collided, 'NEW_PUBLICATION'], [created, 'NEW_PUBLICATION']]));

    // A later capture with the fixed rules lands on each law, without origin conflicts.
    const later = await newRun(db, doeSp);
    assert.deepEqual(await persist(later, law(LAW_A)).then((r) => [r.publicationId, r.disposition]), [collided, 'EXISTING_PUBLICATION']);
    assert.deepEqual(await persist(later, law(LAW_B)).then((r) => [r.publicationId, r.disposition]), [created, 'EXISTING_PUBLICATION']);

    // Nothing left to split.
    await assert.rejects(() => repairDoeSpIdentityCollision(db, { publicationId: collided, fetchAct, confirm: true }),
      (error: unknown) => error instanceof DoeSpIdentityRepairError && error.code === 'NO_COLLISION');
  } finally {
    await db.destroy();
    await dropScratchDatabase(admin, name);
    await admin.end();
  }
});
