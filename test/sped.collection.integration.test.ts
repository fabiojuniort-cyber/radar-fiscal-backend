import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { SpedConnector } from '../src/modules/collection/sped.connector.js';
import { readSpedSourceState } from '../src/modules/collection/sped-source-state.repository.js';

function html(body: string) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function root(links: Array<[string, string]>) {
  return '<html><body>' + links.map(([href, text]) => '<a href="' + href + '">' + text + '</a>').join('') + '</body></html>';
}

function detail(title: string, date: string, fileId: string) {
  return '<html><body><h1>EFD-Reinf</h1><h2>' + title + '</h2><p>Publicado em ' + date + '</p><a href="/arquivo/download/' + fileId + '">nota.pdf</a></body></html>';
}

test('SPED through collection engine keeps explicit republication separate and creates publication_version on silent byte change', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for SPED integration tests.');
  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  let sequence = 0;
  let generation = 1;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const p = url.pathname;
    if (p === '/item/show/1196' || p === '/destaques/show/1199') {
      return html(root([
        ['/item/show/8116', 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2'],
        ['/item/show/8129', 'Nota Técnica 01/2026 republicada – Ajustes nos leiautes da versão 2.1.2'],
      ]));
    }
    if (p === '/item/show/2270') return html('<html><body><h1>Esquemas XSD</h1></body></html>');
    if (p === '/item/show/8116') return html(detail('Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2', '25/03/2026', '8117'));
    if (p === '/item/show/8129') return html(detail('Nota Técnica 01/2026 republicada – Ajustes nos leiautes da versão 2.1.2', '31/03/2026', '8130'));
    if (p === '/item/show/274' || p === '/item/show/1573' || p === '/item/show/268' || p === '/item/show/1545' || p === '/item/show/7950' || p === '/destaques/show/7' || p === '/destaques/show/285') {
      return html('<html><body><h1>Portal SPED</h1></body></html>');
    }
    if (p.startsWith('/arquivo/download/')) {
      const id = p.split('/').at(-1)!;
      const etag = id === '8130' && generation > 1 ? '"repub-v2"' : '"v1"';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      const bytes = new TextEncoder().encode('%PDF-1.7\n' + id + '-' + (id === '8130' ? generation : 1));
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', etag } });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(new SpedConnector({
    fetch: fetchImpl,
    readState: source => readSpedSourceState(db, source),
    now: () => new Date('2026-09-22T00:00:00Z'),
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
    maxCrawlDepth: 2,
  }));

  async function run() {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, 'sped-worker-' + sourceId);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 10_000, heartbeatIntervalMs: 0 });
  }

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: 'sped-' + sourceId,
      name: 'Portal SPED integration',
      jurisdiction_level: 'FEDERAL',
      base_url: 'https://sped.rfb.gov.br',
      connector_key: 'sped',
      max_attempts: 1,
    }).execute();

    const first = await run();
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.metrics.newPublications, 2);

    const publications = await db.selectFrom('publications as p')
      .innerJoin('publication_origins as po', 'po.publication_id', 'p.id')
      .select(['p.id', 'p.act_number', 'po.external_id'])
      .where('po.source_id', '=', sourceId)
      .orderBy('p.act_number')
      .execute();
    assert.equal(publications.length, 2);
    assert.deepEqual(publications.map(row => row.act_number), ['01/2026', '01/2026 - REPUBLICAÇÃO']);
    assert.equal(new Set(publications.map(row => row.id)).size, 2);

    const state = await readSpedSourceState(db, sourceId);
    assert.equal(Object.keys(state.items).length, 2);

    const replay = await run();
    assert.equal(replay.status, 'SUCCESS');
    assert.equal(replay.metrics.existingPublications, 2);
    assert.equal(replay.metrics.newVersions, 0);

    generation = 2;
    const changed = await run();
    assert.equal(changed.status, 'SUCCESS');
    assert.equal(changed.metrics.existingPublications, 1);
    assert.equal(changed.metrics.newVersions, 1);

    const versions = await db.selectFrom('publication_versions as pv')
      .innerJoin('publication_origins as po', 'po.publication_id', 'pv.publication_id')
      .select(['pv.publication_id', 'pv.version_no', 'pv.is_current'])
      .where('po.source_id', '=', sourceId)
      .execute();
    assert.equal(versions.length, 3);
    assert.equal(versions.filter(row => row.is_current).length, 2);
  } finally {
    const publicationIds = [...new Set((await db.selectFrom('publication_origins').select('publication_id').where('source_id', '=', sourceId).execute()).map(row => row.publication_id))];
    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (publicationIds.length) await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
