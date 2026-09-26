import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { DOE_SP_SEARCH_API, DoeSpClient } from '../src/modules/collection/doe-sp.client.js';
import { DoeSpConnector, EMPTY_DOE_SP_STATE, isDoeSpEquivalentRepresentationAuthPdf404 } from '../src/modules/collection/doe-sp.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { portal } from './doe-sp.portal.js';

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

const EQ_DATE = '2026-09-24';
const EQ_BAD_ID = '6098db3e-c841-40de-c0fc-08ddce07602e';
const EQ_GOOD_ID = '645399a3-5a4e-44f7-c5cd-08ddcdea30ea';
const EQ_BAD_AUTH = '2026.09.23.1.1.28.3.214.9000001';
const EQ_GOOD_AUTH = '2026.09.23.1.1.28.3.214.9000002';
const EQ_TYPE_PORTARIA = 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66';
const EQ_TITLE = 'PORTARIA SRE 42, DE 23 DE SETEMBRO DE 2026';
const EQ_HIERARCHY = 'Executivo > Atos Normativos > Secretaria da Fazenda e Planejamento > Subsecretaria da Receita Estadual';
const EQ_KNOWN_404_MESSAGE = 'Não foi possível consultar o status de processamento do documento solicitado.';

interface EquivalentFixtureOptions {
  includeAlternative?: boolean;
  badContent?: string;
  goodContent?: string;
  badTitle?: string;
  goodTitle?: string;
  badStatus?: number;
  badMessage?: string;
}

function equivalentFixture(options: EquivalentFixtureOptions = {}) {
  const includeAlternative = options.includeAlternative ?? true;
  const badTitle = options.badTitle ?? EQ_TITLE;
  const goodTitle = options.goodTitle ?? EQ_TITLE;
  const badContent = options.badContent ?? '<p>Texto oficial idêntico da Portaria SRE 42.</p>';
  const goodContent = options.goodContent ?? badContent;
  const items = [
    {
      isLegacy: false,
      id: EQ_BAD_ID,
      publicationTypeId: EQ_TYPE_PORTARIA,
      date: `${EQ_DATE}T01:00:00`,
      title: badTitle,
      slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-42-duplicata-a',
      excerpt: 'Altera disciplina tributária.',
      hierarchy: EQ_HIERARCHY,
      totalTermsFound: 0,
    },
    ...(includeAlternative
      ? [{
          isLegacy: false,
          id: EQ_GOOD_ID,
          publicationTypeId: EQ_TYPE_PORTARIA,
          date: `${EQ_DATE}T01:00:01`,
          title: goodTitle,
          slug: 'executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-42-duplicata-b',
          excerpt: 'Altera disciplina tributária.',
          hierarchy: EQ_HIERARCHY,
          totalTermsFound: 0,
        }]
      : []),
  ];
  const structuredPublications = items.map((item) => ({
    id: item.id,
    title: item.title,
    slug: item.slug,
  }));
  const detailsFixture: Record<string, Record<string, unknown>> = {
    [EQ_BAD_ID]: {
      id: EQ_BAD_ID,
      title: badTitle,
      slug: items[0]!.slug,
      date: EQ_DATE,
      journal: 'Executivo',
      section: 'Subsecretaria da Receita Estadual',
      firstLevelSectionName: 'Atos Normativos',
      secondLevelSectionName: 'Secretaria da Fazenda e Planejamento',
      publicationType: 'Portaria',
      editionPages: [],
      content: badContent,
      attachments: [],
      authCode: EQ_BAD_AUTH,
    },
  };
  if (includeAlternative) {
    detailsFixture[EQ_GOOD_ID] = {
      id: EQ_GOOD_ID,
      title: goodTitle,
      slug: items[1]!.slug,
      date: EQ_DATE,
      journal: 'Executivo',
      section: 'Subsecretaria da Receita Estadual',
      firstLevelSectionName: 'Atos Normativos',
      secondLevelSectionName: 'Secretaria da Fazenda e Planejamento',
      publicationType: 'Portaria',
      editionPages: [],
      content: goodContent,
      attachments: [],
      authCode: EQ_GOOD_AUTH,
    };
  }

  return portal({
    days: {
      [EQ_DATE]: {
        structured: {
          journalName: 'Executivo',
          items: [{
            id: SECTION,
            name: 'Atos Normativos',
            children: [{
              id: 'e0e06c19-4428-471f-7d57-08db6b94d2bf',
              name: 'SECRETARIA DA FAZENDA E PLANEJAMENTO',
              publications: structuredPublications,
            }],
          }],
        },
        list: {
          pages: 1,
          pageSize: 10,
          publications: items,
        },
      },
    },
    details: detailsFixture,
    authResponses: {
      [EQ_BAD_AUTH]: {
        status: options.badStatus ?? 404,
        body: {
          traceIdentifier: 'test',
          requestErrors: [options.badMessage ?? EQ_KNOWN_404_MESSAGE],
          title: `HTTP ${options.badStatus ?? 404}`,
          status: options.badStatus ?? 404,
        },
      },
    },
  });
}

async function collectEquivalentFixture(
  options: EquivalentFixtureOptions = {},
) {
  const fixture = equivalentFixture(options);
  const result = await new DoeSpConnector({
    fetch: fixture.fetch,
    now: () => new Date(EQ_DATE + 'T15:00:00Z'),
    lookbackDays: 1,
    forceReprocess: false,
    readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());
  return { fixture, result };
}

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


test('client: authenticated PDF HTTP error retains only bounded sanitized diagnostics', async () => {
  const authCode = '2025.07.28.1.1.27.5.214.1229474';
  const marker = 'REDACT_ME_VALUE';
  const body = JSON.stringify({
    message: 'Acesso negado para o documento solicitado.',
    password: marker,
    authCode,
    content: 'A'.repeat(180),
    extra: 'Z'.repeat(600),
  });
  const client = new DoeSpClient({
    fetch: (async () => new Response(body, {
      status: 403,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    })) as typeof fetch,
  });

  await assert.rejects(
    client.downloadAuthenticatedPdf(authCode, new AbortController().signal),
    (error: unknown) => {
      if (!(error instanceof ConnectorError)) return false;
      assert.equal(error.code, 'DOE_SP_HTTP_ERROR');
      assert.equal(error.kind, 'HTTP_ERROR');
      assert.equal(error.retryable, false);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.metadata?.endpoint, '/v2/authentication/download/{authCode}');
      assert.equal(error.metadata?.contentType, 'application/problem+json; charset=utf-8');
      const sample = String(error.metadata?.responseSample ?? '');
      assert.ok(sample.length > 0);
      assert.ok(sample.length <= 240);
      assert.match(sample, /Acesso negado/);
      assert.ok(!sample.includes(marker));
      assert.ok(!sample.includes(authCode));
      assert.ok(!sample.includes('A'.repeat(80)));
      return true;
    },
  );
});

test('connector: authenticated PDF HTTP diagnostics survive in the recorded partial failure', async () => {
  const date = '2026-09-24';
  const marker = 'REDACT_ME_CONNECTOR';
  const regular = api(date);
  const diagnosticFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname.startsWith('/v2/authentication/download/')) {
      return new Response(JSON.stringify({
        message: 'Forbidden by upstream',
        password: marker,
        content: 'B'.repeat(160),
      }), {
        status: 403,
        headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      });
    }
    return regular(input, init);
  }) as typeof fetch;

  const result = await new DoeSpConnector({
    fetch: diagnosticFetch,
    now: () => new Date('2026-09-24T15:00:00Z'),
    lookbackDays: 1,
    forceReprocess: false,
    readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());

  assert.equal(result.publications.length, 0);
  const failure = result.partialFailures?.[0];
  assert.equal(failure?.code, 'DOE_SP_HTTP_ERROR');
  assert.match(failure?.message ?? '', /status=403/);
  assert.match(failure?.message ?? '', /endpoint=\/v2\/authentication\/download\/\{authCode\}/);
  assert.match(failure?.message ?? '', /contentType=application\/problem\+json; charset=utf-8/);
  assert.match(failure?.message ?? '', /Forbidden by upstream/);
  assert.ok(!(failure?.message ?? '').includes(marker));
  assert.ok(!(failure?.message ?? '').includes('B'.repeat(80)));
});


test('connector: isolated known authenticated PDF 404 still blocks the item/day', async () => {
  const { result } = await collectEquivalentFixture({ includeAlternative: false });
  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.code, 'DOE_SP_HTTP_ERROR');
  const day = (result.metadata?.doeSp as { days: Array<{ date: string; complete: boolean; failed: number }> }).days
    .find((item) => item.date === EQ_DATE);
  assert.equal(day?.complete, false);
  assert.equal(day?.failed, 1);
});

test('connector: same strong identity with different normalized text does not use the 404 fallback', async () => {
  const { result } = await collectEquivalentFixture({
    goodContent: '<p>Texto oficial divergente da Portaria SRE 42.</p>',
  });
  assert.deepEqual(result.publications.map((item) => item.externalId), [EQ_GOOD_ID]);
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.itemReference, `${EQ_DATE}#${EQ_BAD_ID}`);
});

test('connector: same text with weak or divergent identity does not use the 404 fallback', async () => {
  const { result } = await collectEquivalentFixture({
    goodTitle: 'PORTARIA, DE 23 DE SETEMBRO DE 2026',
  });
  assert.deepEqual(result.publications.map((item) => item.externalId), [EQ_GOOD_ID]);
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.itemReference, `${EQ_DATE}#${EQ_BAD_ID}`);
});

test('connector: proven equivalent representation with valid alternate PDF completes both origins deterministically', async () => {
  const { result } = await collectEquivalentFixture();
  assert.equal(result.partialFailures, undefined);
  assert.deepEqual(
    result.publications.map((item) => item.externalId).sort(),
    [EQ_BAD_ID, EQ_GOOD_ID].sort(),
  );

  const good = result.publications.find((item) => item.externalId === EQ_GOOD_ID)!;
  const bad = result.publications.find((item) => item.externalId === EQ_BAD_ID)!;
  assert.equal(good.metadata?.authenticatedPdf, 'CAPTURED');
  assert.equal(bad.metadata?.authenticatedPdf, 'AUTH_PDF_404_EQUIVALENT_REPRESENTATION');
  assert.equal(bad.metadata?.sourceRole, 'VALIDATION');
  const equivalent =
    bad.metadata?.equivalentRepresentation as
      | Record<string, unknown>
      | undefined;
  assert.equal(equivalent?.externalId, EQ_GOOD_ID);
  const equivalentPdf =
    equivalent?.authenticatedPdf as
      | Record<string, unknown>
      | undefined;
  assert.equal(
    equivalentPdf?.ownerExternalId,
    EQ_GOOD_ID,
  );
  assert.equal(bad.files, undefined);
  assert.deepEqual(
    bad.versionFiles,
    good.files,
  );

  const normalizedGood = normalizePublication({ sourceId: context().sourceId, publication: good });
  const normalizedBad = normalizePublication({ sourceId: context().sourceId, publication: bad });
  assert.equal(normalizedGood.identityStrength, 'STRONG');
  assert.equal(normalizedBad.identityStrength, 'STRONG');
  assert.equal(normalizedBad.identityHash, normalizedGood.identityHash);
  assert.equal(normalizedBad.contentHash, normalizedGood.contentHash);
  assert.equal(
    Object.hasOwn(normalizedBad.originMetadata, 'files'),
    false,
  );
  assert.ok(
    Array.isArray(normalizedBad.metadata.files),
  );

  const meta = result.metadata?.doeSp as {
    counters: { authPdfEquivalent404: number };
    days: Array<{ date: string; complete: boolean; failed: number; published: number }>;
  };
  assert.equal(meta.counters.authPdfEquivalent404, 1);
  const day = meta.days.find((item) => item.date === EQ_DATE);
  assert.equal(day?.complete, true);
  assert.equal(day?.failed, 0);
  assert.equal(day?.published, 2);
});

test('strict 404 predicate rejects other statuses, messages and endpoints', () => {
  const make = (
    httpStatus: number,
    endpoint: string,
    responseSample: string,
  ) => new ConnectorError('DOE_SP_HTTP_ERROR', {
    code: 'DOE_SP_HTTP_ERROR',
    kind: 'HTTP_ERROR',
    retryable: false,
    httpStatus,
    metadata: {
      endpoint,
      contentType: 'application/json',
      responseSample,
    },
  });

  assert.equal(
    isDoeSpEquivalentRepresentationAuthPdf404(
      make(403, '/v2/authentication/download/{authCode}', EQ_KNOWN_404_MESSAGE),
    ),
    false,
  );
  assert.equal(
    isDoeSpEquivalentRepresentationAuthPdf404(
      make(404, '/v2/authentication/download/{authCode}', 'Documento não encontrado.'),
    ),
    false,
  );
  assert.equal(
    isDoeSpEquivalentRepresentationAuthPdf404(
      make(404, '/v2/other/{authCode}', EQ_KNOWN_404_MESSAGE),
    ),
    false,
  );
});


test('normalizer: alternate production PDF stays version-only for the 404 origin', () => {
  const productionSha =
    '8a7e747ac3233fb9dd33df41416086c2860b5c2f2099d7bd0df106bfa26f4f30';
  const productionSize = 466_065;
  const validFile = {
    url:
      'https://do-api-web-search.doe.sp.gov.br/v2/authentication/download/2025.07.28.1.1.27.5.214.1229788',
    mimeType: 'application/pdf',
    rawSha256: productionSha,
    sizeBytes: productionSize,
    metadata: {
      kind: 'AUTHENTICATED_PUBLICATION_PDF',
      origin: 'DOE_SP',
    },
  };
  const shared = {
    title:
      'PORTARIA SRE 42, DE 28 DE JULHO DE 2025',
    agency: 'SEFAZ-SP/SRE',
    sphere: 'STATE' as const,
    stateCode: 'SP',
    actType: 'PORTARIA',
    actNumber: '42/2025',
    publishedAt:
      new Date('2025-07-29T00:00:00Z'),
    content:
      'Texto canônico idêntico da Portaria SRE 42.',
  };

  const valid = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      officialUrl:
        'https://doe.sp.gov.br/executivo/portaria-sre-42-valid',
      externalId: EQ_GOOD_ID,
      files: [validFile],
      metadata: {
        sourceRole: 'PRIMARY',
        authenticatedPdf: 'CAPTURED',
      },
    },
  });

  const fallback = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      officialUrl:
        'https://doe.sp.gov.br/executivo/portaria-sre-42-404',
      externalId: EQ_BAD_ID,
      versionFiles: [validFile],
      metadata: {
        sourceRole: 'VALIDATION',
        authenticatedPdf:
          'AUTH_PDF_404_EQUIVALENT_REPRESENTATION',
        equivalentRepresentation: {
          externalId: EQ_GOOD_ID,
          authenticatedPdf: {
            ownerExternalId: EQ_GOOD_ID,
            rawSha256: productionSha,
            sizeBytes: productionSize,
          },
        },
      },
    },
  });

  assert.equal(valid.contentHash, fallback.contentHash);
  assert.equal(valid.identityHash, fallback.identityHash);
  const validOriginFiles =
    valid.originMetadata.files as
      | Array<Record<string, unknown>>
      | undefined;
  assert.equal(validOriginFiles?.[0]?.rawSha256, productionSha);
  assert.equal(validOriginFiles?.[0]?.sizeBytes, productionSize);
  assert.equal(
    Object.hasOwn(fallback.originMetadata, 'files'),
    false,
  );
  assert.equal(
    (fallback.metadata.files as Array<Record<string, unknown>>)[0]?.rawSha256,
    productionSha,
  );
});
