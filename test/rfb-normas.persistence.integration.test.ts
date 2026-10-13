import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import { RfbNormasConnector } from '../src/modules/collection/rfb-normas.connector.js';
import {
  RETIFICATION_API_ORIGINAL,
  RETIFICATION_DUPLICATE_API_ORIGINAL,
  SC_API_ORIGINAL,
  pdfBytes,
} from './rfb-normas.fixtures.js';

test('RFB persists attachment SHA and excludes repeated retification reference without artificial version', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for RFB persistence integration test.');

  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const sourceId = randomUUID();

  const search = `<!doctype html><html><body>
  <div>Total de atos localizados: 3</div><div>Página 1 de 1</div>
  <table><tbody>
  <tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/148881">Portaria</a></td><td>619</td><td>RFB</td><td>16/01/2026</td><td>Retificação tributária da Portaria RFB nº 619/2025.</td></tr>
  <tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/148882">Portaria</a></td><td>619</td><td>RFB</td><td>16/01/2026</td><td>Retificação tributária da Portaria RFB nº 619/2025.</td></tr>
  <tr><td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150002">Solução de Consulta</a></td><td>180</td><td>Cosit</td><td>23/09/2026</td><td>Assunto: Cofins. Crédito presumido de ICMS. Não incidência.</td></tr>
  </tbody></table></body></html>`;

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith('/consulta.action')) {
      return new Response(search, { status: 200, headers: { 'content-type': 'text/html' } });
    }

    const match = /\/api\/consulta-externa\/ato\/(148881|148882|150002)\/visao\/(original|vigente|multivigente|relacional)$/.exec(url.pathname);
    if (match?.[1] && match[2]) {
      if (match[2] === 'relacional') return new Response(null, { status: 403 });
      const base =
        match[1] === '148881' ? RETIFICATION_API_ORIGINAL :
        match[1] === '148882' ? RETIFICATION_DUPLICATE_API_ORIGINAL :
        SC_API_ORIGINAL;
      const payload = structuredClone(base);
      payload.visao = match[2];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname.endsWith('/anexoOutros.action')) {
      return new Response(pdfBytes('SC Cosit 180 official PDF'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(new RfbNormasConnector({
    fetch: fetchImpl,
    readState: async () => ({
      bootstrap: { complete: true, month: '2026-09', page: 1 },
      files: {},
    }),
    now: () => new Date('2026-09-23T16:00:00Z'),
    lookbackDays: 7,
  }));

  try {
    await db.insertInto('sources').values({
      id: sourceId,
      code: `rfb-persistence-${sourceId}`,
      name: 'RFB persistence integration fixture',
      jurisdiction_level: 'FEDERAL',
      agency: 'RFB',
      base_url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action',
      connector_key: 'rfb-normas',
      max_attempts: 1,
    }).execute();

    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 60_000),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, `rfb-persistence-${sourceId}`);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);

    const result = await processAcquiredCollectionRun(db, registry, acquired, {
      timeoutMs: 20_000,
      heartbeatIntervalMs: 0,
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.metrics.newPublications, 2);
    assert.equal(result.metrics.newVersions, 0);

    const retification = await db.selectFrom('publication_origins as po')
      .innerJoin('publications as p', 'p.id', 'po.publication_id')
      .select(['p.id', 'p.act_type', 'po.external_id'])
      .where('po.source_id', '=', sourceId)
      .where('po.external_id', '=', '148881')
      .executeTakeFirstOrThrow();
    assert.equal(retification.act_type, 'RETIFICAÇÃO');

    const duplicateOrigin = await db.selectFrom('publication_origins')
      .select('id')
      .where('source_id', '=', sourceId)
      .where('external_id', '=', '148882')
      .executeTakeFirst();
    assert.equal(duplicateOrigin, undefined);

    const versions = await db.selectFrom('publication_versions')
      .select(['id'])
      .where('publication_id', '=', retification.id)
      .execute();
    assert.equal(versions.length, 1);

    const sc = await db.selectFrom('publications')
      .select(['id'])
      .where('agency', '=', 'COSIT')
      .where('act_type', '=', 'SOLUÇÃO DE CONSULTA')
      .where('act_number', '=', '180/2026')
      .executeTakeFirstOrThrow();

    const scVersion = await db.selectFrom('publication_versions')
      .select(['source_metadata'])
      .where('publication_id', '=', sc.id)
      .where('is_current', '=', true)
      .executeTakeFirstOrThrow();

    const metadata = scVersion.source_metadata as Record<string, unknown>;
    const files = metadata.files as Array<Record<string, unknown>>;
    assert.equal(files.length, 1);
    assert.match(String(files[0]!.rawSha256 ?? ''), /^[a-f0-9]{64}$/);
    assert.ok(Number(files[0]!.sizeBytes) > 0);
  } finally {
    const publicationIds = [...new Set(
      (await db.selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', '=', sourceId)
        .execute())
        .map(row => row.publication_id),
    )];

    await db.deleteFrom('collection_runs').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('publication_origins').where('source_id', '=', sourceId).execute();
    if (publicationIds.length) {
      await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    }
    await db.deleteFrom('sources').where('id', '=', sourceId).execute();
    await db.destroy();
  }
});
