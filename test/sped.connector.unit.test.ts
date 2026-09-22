import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { SpedConnector } from '../src/modules/collection/sped.connector.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function moduleRoot(links: Array<[string, string]>) {
  return '<!doctype html><html><body><h1>Portal</h1>' + links.map(([href, text]) => '<a href="' + href + '">' + text + '</a>').join('') + '</body></html>';
}

function detail(moduleTitle: string, title: string, date: string, fileId: string, fileName = 'doc.pdf') {
  return '<!doctype html><html><body><h1>' + moduleTitle + '</h1><h2>' + title + '</h2><p>Publicado em ' + date + '</p><a href="/arquivo/download/' + fileId + '">' + fileName + '</a></body></html>';
}

function html(body: string) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function pdf(name: string, etag = '"v1"') {
  return new Response(new TextEncoder().encode('%PDF-1.7\n' + name), { status: 200, headers: { 'content-type': 'application/pdf', etag } });
}

function zip(name: string, etag = '"v1"') {
  return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(name)]), { status: 200, headers: { 'content-type': 'application/zip', etag } });
}

function router(options: { changedReinf?: boolean; failDere?: boolean; includeNewGuide?: boolean } = {}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const p = url.pathname;
    if (p === '/projeto/show/274') return html(moduleRoot([
      ['/item/show/7900', 'Guia Prático EFD ICMS IPI versão 3.2.1'],
      ['/item/show/8114', 'Guia Prático EFD ICMS IPI versão 3.2.2'],
      ...(options.includeNewGuide ? [['/item/show/9998', 'Guia Prático EFD ICMS IPI versão 3.2.3'] as [string, string]] : []),
    ]));
    if (p === '/item/show/1573') return html(moduleRoot([['/item/show/7900', 'Guia Prático EFD ICMS IPI versão 3.2.1'], ['/item/show/8114', 'Guia Prático EFD ICMS IPI versão 3.2.2']]));
    if (p === '/projeto/show/268') return html(moduleRoot([['/item/show/8058', 'EFD-CONTRIBUIÇÕES - ATUALIZAÇÃO DA NOTA TÉCNICA Nº 11 2026'], ['/item/show/8126', 'EFD-CONTRIBUIÇÕES - PUBLICAÇÃO DA NOTA TÉCNICA Nº 12']]));
    if (p === '/item/show/1545') return html(moduleRoot([['/item/show/5786', 'Tabela 4.3.11 - Versão 1.32']]));
    if (p === '/projeto/show/1196') return html(moduleRoot([
      ['/item/show/8116', 'Nota Técnica 01/2026 – Ajustes nos leiautes'],
      ['/item/show/8129', 'Nota Técnica 01/2026 republicada'],
      ['/item/show/2270', 'Esquemas XSD'],
      ['/item/show/9100', 'ESQUEMAS XSD - VERSÃO MAIS RECENTE'],
    ]));
    if (p === '/destaques/show/1199') return html(moduleRoot([
      ['/item/show/8116', 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2'],
      ['/item/show/8129', 'Nota Técnica 01/2026 republicada – Ajustes nos leiautes da versão 2.1.2'],
      ['/item/show/9001', 'Indisponibilidade Temporária'],
    ]));
    if (p === '/destaques/show/7') return html(moduleRoot([['/item/show/8114', 'Nova versão do Guia Prático da EFD ICMS IPI'], ['/item/show/8126', 'EFD-CONTRIBUIÇÕES - PUBLICAÇÃO DA NOTA TÉCNICA Nº 12'], ['/pagina/show/7950', 'DeRE - documentação técnica oficial'], ['/item/show/9999', 'Publicação da Versão 12.0.3 do Programa da ECF']]));
    if (p === '/projeto/show/2918') {
      return html(moduleRoot([['/pagina/show/7950', 'DeRE - documentação técnica oficial']]));
    }
    if (p === '/pagina/show/7950') {
      if (options.failDere) return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } });
      return html(detail('DeRE', 'Manual de Orientação da DeRE versão 1.0.0', '12/12/2025', '7951', 'DeRE_v1.0.0.zip'));
    }
    if (p === '/item/show/7900') return html(detail('EFD ICMS IPI', 'Guia Prático EFD ICMS IPI versão 3.2.1', '18/11/2025', '7901'));
    if (p === '/item/show/9998') return html(detail('EFD ICMS IPI', 'Guia Prático EFD ICMS IPI versão 3.2.3', '22/09/2026', '9998'));
    if (p === '/item/show/8114') return html(detail('EFD ICMS IPI', 'Guia Prático EFD ICMS IPI versão 3.2.2', '25/03/2026', '8112'));
    if (p === '/item/show/8058') return html(detail('EFD Contribuições', 'EFD-CONTRIBUIÇÕES - ATUALIZAÇÃO DA NOTA TÉCNICA Nº 11 2026', '20/02/2026', '8059'));
    if (p === '/item/show/8126') return html(detail('EFD Contribuições', 'Nota Técnica 012 2026 - ORIENTAÇÃO PARA OS CONTRIBUINTES DE PIS COFINS', '30/03/2026', '8127'));
    if (p === '/item/show/5786') return html(detail('EFD Contribuições', 'Tabela 4.3.11 - Versão 1.32', '16/03/2026', '5787', 'Tabela_4_3_11_V1.32.doc'));
    if (p === '/item/show/8116') return html(detail('EFD-Reinf', 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2', '25/03/2026', '8117'));
    if (p === '/item/show/8129') return new Response(null, { status: 302, headers: { location: '/pagina/show/8129' } });
    if (p === '/pagina/show/8129') return html(
      '<html><body><h1>EFD-Reinf</h1><h2>Nota Técnica 01/2026 republicada – Ajustes nos leiautes da versão 2.1.2</h2>' +
      '<p>Publicado em 31/03/2026</p><a href="/arquivo/show/8070">clique aqui</a></body></html>'
    );
    if (p === '/arquivo/show/8070') return html(detail('EFD-Reinf', 'Nota Técnica EFD-Reinf 01/2026', '31/03/2026', '8070'));
    if (p === '/item/show/2270') return html(detail('EFD-Reinf', 'ESQUEMAS XSD - VERSÃO MAIS RECENTE', '15/01/2026', '2271', 'reinf-xsd.zip'));
    if (p === '/item/show/9100') return html(
      '<html><body><h1>EFD-Reinf</h1><h2>ESQUEMAS XSD - VERSÃO MAIS RECENTE</h2>' +
      '<a href="/item/show/9101">XSD EFD-Reinf v2.1.2 - CNPJ Alfanumérico</a></body></html>'
    );
    if (p === '/item/show/9101') return html(detail(
      'EFD-Reinf',
      'XSD EFD-Reinf v2.1.2 - CNPJ Alfanumérico',
      '22/09/2026',
      '9101',
      'reinf-cnpj-alpha.zip'
    ));
    if (p === '/item/show/9001') return html('<html><body><h1>EFD-Reinf</h1><h2>Indisponibilidade Temporária</h2><p>Publicado em 25/03/2026</p></body></html>');
    if (p.startsWith('/arquivo/download/')) {
      const id = p.split('/').at(-1)!;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === '"v1"' && !options.changedReinf) return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      if (id === '2271' || id === '7951') return zip(id, '"v1"');
      if (id === '5787') return new Response(new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1,1]), { status: 200, headers: { 'content-type': 'application/msword', etag: '"v1"', 'content-disposition': 'attachment; filename="Tabela.doc"' } });
      const tag = options.changedReinf && id === '8070' ? '"v2"' : '"v1"';
      return pdf(id + (tag === '"v2"' ? '-changed' : ''), tag);
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

test('collects the four SPED modules and preserves historical gates and explicit Reinf republication', async () => {
  const result = await new SpedConnector({ fetch: router(), maxCrawlDepth: 2 }).collect(CONTEXT);
  assert.ok(result.publications.some(p => p.title.includes('3.2.1')));
  assert.ok(result.publications.some(p => p.title.includes('3.2.2')));
  assert.ok(result.publications.some(p => p.title.includes('NOTA TÉCNICA Nº 11')));
  assert.ok(result.publications.some(p => p.title.includes('Nota Técnica 012 2026')));
  assert.ok(result.publications.some(p => p.title.includes('01/2026 republicada')));
  assert.ok(result.publications.some(p => p.title.includes('CNPJ Alfanumérico')));
  assert.ok(result.publications.some(p => p.metadata?.module === 'DERE'));
  assert.ok(result.publications.some(p => p.metadata?.documentKind === 'OPERATIONAL_NOTICE'));
  assert.equal(result.publications.some(p => /ECF|ECD/.test(p.title)), false);
  const reinf = result.publications.filter(p => p.metadata?.documentFamily === 'EFD-Reinf NT 01/2026');
  assert.equal(reinf.length, 2);
  const republication = reinf.find(p => p.metadata?.republication === true);
  assert.ok(republication);
  assert.equal(republication.files?.length, 1);
  assert.deepEqual(republication.metadata?.linkedArtifactExternalIds, ['arquivo:8070']);
  assert.equal(
    result.publications.some(p => p.externalId === 'arquivo:8070'),
    false,
  );
  const normalized = reinf.map(p => normalizePublication({ sourceId: CONTEXT.sourceId, publication: p }));
  assert.notEqual(normalized[0]?.identityHash, normalized[1]?.identityHash);
});

test('reuses checkpoint without redownloading and changed bytes create a new content hash for same explicit publication', async () => {
  const first = await new SpedConnector({ fetch: router(), now: () => new Date('2026-09-21T00:00:00Z'), maxCrawlDepth: 2 }).collect(CONTEXT);
  const state = first.metadata?.spedState as {
    items: Record<string, any>;
    pages: Record<string, any>;
  };
  const second = await new SpedConnector({ fetch: router(), now: () => new Date('2026-09-21T01:00:00Z'), readState: async () => state, maxCrawlDepth: 2 }).collect(CONTEXT);
  assert.equal((second.metadata?.sped as { downloadedCount: number }).downloadedCount, 0);
  assert.ok((second.metadata?.sped as { reusedCheckpointCount: number }).reusedCheckpointCount > 0);

  const repubFirst = first.publications.find(p => p.title.includes('01/2026 republicada'))!;
  const changed = await new SpedConnector({ fetch: router({ changedReinf: true }), now: () => new Date('2026-09-23T00:00:00Z'), readState: async () => state, revisitAfterMs: 0, maxRechecksPerRun: 100, maxCrawlDepth: 2 }).collect(CONTEXT);
  const repubChanged = changed.publications.find(p => p.title.includes('01/2026 republicada'))!;
  const a = normalizePublication({ sourceId: CONTEXT.sourceId, publication: repubFirst });
  const b = normalizePublication({ sourceId: CONTEXT.sourceId, publication: repubChanged });
  assert.equal(a.identityHash, b.identityHash);
  assert.notEqual(a.contentHash, b.contentHash);
});


test('hourly incremental skips known document pages but captures a new item immediately', async () => {
  let firstRequests = 0;
  const firstBase = router();
  const firstFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    firstRequests += 1;
    return firstBase(input, init);
  }) as typeof fetch;

  const first = await new SpedConnector({
    fetch: firstFetch,
    now: () => new Date('2026-09-21T00:00:00Z'),
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  const state = first.metadata?.spedState as {
    items: Record<string, any>;
    pages: Record<string, any>;
  };

  let replayRequests = 0;
  const replayBase = router();
  const replayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    replayRequests += 1;
    return replayBase(input, init);
  }) as typeof fetch;

  const replay = await new SpedConnector({
    fetch: replayFetch,
    now: () => new Date('2026-09-21T01:00:00Z'),
    readState: async () => state,
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  assert.equal(replay.publications.length, 0);
  assert.equal((replay.metadata?.sped as { downloadedCount: number }).downloadedCount, 0);
  assert.ok(replayRequests < firstRequests);
  assert.ok((replay.metadata?.sped as { skippedKnownDocumentCount: number }).skippedKnownDocumentCount > 0);

  const newResult = await new SpedConnector({
    fetch: router({ includeNewGuide: true }),
    now: () => new Date('2026-09-21T02:00:00Z'),
    readState: async () => state,
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  assert.ok(newResult.publications.some((publication) => publication.title.includes('3.2.3')));
  assert.equal((newResult.metadata?.sped as { newFileDownloadCount: number }).newFileDownloadCount, 1);
});

test('known document rechecks are globally bounded', async () => {
  const first = await new SpedConnector({
    fetch: router(),
    now: () => new Date('2026-09-20T00:00:00Z'),
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  const state = first.metadata?.spedState as {
    items: Record<string, any>;
    pages: Record<string, any>;
  };

  const result = await new SpedConnector({
    fetch: router(),
    now: () => new Date('2026-09-22T00:00:00Z'),
    readState: async () => state,
    revisitAfterMs: 0,
    maxRechecksPerRun: 1,
    maxCrawlDepth: 5,
  }).collect(CONTEXT);

  assert.equal(
    (result.metadata?.sped as { recheckedKnownDocumentCount: number }).recheckedKnownDocumentCount,
    1,
  );
});

test('partial module failure does not turn the whole SPED source into no-results', async () => {
  const result = await new SpedConnector({ fetch: router({ failDere: true }), maxCrawlDepth: 2 }).collect(CONTEXT);
  assert.ok(result.publications.length > 0);
  assert.ok((result.partialFailures?.length ?? 0) > 0);
  assert.ok((result.metadata?.sped as { modulesSucceeded: number }).modulesSucceeded >= 3);
});

test('total source unavailability is retryable', async () => {
  const unavailable = (async () => new Response('down', { status: 503, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await assert.rejects(
    new SpedConnector({ fetch: unavailable }).collect(CONTEXT),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SPED_ALL_MODULES_FAILED');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});
