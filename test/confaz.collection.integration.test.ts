import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { createCollectionRun, acquireNextCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { ConfazConnector } from '../src/modules/collection/confaz.connector.js';
import { readConfazSourceState } from '../src/modules/collection/confaz-source-state.repository.js';

const BASE = 'https://www.confaz.fazenda.gov.br';
const SOURCE_ID = randomUUID();

function protocolPage(extra = ''): string {
  return `<!doctype html><html><body>
  <h1>PROTOCOLO ICMS 88/26</h1>
  <div id="content-core">
    <p>Revoga o Protocolo ICMS nº 100, de 14 de dezembro de 2007.</p>
    <p>PROTOCOLO ICMS Nº 88, DE 27 DE JULHO DE 2026</p>
    <p>Publicado no DOU de 29.07.26, pelo Despacho 34/26.</p>
    <p>Cláusula primeira O Protocolo ICMS nº 100 fica revogado.</p>
    <p>Cláusula segunda Este protocolo entra em vigor na data da sua publicação no Diário Oficial da União, produzindo efeitos a partir de 1º de agosto de 2026.</p>
    ${extra}
  </div></body></html>`;
}

async function runOnce(
  db: Kysely<DB>,
  registry: ConnectorRegistry,
): Promise<Awaited<ReturnType<typeof processAcquiredCollectionRun>>> {
  const runId = await createCollectionRun(db, {
    sourceId: SOURCE_ID,
    scheduledFor: new Date(Date.now() - 1000),
    triggerType: 'MANUAL',
  });

  const acquired = await acquireNextCollectionRun(db, 'confaz-integration-worker');
  assert.ok(acquired);
  assert.equal(acquired.id, runId);

  return processAcquiredCollectionRun(db, registry, acquired, {
    timeoutMs: 5_000,
    heartbeatIntervalMs: 0,
    retryPolicy: { baseDelayMs: 0, maxBackoffMs: 0 },
  });
}

test('CONFAZ connector persists, deduplicates and versions through the real collection engine contract', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for CONFAZ integration tests.');

  const pool = new Pool({ connectionString: adminUrl, max: 2 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  let changed = false;

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();

    if (url.endsWith('/legislacao/protocolos/2026/2026')) {
      return new Response(
        '<a href="/legislacao/protocolos/2026/pt088_26">PROTOCOLO ICMS 88/26</a>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    if (/\/legislacao\/(convenios|ajustes|atos)\/2026\/2026$/.test(url)) {
      return new Response('<html><body><h1>2026</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.endsWith('/legislacao/protocolos/2026/pt088_26')) {
      return new Response(
        protocolPage(changed ? '<p>Alteração oficial posterior.</p>' : ''),
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    }

    return new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(new ConfazConnector({
    fetchImpl,
    readSourceState: (sourceId) => readConfazSourceState(db, sourceId),
    now: () => new Date('2026-09-19T17:00:00Z'),
    requestSpacingMs: 0,
  }));

  try {
    await db.insertInto('sources').values({
      id: SOURCE_ID,
      code: `confaz-integration-${SOURCE_ID}`,
      name: 'CONFAZ integration',
      jurisdiction_level: 'FEDERAL',
      agency: 'CONFAZ',
      base_url: BASE,
      connector_key: 'confaz',
      max_attempts: 2,
    }).execute();

    const first = await runOnce(db, registry);
    assert.equal(first.state, 'TERMINAL');
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.metrics.newPublications, 1);

    const second = await runOnce(db, registry);
    assert.equal(second.state, 'TERMINAL');
    assert.equal(second.status, 'SUCCESS');
    assert.equal(second.metrics.existingPublications, 1);

    changed = true;
    const third = await runOnce(db, registry);
    assert.equal(third.state, 'TERMINAL');
    assert.equal(third.status, 'SUCCESS');
    assert.equal(third.metrics.newVersions, 1);

    const origin = await db
      .selectFrom('publication_origins')
      .select(['publication_id', 'official_url'])
      .where('source_id', '=', SOURCE_ID)
      .executeTakeFirstOrThrow();

    assert.equal(
      origin.official_url,
      `${BASE}/legislacao/protocolos/2026/pt088_26`,
    );

    const publication = await db
      .selectFrom('publications')
      .select(['act_type', 'act_number', 'title', 'published_on'])
      .where('id', '=', origin.publication_id)
      .executeTakeFirstOrThrow();

    assert.equal(publication.act_type, 'PROTOCOLO ICMS');
    assert.equal(publication.act_number, '88/2026');
    assert.match(publication.title, /Revoga o Protocolo ICMS/);
    assert.equal(publication.published_on?.toISOString().slice(0, 10), '2026-07-29');

    const versions = await db
      .selectFrom('publication_versions')
      .select(['version_no', 'is_current'])
      .where('publication_id', '=', origin.publication_id)
      .orderBy('version_no')
      .execute();

    assert.deepEqual(versions, [
      { version_no: 1, is_current: false },
      { version_no: 2, is_current: true },
    ]);
  } finally {
    const publicationIds = await db
      .selectFrom('publication_origins')
      .select('publication_id')
      .where('source_id', '=', SOURCE_ID)
      .execute()
      .then((rows) => rows.map((row) => row.publication_id));

    await db.deleteFrom('collection_runs').where('source_id', '=', SOURCE_ID).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', SOURCE_ID).execute();

    if (publicationIds.length > 0) {
      await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    }

    await db.deleteFrom('sources').where('id', '=', SOURCE_ID).execute();
    await db.destroy();
  }
});
