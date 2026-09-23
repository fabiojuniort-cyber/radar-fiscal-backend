import assert from 'node:assert/strict';
import test from 'node:test';

import { SpedClient } from '../src/modules/collection/sped.client.js';
import { SpedConnector } from '../src/modules/collection/sped.connector.js';
import { parseSpedPage } from '../src/modules/collection/sped.parser.js';

const BASE = 'https://www.gov.br/sped/pt-br';
const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function html(body: string): Response {
  return new Response('<!doctype html><html><body>' + body + '</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function listing(items: Array<{ url: string; title: string }>): Response {
  const parent = items[0]?.url.replace(/\/[^/]+$/, '') ?? BASE;
  const state = JSON.stringify({
    content: {
      title: 'Documentos técnicos',
      items: [
        ...items.map((item) => ({ '@id': item.url, title: item.title })),
        { '@id': parent + '/@contextnavigation', title: 'context navigation' },
        { '@id': parent + '/@querystring-search?fullobjects=1', title: 'query service' },
        { '@id': parent + '/@@images/image', title: 'image rendition' },
        { '@id': parent + '/object_copy', title: 'copy action' },
      ],
      internalApiUrl: parent + '/@breadcrumbs',
    },
  });
  return html(
    '<h1>Documentos técnicos</h1><div class="ui small indeterminate text loader">Carregando</div>' +
      '<script>window.__data=' + state + ';</script>',
  );
}

function documentPage(
  module: string,
  title: string,
  created: string,
  filename: string,
): Response {
  return html(
    '<h1>' + module + '</h1><h2>' + title + '</h2>' +
      '<p>Criado em ' + created + '</p>' +
      '<a href="@@display-file/file">' + filename + '</a>',
  );
}

function pdf(label: string): Response {
  return new Response(new TextEncoder().encode('%PDF-1.7\n' + label), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="' + label + '.pdf"',
      etag: '"govbr-v1"',
    },
  });
}

function zip(label: string): Response {
  return new Response(
    new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(label)]),
    {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="' + label + '.zip"',
        etag: '"govbr-v1"',
      },
    },
  );
}

function govbrRouter() {
  const docs = new Map<string, Response | (() => Response)>([
    ['/assuntos/escrituracoes-digitais/efd-icms-ipi', () => html('<h1>EFD ICMS IPI</h1>')],
    ['/assuntos/comunicados/efd-icms-ipi', () => html('<h1>Comunicados EFD ICMS IPI</h1>')],
    ['/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos', () =>
      listing([
        {
          url: BASE + '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos/guia-pratico-efd-versao-3-2-4.pdf',
          title: 'Guia Prático EFD ICMS IPI versão 3.2.4',
        },
      ])],
    ['/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos/guia-pratico-efd-versao-3-2-4.pdf', () =>
      documentPage('EFD ICMS IPI', 'Guia Prático EFD ICMS IPI versão 3.2.4', '10/09/2026', 'guia-3.2.4.pdf')],

    ['/assuntos/escrituracoes-digitais/efd-contribuicoes', () => html('<h1>EFD Contribuições</h1>')],
    ['/assuntos/comunicados/efd-contribuicoes', () => html('<h1>Comunicados EFD Contribuições</h1>')],
    ['/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos', () =>
      listing([
        {
          url: BASE + '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-11-2026',
          title: 'Nota Técnica 11/2026',
        },
        {
          url: BASE + '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-12-2026',
          title: 'Nota Técnica 12/2026',
        },
      ])],
    ['/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-11-2026', () =>
      documentPage('EFD Contribuições', 'Nota Técnica 11/2026 - EFD-Contribuições', '02/04/2026', 'nt-11-2026.pdf')],
    ['/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-12-2026', () =>
      documentPage('EFD Contribuições', 'Nota Técnica 12/2026 - Redução linear de incentivos e benefícios', '02/04/2026', 'nt-12-2026.pdf')],

    ['/assuntos/escrituracoes-digitais/efd-reinf', () => html('<h1>EFD-Reinf</h1>')],
    ['/assuntos/comunicados/efd-reinf', () => html('<h1>Comunicados EFD-Reinf</h1>')],
    ['/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos', () =>
      listing([
        {
          url: BASE + '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos/nota-tecnica-01-2026',
          title: 'Nota Técnica 01/2026 - EFD-Reinf',
        },
        {
          url: BASE + '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos/pacote-xsd-eventos-efd-reinf-v-2-1-2',
          title: 'Pacote XSD Eventos EFD Reinf v 2.1.2',
        },
      ])],
    ['/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos/nota-tecnica-01-2026', () =>
      documentPage('EFD-Reinf', 'Nota Técnica 01/2026 - Ajustes nos leiautes da versão 2.1.2', '02/06/2026', 'nt-reinf-01-2026.pdf')],
    ['/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos/pacote-xsd-eventos-efd-reinf-v-2-1-2', () =>
      documentPage('EFD-Reinf', 'Pacote XSD Eventos EFD Reinf v 2.1.2', '02/06/2026', 'xsd-reinf-2.1.2.zip')],

    ['/assuntos/documentos-fiscais/dere', () => html('<h1>DeRE</h1>')],
    ['/assuntos/comunicados/dere', () => html('<h1>Comunicados DeRE</h1>')],
    ['/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1', () =>
      listing([
        {
          url: BASE + '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1/02-leiautes-e-eventos-v1-2-0',
          title: '02 Leiautes e Eventos v1.2.0',
        },
        {
          url: BASE + '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1/06-xsd-v1-2-0',
          title: '06 XSD v1.2.0',
        },
      ])],
    ['/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versoes-anteriores', () =>
      html('<h1>Versões anteriores DeRE</h1>')],
    ['/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1/02-leiautes-e-eventos-v1-2-0', () =>
      documentPage('DeRE', 'DeRE - Leiautes e Eventos versão 1.2.0', '05/09/2026', 'dere-leiautes-1.2.0.pdf')],
    ['/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1/06-xsd-v1-2-0', () =>
      documentPage('DeRE', 'DeRE - XSD versão 1.2.0', '05/09/2026', 'dere-xsd-1.2.0.zip')],
  ]);

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const relative = url.pathname.replace('/sped/pt-br', '');

    if (url.pathname.endsWith('/@@display-file/file')) {
      const parent = relative.replace('/@@display-file/file', '');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === '"govbr-v1"') {
        return new Response(null, { status: 304, headers: { etag: '"govbr-v1"' } });
      }
      if (/xsd/i.test(parent)) return zip(parent.split('/').at(-1) ?? 'xsd');
      return pdf(parent.split('/').at(-1) ?? 'document');
    }

    const value = docs.get(relative);
    if (!value) {
      return new Response('not found', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    return typeof value === 'function' ? value() : value.clone();
  }) as typeof fetch;
}

test('gov.br is the default SPED portal and captures current gates through Volto hydration', async () => {
  const result = await new SpedConnector({
    fetch: govbrRouter(),
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  const titles = result.publications.map((publication) => publication.title);
  assert.ok(titles.some((title) => title.includes('3.2.4')));
  assert.ok(titles.some((title) => title.includes('Nota Técnica 11/2026')));
  assert.ok(titles.some((title) => title.includes('Nota Técnica 12/2026')));
  assert.ok(titles.some((title) => title.includes('Nota Técnica 01/2026')));
  assert.ok(titles.some((title) => title.includes('XSD Eventos EFD Reinf')));
  assert.ok(titles.some((title) => title.includes('Leiautes e Eventos versão 1.2.0')));
  assert.ok(titles.some((title) => title.includes('XSD versão 1.2.0')));

  assert.equal((result.metadata?.sped as { portal?: string }).portal, 'GOVBR');

  const guide = result.publications.find((publication) => publication.title.includes('3.2.4'));
  assert.ok(guide);
  assert.equal(guide.metadata?.sourceRole, 'PRIMARY');
  assert.equal(guide.metadata?.sourcePortal, 'GOVBR');
  assert.equal(guide.metadata?.sourceCreatedAt, '2026-09-10');
  assert.equal(guide.publishedAt, undefined);
  assert.match(guide.identityKey ?? '', /^SPED\|EFD_ICMS_IPI\|GUIDE\|/);
  assert.equal(guide.files?.length, 1);
  assert.match(guide.files?.[0]?.rawSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.ok(guide.files?.[0]?.url.endsWith('/@@display-file/file'));

  assert.equal(result.partialFailures?.length ?? 0, 0);
});

test('gov.br checkpoint replay is idempotent and avoids redownloading known files', async () => {
  const first = await new SpedConnector({
    fetch: govbrRouter(),
    now: () => new Date('2026-09-22T12:00:00Z'),
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  const state = first.metadata?.spedState as {
    items: Record<string, unknown>;
    pages: Record<string, unknown>;
  };

  const second = await new SpedConnector({
    fetch: govbrRouter(),
    now: () => new Date('2026-09-22T13:00:00Z'),
    readState: async () => state as never,
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  assert.equal(second.publications.length, 0);
  assert.equal((second.metadata?.sped as { downloadedCount: number }).downloadedCount, 0);
  assert.ok((second.metadata?.sped as { skippedKnownDocumentCount: number }).skippedKnownDocumentCount > 0);
});


test('live gov.br SPED official HTTPS gates are parseable and downloadable', {
  skip: process.env.GITHUB_ACTIONS !== 'true',
  timeout: 180_000,
}, async () => {
  const client = new SpedClient({
    timeoutMs: 30_000,
    maxFileBytes: 80 * 1024 * 1024,
  });
  const signal = new AbortController().signal;

  const directPages = [
    {
      gate: 'EFD_ICMS_IPI_GUIDE_324',
      url: BASE + '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos/guia-pratico-efd-versao-3-2-4.pdf',
      title: /3\.2\.4/i,
    },
    {
      gate: 'EFD_CONTRIB_NT_11_2026',
      url: BASE + '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-11-2026-descontinuidade-da-efd-contribuicoes-orientacoes-para-os-contribuintes',
      title: /11\/2026/i,
    },
    {
      gate: 'EFD_CONTRIB_NT_12_2026',
      url: BASE + '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-12-2026-reducao-linear-de-incentivos-e-beneficios-lc-224',
      title: /12\/2026/i,
    },
    {
      gate: 'EFD_REINF_NT_01_2026',
      url: BASE + '/assuntos/escrituracoes-digitais/efd-reinf/documento-tecnicos/versao-atual/notas-tecnicas-e-orientativas/notas-tecnicas/1-2026',
      title: /1-2026|01\/2026/i,
    },
    {
      gate: 'EFD_REINF_XSD_212',
      url: BASE + '/assuntos/escrituracoes-digitais/efd-reinf/documento-tecnicos/versao-atual/esquemas-xsd/xsd-eventos',
      title: /2\.1\.2/i,
    },
  ] as const;

  for (const gate of directPages) {
    const html = await client.getHtml(gate.url, signal);
    const page = parseSpedPage(html.html, html.url);
    assert.match(page.title, gate.title, gate.gate);
    assert.ok(page.fileLinks.length >= 1, gate.gate + ' must expose an official file');

    const file = await client.downloadFile(page.fileLinks[0]!.url, signal);
    assert.equal(file.status, 'DOWNLOADED', gate.gate);
    if (file.status === 'DOWNLOADED') {
      assert.match(file.rawSha256, /^[a-f0-9]{64}$/, gate.gate);
      assert.ok(file.sizeBytes > 0, gate.gate);
      assert.ok(file.url.startsWith(BASE + '/'), gate.gate);
      console.error('SPED_GOVBR_GATE=' + JSON.stringify({
        gate: gate.gate,
        title: page.title,
        pageUrl: html.url,
        fileUrl: file.url,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        rawSha256: file.rawSha256,
      }));
    }
  }

  const dereIndexUrl =
    BASE + '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1';
  const dereHtml = await client.getHtml(dereIndexUrl, signal);
  const dereIndex = parseSpedPage(dereHtml.html, dereHtml.url);
  const dere120Links = dereIndex.links.filter((link) =>
    /1\.2\.0|1-2-0/i.test(link.text + ' ' + link.url),
  );

  console.error('SPED_GOVBR_DERE_120_LINKS=' + JSON.stringify(
    dere120Links.slice(0, 20),
  ));
  assert.ok(dere120Links.length > 0, 'DeRE current page must expose version 1.2.0 links');
});


test('live gov.br SPED inventory uses production discovery without downloading bulk files', {
  skip: process.env.GITHUB_ACTIONS !== 'true',
  timeout: 300_000,
}, async () => {
  const liveFetch = globalThis.fetch;
  const inventoryFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );

    if (/\/@@(?:display-file|download)\/file$/i.test(url.pathname)) {
      const looksZip = /xsd|schema|\.zip/i.test(url.pathname);
      if (looksZip) {
        return new Response(
          new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x52, 0x46]),
          {
            status: 200,
            headers: {
              'content-type': 'application/zip',
              etag: '"inventory"',
            },
          },
        );
      }

      return new Response(
        new TextEncoder().encode('%PDF-1.7\nRF'),
        {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            etag: '"inventory"',
          },
        },
      );
    }

    return liveFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;

  const result = await new SpedConnector({
    fetch: inventoryFetch,
    maxCrawlDepth: 8,
    maxPagesPerModule: 1000,
    maxRechecksPerRun: 0,
  }).collect(CONTEXT);

  const moduleCounts = Object.fromEntries(
    ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE'].map((module) => [
      module,
      result.publications.filter((publication) => publication.metadata?.module === module).length,
    ]),
  );
  const fileReferences = Object.fromEntries(
    ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE'].map((module) => [
      module,
      result.publications
        .filter((publication) => publication.metadata?.module === module)
        .reduce((sum, publication) => sum + (publication.files?.length ?? 0), 0),
    ]),
  );
  const withLegacyReferences = result.publications.filter(
    (publication) =>
      Array.isArray(publication.metadata?.legacyReferences) &&
      (publication.metadata?.legacyReferences as unknown[]).length > 0,
  );

  console.error('SPED_GOVBR_INVENTORY=' + JSON.stringify({
    metadata: result.metadata?.sped,
    publicationCount: result.publications.length,
    moduleCounts,
    fileReferences,
    publicationFileReferenceCount: result.publications.reduce(
      (sum, publication) => sum + (publication.files?.length ?? 0),
      0,
    ),
    withLegacyReferences: withLegacyReferences.length,
    legacyReferenceSamples: withLegacyReferences.slice(0, 20).map((publication) => ({
      title: publication.title,
      module: publication.metadata?.module,
      legacyReferences: publication.metadata?.legacyReferences,
    })),
    partialFailures: result.partialFailures ?? [],
  }));

  assert.equal(result.partialFailures?.length ?? 0, 0);
  assert.ok(result.publications.length > 0);
  assert.ok(moduleCounts.EFD_ICMS_IPI > 0);
  assert.ok(moduleCounts.EFD_CONTRIBUICOES > 0);
  assert.ok(moduleCounts.EFD_REINF > 0);
  assert.ok(moduleCounts.DERE > 0);
});
