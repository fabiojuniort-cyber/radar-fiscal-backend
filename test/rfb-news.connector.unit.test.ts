import assert from 'node:assert/strict';
import test from 'node:test';

import { RfbNewsConnector } from '../src/modules/collection/rfb-news.connector.js';

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function context() {
  return {
    sourceId: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    attemptId: '33333333-3333-4333-8333-333333333333',
    signal: new AbortController().signal,
  };
}

test('RFB news connector returns only tax-relevant official news', async () => {
  const relevantUrl = 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/ibs-cbs';
  const unrelatedUrl = 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/contrabando';

  const listing = `
    <main>
      <a href="${relevantUrl}">Receita publica regras para IBS e CBS</a>
      <a href="${unrelatedUrl}">Receita apreende mercadorias</a>
    </main>`;
  const relevant = `
    <head>
      <meta property="og:title" content="Receita publica regras para IBS e CBS">
      <meta property="og:description" content="Regras da Reforma Tributária para documentos fiscais.">
      <meta property="article:published_time" content="2026-09-20T10:00:00-03:00">
      <meta property="article:section" content="Tributação">
    </head>
    <main><h1>Receita publica regras para IBS e CBS</h1><p>Conteúdo tributário.</p></main>`;
  const unrelated = `
    <head>
      <meta property="og:title" content="Receita apreende mercadorias">
      <meta property="og:description" content="Ação ocorreu em porto brasileiro.">
      <meta property="article:section" content="Combate ao Contrabando">
    </head>
    <main><h1>Receita apreende mercadorias</h1><p>Operação aduaneira.</p></main>`;

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('ultimas-noticias')) return htmlResponse(listing);
    if (url === relevantUrl) return htmlResponse(relevant);
    if (url === unrelatedUrl) return htmlResponse(unrelated);
    return htmlResponse('not found', 404);
  };

  const connector = new RfbNewsConnector({ fetch: fetchMock, maxArticlesPerRun: 10 });
  const result = await connector.collect(context());

  assert.deepEqual(result.publications, []);
  assert.equal(result.newsItems?.length, 1);
  assert.equal(result.newsItems?.[0]?.officialUrl, relevantUrl);
  assert.equal(result.newsItems?.[0]?.agency, 'Receita Federal');
  assert.equal(result.metadata?.discoveredCount, 2);
  assert.equal(result.metadata?.includedCount, 1);
  assert.equal(result.metadata?.excludedCount, 1);
  assert.equal(result.partialFailures, undefined);
});

test('RFB news connector isolates an individual article failure', async () => {
  const goodUrl = 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/reforma';
  const badUrl = 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/falha';
  const listing = `
    <main>
      <a href="${goodUrl}">Reforma Tributária</a>
      <a href="${badUrl}">Outra notícia</a>
    </main>`;

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('ultimas-noticias')) return htmlResponse(listing);
    if (url === goodUrl) {
      return htmlResponse(`
        <head><meta property="og:title" content="Reforma Tributária e documentos fiscais"></head>
        <main><h1>Reforma Tributária e documentos fiscais</h1><p>IBS e CBS.</p></main>`);
    }
    if (url === badUrl) return htmlResponse('indisponível', 503);
    return htmlResponse('not found', 404);
  };

  const connector = new RfbNewsConnector({ fetch: fetchMock, maxArticlesPerRun: 10 });
  const result = await connector.collect(context());

  assert.equal(result.newsItems?.length, 1);
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.itemReference, badUrl);
});
