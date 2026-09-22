import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { NfeEncatConnector } from '../src/modules/collection/nfe-encat.connector.js';
import { readNfeEncatSourceState } from '../src/modules/collection/nfe-encat-source-state.repository.js';

const notes = `<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p>
<p><a href="exibirArquivo.aspx?conteudo=NT2025002V150%3D"><span class="tituloConteudo">Nota Técnica 2025.002 v.1.50 - Publicada em 03/06/2026</span></a><br>Adequação RTC.</p>
<p><a href="exibirArquivo.aspx?conteudo=NT2025002V140%3D"><span class="tituloConteudo">Nota Técnica 2025.002 v.1.40 - Publicada em 20/05/2026</span></a><br>Adequação RTC.</p>
</body></html>`;
const empty = '<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p></body></html>';

function family(url: string): 'notes' | 'other' | undefined {
  if (url.includes('listaConteudo.aspx')) return url.includes('04BIflQt1aY=') ? 'notes' : 'other';
  return undefined;
}

function token(url: string): '140' | '150' | undefined {
  if (url.includes('NT2025002V140')) return '140';
  if (url.includes('NT2025002V150')) return '150';
  return undefined;
}

test('NF-e/ENCAT through collection engine keeps official versions separate and creates a new publication_version on changed bytes', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for NF-e/ENCAT integration tests.');
  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();
  let sequence = 0;
  let generation = 1;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const listing = family(url);
    if (listing) return new Response(listing === 'notes' ? notes : empty, { status: 200, headers: { 'content-type': 'text/html' } });
    const item = token(url);
    if (!item) return new Response('not found', { status: 404 });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const currentTag = item === '140' ? '"140-v1"' : generation === 1 ? '"150-v1"' : '"150-v2"';
    if (headers['if-none-match'] === currentTag) return new Response(null, { status: 304, headers: { etag: currentTag } });
    const bytes = new TextEncoder().encode(`%PDF-1.7\n${item}-${item === '150' ? generation : 1}`);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', etag: currentTag } });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(new NfeEncatConnector({
    fetch: fetchImpl,
    readState: source => readNfeEncatSourceState(db, source),
    now: () => new Date('2026-09-21T20:00:00Z'),
  }));

  async function run() {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, `nfe-encat-worker-${sourceId}`);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, registry, acquired, { timeoutMs: 5_000, heartbeatIntervalMs: 0 });
  }

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `nfe-encat-${sourceId}`,
      name: 'Portal Nacional NF-e/ENCAT integration',
      jurisdiction_level: 'FEDERAL',
      base_url: 'https://www.nfe.fazenda.gov.br/portal',
      connector_key: 'nfe-encat',
      max_attempts: 1,
    }).execute();

    const first = await run();
    assert.equal(first.status, 'SUCCESS');
    assert.equal(first.metrics.newPublications, 2);

    const checkpointBeforePartial = await readNfeEncatSourceState(db, sourceId);
    assert.equal(Object.keys(checkpointBeforePartial.items).length, 2);
    const partialRunId = randomUUID();
    await db.insertInto('collection_runs').values({
      id: partialRunId,
      source_id: sourceId,
      scheduled_for: new Date('2026-09-21T20:01:00Z'),
      trigger_type: 'MANUAL',
      status: 'PARTIAL_SUCCESS',
      finished_at: new Date('2026-09-21T20:01:01Z'),
    }).execute();
    await db.insertInto('collection_attempts').values({
      collection_run_id: partialRunId,
      attempt_no: 1,
      status: 'SUCCESS',
      finished_at: new Date('2026-09-21T20:01:01Z'),
      metadata: {
        nfeEncatState: {
          items: {
            'TECHNICAL_NOTES:POISON': {
              rawSha256: 'f'.repeat(64),
              sizeBytes: 1,
              mimeType: 'application/pdf',
              checkedAt: '2026-09-21T20:01:01.000Z',
            },
          },
        },
      },
    }).execute();
    assert.deepEqual(await readNfeEncatSourceState(db, sourceId), checkpointBeforePartial);
    await db.deleteFrom('collection_runs').where('id', '=', partialRunId).execute();

    const publications = await db.selectFrom('publications as p')
      .innerJoin('publication_origins as po', 'po.publication_id', 'p.id')
      .select(['p.id', 'p.act_number'])
      .where('po.source_id', '=', sourceId)
      .orderBy('p.act_number')
      .execute();
    assert.deepEqual(publications.map(row => row.act_number), ['2025.002 v1.40', '2025.002 v1.50']);
    assert.equal(new Set(publications.map(row => row.id)).size, 2);

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
    const versionCounts = new Map<string, number>();
    for (const row of versions) versionCounts.set(row.publication_id, (versionCounts.get(row.publication_id) ?? 0) + 1);
    assert.deepEqual([...versionCounts.values()].sort(), [1, 2]);
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
