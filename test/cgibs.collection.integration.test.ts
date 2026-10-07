import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { CgibsConnector } from '../src/modules/collection/cgibs.connector.js';
import { readCgibsPersistedOrigins, readCgibsSourceState } from '../src/modules/collection/cgibs-source-state.repository.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { CGIBS, dereHtml, emptyContainer, pdf, resolutionsHtml, zip } from './cgibs.fixtures.js';

test('CGIBS through collection engine is idempotent and versions only real changed content', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for CGIBS integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  let sequence = 0;
  let changedResolution = false;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString(), CGIBS);
    if (url.pathname === '/resolucoes') {
      return new Response(resolutionsHtml.replace(
        /<h2>Resolução CGIBS nº 18[\s\S]*?<\/p>/,
        '',
      ), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/declaracao-de-regimes-especificos-dere') {
      return new Response(dereHtml.replace(
        /<h2>Notas Orientativas<\/h2>[\s\S]*?<h2>Versões Anteriores<\/h2>/,
        '<h2>Versões Anteriores</h2>',
      ), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (!/\/upload\/arquivos\//.test(url.pathname)) {
      return new Response(emptyContainer, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    const isResolution6 = url.pathname.includes('res-cgibs-n-6');
    const versionTag = isResolution6 && changedResolution ? 'v2' : 'v1';
    const etag = `"${url.pathname}-${versionTag}"`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });

    const bytes = url.pathname.endsWith('.zip')
      ? zip(url.pathname + '-' + versionTag)
      : pdf(url.pathname + '-' + versionTag);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': url.pathname.endsWith('.zip') ? 'application/zip' : 'application/pdf',
        etag,
      },
    });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(new CgibsConnector({
    fetch: fetchImpl,
    readState: source => readCgibsSourceState(db, source),
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
    now: () => new Date('2026-09-23T16:00:00Z'),
  }));

  // Production wiring: the connector also reads what the database already
  // holds, which is what lets an unchanged file be left alone.
  const wiredRegistry = new ConnectorRegistry();
  wiredRegistry.register(new CgibsConnector({
    fetch: fetchImpl,
    readState: source => readCgibsSourceState(db, source),
    readPersistedOrigins: source => readCgibsPersistedOrigins(db, source),
    // Production window: a file checked minutes ago is not due again, which
    // is the state in which the text is not in hand.
    maxRechecksPerRun: 100,
    now: () => new Date('2026-09-23T16:00:00Z'),
  }));

  async function run(using: ConnectorRegistry = registry) {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, `cgibs-worker-${sourceId}`);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, using, acquired, {
      timeoutMs: 10_000,
      heartbeatIntervalMs: 0,
    });
  }

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `cgibs-${sourceId}`,
      name: 'CGIBS integration fixture',
      jurisdiction_level: 'FEDERAL',
      agency: 'CGIBS',
      base_url: 'https://www.cgibs.gov.br/',
      connector_key: 'cgibs',
      max_attempts: 1,
    }).execute();

    const first = await run();
    assert.equal(first.status, 'SUCCESS');
    assert.ok(first.metrics.newPublications >= 3);
    assert.equal(first.metrics.newVersions, 0);

    const origins = await db.selectFrom('publication_origins')
      .select(['publication_id', 'external_id', 'official_url', 'metadata'])
      .where('source_id', '=', sourceId)
      .execute();
    assert.equal(origins.length, first.metrics.newPublications);
    assert.ok(origins.every((origin) => origin.official_url.startsWith('https://www.cgibs.gov.br/')));

    const dereVersions = await db.selectFrom('publication_origins as po')
      .innerJoin('publications as p', 'p.id', 'po.publication_id')
      .select(['p.id', 'p.title', 'po.metadata'])
      .where('po.source_id', '=', sourceId)
      .execute();
    const layouts = dereVersions.filter((row) => /Leiautes da DeRE/.test(row.title));
    assert.equal(layouts.length, 2);
    assert.notEqual(layouts[0]!.id, layouts[1]!.id);

    const firstCheckpoint = await readCgibsSourceState(db, sourceId);
    assert.ok(Object.keys(firstCheckpoint.items).length >= 3);

    const replay = await run();
    assert.equal(replay.status, 'SUCCESS');
    assert.equal(replay.metrics.newPublications, 0);
    assert.equal(replay.metrics.newVersions, 0);
    assert.equal(replay.metrics.existingPublications, first.metrics.newPublications);

    changedResolution = true;
    const changed = await run();
    assert.equal(changed.status, 'SUCCESS');
    assert.equal(changed.metrics.newPublications, 0);
    assert.equal(changed.metrics.newVersions, 1);
    assert.equal(changed.metrics.existingPublications, first.metrics.newPublications - 1);

    const resolution = await db.selectFrom('publications as p')
      .innerJoin('publication_origins as po', 'po.publication_id', 'p.id')
      .select(['p.id'])
      .where('po.source_id', '=', sourceId)
      .where('p.title', 'like', '%Resolução CGIBS nº 6%')
      .executeTakeFirstOrThrow();

    const resolutionVersions = await db.selectFrom('publication_versions')
      .select(['version_no', 'is_current', 'content_hash'])
      .where('publication_id', '=', resolution.id)
      .orderBy('version_no')
      .execute();
    assert.equal(resolutionVersions.length, 2);
    assert.equal(resolutionVersions.filter((row) => row.is_current).length, 1);
    assert.equal(new Set(resolutionVersions.map((row) => row.content_hash)).size, 2);

    // With the production wiring an unchanged catalog is left alone: the run
    // still consults the source (so the health watchdog does not call it
    // stale) but writes nothing, and above all adds no version. Re-emitting
    // without the text, which only the downloaded bytes carry, is what would
    // have written an empty version every other run.
    const versionsBefore = await db.selectFrom('publication_versions as pv')
      .innerJoin('publication_origins as po', 'po.publication_id', 'pv.publication_id')
      .select(({ fn }) => [fn.countAll<string>().as('total')])
      .where('po.source_id', '=', sourceId)
      .executeTakeFirstOrThrow();

    const persistedOrigins = await readCgibsPersistedOrigins(db, sourceId);
    assert.equal(persistedOrigins.linked.size, origins.length, 'every persisted origin is reported back');
    const checkpointNow = await readCgibsSourceState(db, sourceId);
    const unread = Object.entries(checkpointNow.items)
      .filter(([, item]) => item.contentExtraction === undefined)
      .map(([key]) => key);
    assert.deepEqual(unread, [], 'every checkpointed file records how its text was read');
    for (const key of Object.keys(checkpointNow.items)) {
      assert.ok(persistedOrigins.linked.has(key), `checkpoint key ${key} must match a persisted origin`);
    }

    const settledRun = await run(wiredRegistry);
    assert.equal(settledRun.metrics.newPublications, 0);
    assert.equal(settledRun.metrics.newVersions, 0);
    assert.equal(settledRun.metrics.itemErrors, 0);
    // Documents whose body comes from an HTML page carry their text on every
    // run, so they are still emitted; only the file-anchored ones are skipped.
    assert.ok(
      settledRun.metrics.existingPublications < first.metrics.newPublications,
      `file-anchored documents must be skipped (saw ${settledRun.metrics.existingPublications} of ${first.metrics.newPublications})`,
    );

    const versionsAfter = await db.selectFrom('publication_versions as pv')
      .innerJoin('publication_origins as po', 'po.publication_id', 'pv.publication_id')
      .select(({ fn }) => [fn.countAll<string>().as('total')])
      .where('po.source_id', '=', sourceId)
      .executeTakeFirstOrThrow();
    assert.equal(versionsAfter.total, versionsBefore.total, 'a quiet run must not add a version');

    const originsAfter = await db.selectFrom('publication_origins')
      .select(({ fn }) => [fn.countAll<string>().as('total')])
      .where('source_id', '=', sourceId)
      .executeTakeFirstOrThrow();
    assert.equal(originsAfter.total, String(origins.length), 'nothing is dropped by being skipped');
  } finally {
    const publicationIds = [...new Set(
      (await db.selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute())
        .map((row) => row.publication_id),
    )];

    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (publicationIds.length) await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
