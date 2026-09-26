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

test('connector: complete official HTML is published even while redundant authenticated PDF is still rendering', async () => {
  const result = await new DoeSpConnector({
    fetch: api('2026-09-24'), now: () => new Date('2026-09-24T15:00:00Z'), lookbackDays: 1,
    forceReprocess: false, readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());
  assert.equal(result.partialFailures, undefined);
  assert.equal(result.publications.length, 1);
  const publication = result.publications[0]!;
  assert.equal(publication.contentHashPolicy, 'HTML_PRIMARY_MATERIAL_FILES');
  assert.equal(publication.metadata?.officialContentCompleteness, 'FULL_OFFICIAL_CONTENT');
  assert.equal(publication.metadata?.authenticatedPdf, 'NOT_RENDERED_BY_SOURCE');
  assert.equal(
    (publication.metadata?.authenticatedPdfError as Record<string, unknown>)?.code,
    'DOE_SP_AUTHENTICATED_PDF_NOT_READY',
  );
  assert.equal(publication.files, undefined);
});

test('connector: old never-rendered PDF remains non-blocking and deterministic under HTML-primary policy', async () => {
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

  assert.equal(result.partialFailures, undefined);
  assert.equal(result.publications.length, 1);
  const publication = result.publications[0]!;
  assert.equal(
    publication.metadata?.authenticatedPdf,
    'UNAVAILABLE_REDUNDANT',
  );
  const diagnostic =
    publication.metadata?.authenticatedPdfError as
      Record<string, unknown>;
  assert.equal(diagnostic.code, 'DOE_SP_HTTP_ERROR');
  assert.equal(diagnostic.kind, 'HTTP_ERROR');
  assert.equal(diagnostic.httpStatus, 403);
  assert.ok(!JSON.stringify(diagnostic).includes(marker));
  assert.ok(!JSON.stringify(diagnostic).includes('B'.repeat(80)));
});


test('connector: authenticated PDF 404 is recorded as provenance failure and does not block complete official HTML', async () => {
  const date = '2026-09-24';
  const regular = api(date);
  const notFoundFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input.toString());
    if (
      url.pathname.startsWith(
        '/v2/authentication/download/',
      )
    ) {
      return json(
        {
          title: 'HTTP 404 Not Found',
          message:
            'Documento autenticado não disponível.',
        },
        404,
      );
    }
    return regular(input, init);
  }) as typeof fetch;

  const result = await new DoeSpConnector({
    fetch: notFoundFetch,
    now: () => new Date('2026-09-24T15:00:00Z'),
    lookbackDays: 1,
    forceReprocess: false,
    readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());

  assert.equal(result.partialFailures, undefined);
  assert.equal(result.publications.length, 1);
  const publication = result.publications[0]!;
  assert.ok(publication.content);
  assert.equal(
    publication.metadata?.authenticatedPdf,
    'UNAVAILABLE_REDUNDANT',
  );
  assert.equal(
    (publication.metadata?.authenticatedPdfError as Record<string, unknown>)
      ?.httpStatus,
    404,
  );
  assert.equal(publication.files, undefined);
});

test('connector: missing material attachment keeps the item/day incomplete instead of claiming integral capture', async () => {
  const date = '2026-09-24';
  const regular = api(date);
  const attachmentId = 'material-attachment-1';
  const fetchWithMissingAttachment = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input.toString());
    if (url.pathname === `/v2/publications/${ID}`) {
      return json({
        id: ID,
        title:
          'COMUNICADO, DE 4 DE FEVEREIRO DE 2025',
        slug: SLUG,
        date,
        journal: 'Executivo',
        section: 'Diretoria de Inteligência de Dados',
        firstLevelSectionName: 'Atos Normativos',
        secondLevelSectionName:
          'Secretaria da Fazenda e Planejamento',
        publicationType: 'Comunicado',
        editionPages: [],
        content:
          '<p>Texto principal integral; tabela normativa no anexo.</p>',
        attachments: [{
          id: attachmentId,
          name: 'tabela.pdf',
          position: 1,
        }],
        authCode: undefined,
      });
    }
    if (url.pathname.includes(attachmentId)) {
      return json({ title: 'Not Found' }, 404);
    }
    return regular(input, init);
  }) as typeof fetch;

  const result = await new DoeSpConnector({
    fetch: fetchWithMissingAttachment,
    now: () => new Date('2026-09-24T15:00:00Z'),
    lookbackDays: 1,
    forceReprocess: false,
    readState: async () => EMPTY_DOE_SP_STATE,
  }).collect(context());

  assert.equal(result.publications.length, 0);
  assert.ok((result.partialFailures?.length ?? 0) > 0);
  const doeSp = result.metadata?.doeSp as {
    days: Array<{ complete: boolean; failed: number }>;
  };
  assert.equal(doeSp.days[0]?.complete, false);
  assert.equal(doeSp.days[0]?.failed, 1);
});

test('HTML-primary v2 excludes redundant authenticated PDF from contentHash while legacy v1 remains unchanged', () => {
  const shared = {
    title: 'PORTARIA SRE 42, DE 28 DE JULHO DE 2025',
    agency: 'SEFAZ-SP/SRE',
    sphere: 'STATE' as const,
    stateCode: 'SP',
    actType: 'PORTARIA',
    actNumber: '42/2025',
    publishedAt: new Date('2025-07-29T00:00:00Z'),
    content: 'Texto oficial integral e idêntico publicado em HTML.',
    officialUrl: 'https://doe.sp.gov.br/executivo/portaria-sre-42',
    externalId: 'doe-sp-html-primary-gate',
  };

  const legacyHtmlOnly = normalizePublication({
    sourceId: context().sourceId,
    publication: shared,
  });
  const legacyWithPdf = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      contentHashPolicy:
        'HTML_PRIMARY_MATERIAL_FILES',
      files: [{
        url: 'https://do-api-publication-pdf.doe.sp.gov.br/authenticated.pdf',
        mimeType: 'application/pdf',
        rawSha256:
          '8a7e747ac3233fb9dd33df41416086c2860b5c2f2099d7bd0df106bfa26f4f30',
        sizeBytes: 466_065,
        versionRole: 'PROVENANCE',
        metadata: {
          kind: 'AUTHENTICATED_PUBLICATION_PDF',
          origin: 'DOE_SP',
        },
      }],
    },
  });
  assert.notEqual(
    legacyHtmlOnly.contentHash,
    legacyWithPdf.contentHash,
    'v1 compatibility must remain byte-for-byte all-files semantics',
  );

  const htmlOnly = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      contentHashPolicy:
        'HTML_PRIMARY_MATERIAL_FILES',
    },
  });

  const withRedundantAuthenticatedPdf = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      contentHashPolicy:
        'HTML_PRIMARY_MATERIAL_FILES',
      files: [{
        url: 'https://do-api-publication-pdf.doe.sp.gov.br/authenticated.pdf',
        mimeType: 'application/pdf',
        rawSha256:
          '8a7e747ac3233fb9dd33df41416086c2860b5c2f2099d7bd0df106bfa26f4f30',
        sizeBytes: 466_065,
        metadata: {
          kind: 'AUTHENTICATED_PUBLICATION_PDF',
          origin: 'DOE_SP',
        },
      }],
    },
  });

  assert.equal(
    htmlOnly.identityHash,
    withRedundantAuthenticatedPdf.identityHash,
  );
  assert.equal(
    htmlOnly.contentText,
    withRedundantAuthenticatedPdf.contentText,
  );
  assert.equal(
    htmlOnly.contentHash,
    withRedundantAuthenticatedPdf.contentHash,
    'v2 must ignore redundant provenance-only PDFs',
  );
  assert.equal(htmlOnly.contentHashVersion, 2);
  assert.equal(withRedundantAuthenticatedPdf.contentHashVersion, 2);
  assert.equal(
    (withRedundantAuthenticatedPdf.metadata.files as unknown[] | undefined),
    undefined,
    'provenance-only PDF must not be copied into version metadata',
  );
  assert.equal(
    ((withRedundantAuthenticatedPdf.originMetadata.files as unknown[]) ?? []).length,
    1,
    'provenance-only PDF remains attached to its source origin',
  );
});

test('policy gate: attachment with independent content remains version-relevant in the legacy hash model', () => {
  const shared = {
    title: 'ATO COM ANEXO MATERIAL',
    agency: 'SEFAZ-SP/SRE',
    sphere: 'STATE' as const,
    stateCode: 'SP',
    actType: 'PORTARIA',
    actNumber: '99/2026',
    publishedAt: new Date('2026-09-26T00:00:00Z'),
    content: 'Texto principal integral em HTML; a tabela normativa está no anexo.',
    officialUrl: 'https://doe.sp.gov.br/executivo/ato-com-anexo-material',
    externalId: 'doe-sp-material-attachment-gate',
  };

  const withoutAttachment = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      contentHashPolicy:
        'HTML_PRIMARY_MATERIAL_FILES',
    },
  });

  const withMaterialAttachment = normalizePublication({
    sourceId: context().sourceId,
    publication: {
      ...shared,
      files: [{
        url: 'https://doe.sp.gov.br/attachments/tabela-normativa.pdf',
        mimeType: 'application/pdf',
        rawSha256:
          'b7a902c4f91381ba732525d83fb422e62156fc8040aa7862ef53c307caf7a341',
        sizeBytes: 152_681,
        versionRole: 'MATERIAL_CONTENT',
        metadata: {
          kind: 'ATTACHMENT',
          origin: 'DOE_SP',
          materialContent: true,
        },
      }],
    },
  });

  assert.equal(
    withoutAttachment.identityHash,
    withMaterialAttachment.identityHash,
  );
  assert.notEqual(
    withoutAttachment.contentHash,
    withMaterialAttachment.contentHash,
    'material attachments must continue to influence version semantics',
  );
});
