import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseRfbNewsArticle,
  parseRfbNewsListing,
} from '../src/modules/collection/rfb-news.parser.js';

test('RFB news listing keeps only article links and deduplicates them', () => {
  const html = `
    <main>
      <a href="/receitafederal/pt-br/assuntos/noticias/ultimas-noticias">Últimas</a>
      <article><h2><a href="/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-ibs">Notícia IBS</a></h2></article>
      <a href="https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-ibs">Notícia IBS duplicada</a>
      <article><a href="/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-nfe">Notícia NF-e</a></article>
      <a href="https://example.com/fora">Fora</a>
    </main>
  `;

  assert.deepEqual(parseRfbNewsListing(html), [
    {
      title: 'Notícia IBS',
      url: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-ibs',
    },
    {
      title: 'Notícia NF-e',
      url: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-nfe',
    },
  ]);
});

test('RFB news article uses official metadata, image and visible main content', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Receita regulamenta IBS e CBS">
      <meta property="og:description" content="Novas regras para documentos fiscais.">
      <meta property="og:image" content="https://www.gov.br/receitafederal/imagens/noticias/ibs-cbs.jpg#preview">
      <meta property="article:published_time" content="2026-09-01T10:18:00-03:00">
      <meta property="article:modified_time" content="2026-09-02T09:25:00-03:00">
      <meta property="article:section" content="Tributação">
      <meta name="keywords" content="RTC, IBS, CBS">
    </head><body>
      <nav>menu que não deve virar conteúdo</nav>
      <main>
        <h1>Receita regulamenta IBS e CBS</h1>
        <p>Texto oficial sobre a Reforma Tributária do Consumo.</p>
        <a href="/pt-br/@@search?Subject%3Alist=documentos+fiscais">Documentos fiscais</a>
      </main>
    </body></html>
  `;

  const article = parseRfbNewsArticle(
    html,
    'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/noticia-ibs',
  );

  assert.equal(article.title, 'Receita regulamenta IBS e CBS');
  assert.equal(article.summary, 'Novas regras para documentos fiscais.');
  assert.equal(article.category, 'Tributação');
  assert.equal(article.publishedAt?.toISOString(), '2026-09-01T13:18:00.000Z');
  assert.equal(article.updatedAt?.toISOString(), '2026-09-02T12:25:00.000Z');
  assert.equal(article.imageUrl, 'https://www.gov.br/receitafederal/imagens/noticias/ibs-cbs.jpg');
  assert.ok(article.content?.includes('Reforma Tributária do Consumo'));
  assert.deepEqual(new Set(article.tags), new Set(['RTC', 'IBS', 'CBS', 'Documentos fiscais']));
});

test('RFB news article resolves a relative social image URL', () => {
  const html = `
    <head><meta name="twitter:image" content="/receitafederal/imagens/noticias/cbs.png"></head>
    <main><h1>Notícia com imagem</h1><p>CBS e Reforma Tributária.</p></main>
  `;
  const article = parseRfbNewsArticle(
    html,
    'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/exemplo',
  );
  assert.equal(article.imageUrl, 'https://www.gov.br/receitafederal/imagens/noticias/cbs.png');
});

test('RFB news article falls back to visible published timestamp', () => {
  const html = `
    <main>
      <h1>Notícia sem metadado de data</h1>
      <p>Publicado em 27/07/2026 11h36</p>
      <p>Conteúdo.</p>
    </main>
  `;
  const article = parseRfbNewsArticle(
    html,
    'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/julho/exemplo',
  );
  assert.equal(article.publishedAt?.toISOString(), '2026-07-27T14:36:00.000Z');
});
