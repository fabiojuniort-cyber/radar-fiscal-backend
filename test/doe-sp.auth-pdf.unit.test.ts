import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { DOE_SP_SEARCH_API, DoeSpClient } from '../src/modules/collection/doe-sp.client.js';
import { DoeSpConnector, EMPTY_DOE_SP_STATE } from '../src/modules/collection/doe-sp.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';

/*
 * Real production case (25/09/2026): the authenticated PDF of
 * "COMUNICADO, DE 4 DE FEVEREIRO DE 2025" (DOE 05/02/2025, id
 * b8bec255-a9b3-44c0-1648-08dd40ce108a, 7.5 MB HTML) is answered with
 * `{ isSuccess: true, message: 'O documento encontra-se com status "Processando"' }`
 * — the source never rendered it. Before this fix the item failed forever and
 * blocked the bootstrap cursor on that date.
 */
const PROCESSING = {
  isSuccess: true,
  message: 'O documento encontra-se com status "Processando"',
  status: { description: 'Requisição processada com sucesso.', title: 'HTTP 200 OK', name: 'OK', value: 200 },
};

const ID = 'b8bec255-a9b3-44c0-1648-08dd40ce108a';
const JOURNAL = 'ca96256b-6ca1-407f-866e-567ef9430123';
const SECTION = '257b103f-1eb2-4f24-a170-4e553c7e4aac';
const TYPE_COMUNICADO = 'f6ac099f-77a7-4366-a64a-fa20b90e6528';
const SLUG = 'executivo/secretaria-da-fazenda-e-planejamento/comunicado-de-4-de-fevereiro-de-2025-2025020411275341992861381';
const HIERARCHY = 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual > Coordenadoria de Fiscalização, Cobrança, Arrecadação, Inteligência de Dados e Atendimento > Diretoria de Inteligência de Dados';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function api(date: string) {
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const path = url.pathname;
    if (url.origin + '/' !== DOE_SP_SEARCH_API) return json({ status: 404 }, 404);
    if (path === '/v2/journals') return json({ count: 1, items: [{ id: JOURNAL, name: 'Executivo' }] });
    if (path === '/v2/sections') return json({ count: 1, items: [{ id: SECTION, name: 'Atos Normativos' }] });
    if (path === '/v2/summary/structured') {
      return json(url.searchParams.get('Date') === date
        ? { journalName: 'Executivo', items: [{ id: SECTION, name: 'Atos Normativos', children: [{ id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf', name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO', publications: [{ id: ID, title: 'COMUNICADO, DE 4 DE FEVEREIRO DE 2025', slug: SLUG }] }] }] }
        : { items: [] });
    }
    if (path === '/v2/summary/list') {
      return json(url.searchParams.get('Date') === date
        ? { pages: 1, pageSize: 10, publications: [{ isLegacy: false, id: ID, publicationTypeId: TYPE_COMUNICADO, date: `${date}T01:00:40.1`, title: 'COMUNICADO, DE 4 DE FEVEREIRO DE 2025', slug: SLUG, excerpt: 'Divulga relação de contribuintes', hierarchy: HIERARCHY }] }
        : { pages: 0, pageSize: 10, publications: [] });
    }
    if (path === '/v2/summary/filters') return json({ publicationTypes: [{ id: TYPE_COMUNICADO, name: 'Comunicado' }] });
    if (path === `/v2/publications/${ID}`) {
      return json({
        id: ID, title: 'COMUNICADO, DE 4 DE FEVEREIRO DE 2025', slug: SLUG, date, journal: 'Executivo',
        section: 'Diretoria de Inteligência de Dados', firstLevelSectionName: 'Atos Normativos',
        secondLevelSectionName: 'Secretaria da Fazenda e Planejamento', publicationType: 'Comunicado',
        editionPages: [], content: '<p>A Diretoria de Inteligência de Dados divulga a relação anexa.</p>',
        attachments: [], authCode: '2025.02.04.1.1.27.5.3.4.199.861381',
      });
    }
    if (path.startsWith('/v2/authentication/download/')) return json(PROCESSING);
    return json({ status: 404 }, 404);
  }) as typeof fetch;
}

const context = () => ({
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
});

test('client: "Processando" envelope is a retryable NOT_READY error, not an invalid PDF', async () => {
  const client = new DoeSpClient({ fetch: (async () => json(PROCESSING)) as typeof fetch });
  await assert.rejects(client.downloadAuthenticatedPdf('2025.02.04.1.1.27.5.3.4.199.861381', new AbortController().signal), (error: unknown) =>
    error instanceof ConnectorError &&
    error.code === 'DOE_SP_AUTHENTICATED_PDF_NOT_READY' &&
    error.retryable === true &&
    String(error.metadata?.sourceMessage).includes('Processando'));
});

test('connector: a recent act whose PDF is still rendering is retried (not published yet)', async () => {
  const result = await new DoeSpConnector({
    fetch: api('2026-09-24'), now: () => new Date('2026-09-24T15:00:00Z'), lookbackDays: 1,
    forceReprocess: false, readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());
  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures?.[0]?.code, 'DOE_SP_AUTHENTICATED_PDF_NOT_READY');
});

test('connector: after the grace period the act is published without the never-rendered PDF, deterministically', async () => {
  const run = () => new DoeSpConnector({
    fetch: api('2025-02-05'), now: () => new Date('2026-09-24T15:00:00Z'), lookbackDays: 1,
    bootstrapStartDate: '2025-02-05', forceReprocess: false, readState: async () => ({
      ...EMPTY_DOE_SP_STATE, coverageFrom: '2025-02-05', windowEnd: '2026-09-24',
      pendingRanges: [{ from: '2025-02-05', to: '2025-02-05' }], days: {},
    }),
  }).collect(context());
  const first = await run();
  assert.equal(first.partialFailures, undefined);
  assert.equal(first.completion, undefined);
  assert.equal(first.publications.length, 1);
  const publication = first.publications[0]!;
  assert.equal(publication.externalId, ID);
  assert.equal(publication.files, undefined);
  assert.equal(publication.metadata?.authenticatedPdf, 'NOT_RENDERED_BY_SOURCE');
  assert.equal((first.metadata?.doeSp as { counters: { authPdfNotRendered: number } }).counters.authPdfNotRendered, 1);

  const second = await run();
  const hash = (item: typeof publication) => normalizePublication({ sourceId: context().sourceId, publication: item }).contentHash;
  assert.equal(hash(second.publications[0]!), hash(publication));
});
