import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { DB } from '../src/infrastructure/database/database.types.js';
import { acquireNextCollectionRun, createCollectionRun } from '../src/modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../src/modules/collection/collection.engine.js';
import { ConnectorRegistry } from '../src/modules/collection/connector.registry.js';
import type { CollectionConnector } from '../src/modules/collection/connector.contract.js';
import { classifyDouAct } from '../src/modules/collection/dou.parser.js';
import { RfbNormasConnector } from '../src/modules/collection/rfb-normas.connector.js';
import { IN_API_ORIGINAL, representationPayload } from './rfb-normas.fixtures.js';

test('DOU + Sistema Normas converge to one publication with two official origins', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for RFB cross-source integration test.');

  const pool = new Pool({ connectionString: adminUrl, max: 3 });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  const douSourceId = randomUUID();
  const rfbSourceId = randomUUID();
  const douKey = `dou-rfb-gate-${randomUUID()}`;

  const title = 'INSTRUÇÃO NORMATIVA RFB Nº 2.344, DE 22 DE SETEMBRO DE 2026';
  const content = [
    'Dispõe sobre regras de tributação federal e obrigações acessórias.',
    'Art. 1º Esta Instrução Normativa disciplina o procedimento.',
    'Art. 2º Esta Instrução Normativa entra em vigor na data de sua publicação.',
  ].join(' ');
  const structural = classifyDouAct(
    title,
    'Ministério da Fazenda/Secretaria Especial da Receita Federal do Brasil',
    'Instrução Normativa',
  );
  assert.equal(structural.agency, 'RFB');
  assert.equal(structural.actType, 'INSTRUÇÃO NORMATIVA');
  assert.equal(structural.actNumber, '2344/2026');

  const douConnector: CollectionConnector = {
    key: douKey,
    version: 'test',
    async collect() {
      return {
        publications: [{
          title,
          sphere: 'FEDERAL',
          agency: structural.agency,
          actType: structural.actType,
          actNumber: structural.actNumber,
          publishedAt: new Date('2026-09-23T00:00:00Z'),
          content,
          officialUrl: 'https://pesquisa.in.gov.br/imprensa/jsp/visualiza/index.jsp?data=23/09/2026&jornal=515&pagina=1',
          externalId: '2026-09-23:DO1:180:999001',
          metadata: {
            sourceRole: 'PRIMARY',
            ingestionChannel: 'INLABS',
            officialUrlGranularity: 'PAGE',
          },
        }],
      };
    },
  };

  const oneRowSearch = `<!doctype html><html><body>
  <div>Total de atos localizados: 1</div><div>Página 1 de 1</div>
  <table><tbody><tr>
  <td><a href="https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/150001">Instrução Normativa</a></td>
  <td>2.344</td><td>RFB</td><td>23/09/2026</td>
  <td>Altera regras de tributação federal e obrigações acessórias.</td>
  </tr></tbody></table></body></html>`;

  const rfbFetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith('/consulta.action')) {
      return new Response(oneRowSearch, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const api = /\/api\/consulta-externa\/ato\/150001\/visao\/(original|vigente|multivigente|relacional)$/.exec(url.pathname);
    if (api?.[1]) {
      if (api[1] === 'relacional') return new Response(null, { status: 403 });
      const payload = representationPayload(
        IN_API_ORIGINAL,
        api[1] as 'original' | 'vigente' | 'multivigente',
      );
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const registry = new ConnectorRegistry();
  registry.register(douConnector);
  registry.register(new RfbNormasConnector({
    fetch: rfbFetch,
    readState: async () => ({
      bootstrap: { complete: true, month: '2026-09', page: 1 },
      files: {},
    }),
    now: () => new Date('2026-09-23T16:00:00Z'),
    lookbackDays: 7,
  }));

  let sequence = 0;
  async function run(sourceId: string) {
    const runId = await createCollectionRun(db, {
      sourceId,
      scheduledFor: new Date(Date.now() - 120_000 + sequence++),
      triggerType: 'MANUAL',
    });
    const acquired = await acquireNextCollectionRun(db, `rfb-cross-source-${sequence}`);
    assert.ok(acquired);
    assert.equal(acquired.id, runId);
    return processAcquiredCollectionRun(db, registry, acquired, {
      timeoutMs: 10_000,
      heartbeatIntervalMs: 0,
    });
  }

  try {
    await db.insertInto('sources').values([
      {
        id: douSourceId,
        code: `dou-rfb-gate-${douSourceId}`,
        name: 'DOU RFB cross-source gate',
        jurisdiction_level: 'FEDERAL',
        agency: 'RFB',
        base_url: 'https://inlabs.in.gov.br/',
        connector_key: douKey,
        max_attempts: 1,
      },
      {
        id: rfbSourceId,
        code: `rfb-normas-gate-${rfbSourceId}`,
        name: 'RFB Normas cross-source gate',
        jurisdiction_level: 'FEDERAL',
        agency: 'RFB',
        base_url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action',
        connector_key: 'rfb-normas',
        max_attempts: 1,
      },
    ]).execute();

    const douRun = await run(douSourceId);
    assert.equal(douRun.status, 'SUCCESS');
    assert.equal(douRun.metrics.newPublications, 1);

    const rfbRun = await run(rfbSourceId);
    assert.equal(rfbRun.status, 'SUCCESS');
    assert.equal(rfbRun.metrics.newPublications, 0);
    assert.equal(rfbRun.metrics.newVersions, 0);
    assert.equal(rfbRun.metrics.existingPublications, 1);

    const publications = await db.selectFrom('publications')
      .select(['id', 'agency', 'act_type', 'act_number', 'published_on'])
      .where('agency', '=', 'RFB')
      .where('act_type', '=', 'INSTRUÇÃO NORMATIVA')
      .where('act_number', '=', '2344/2026')
      .where('published_on', '=', '2026-09-23')
      .execute();
    assert.equal(publications.length, 1);

    const publicationId = publications[0]!.id;
    const origins = await db.selectFrom('publication_origins')
      .select(['source_id', 'external_id'])
      .where('publication_id', '=', publicationId)
      .orderBy('source_id')
      .execute();
    assert.equal(origins.length, 2);
    assert.deepEqual(new Set(origins.map(row => row.source_id)), new Set([douSourceId, rfbSourceId]));

    const versions = await db.selectFrom('publication_versions')
      .select(['id', 'is_current', 'content_hash'])
      .where('publication_id', '=', publicationId)
      .execute();
    assert.equal(versions.length, 1, 'equivalent DOU/RFB original text must not create an artificial version');
    assert.equal(versions[0]!.is_current, true);
  } finally {
    const publicationIds = [...new Set(
      (await db.selectFrom('publication_origins')
        .select('publication_id')
        .where('source_id', 'in', [douSourceId, rfbSourceId])
        .execute())
        .map(row => row.publication_id),
    )];
    await db.deleteFrom('collection_runs').where('source_id', 'in', [douSourceId, rfbSourceId]).execute();
    await db.deleteFrom('publication_origins').where('source_id', 'in', [douSourceId, rfbSourceId]).execute();
    if (publicationIds.length) {
      await db.deleteFrom('publications').where('id', 'in', publicationIds).execute();
    }
    await db.deleteFrom('sources').where('id', 'in', [douSourceId, rfbSourceId]).execute();
    await db.destroy();
  }
});
