import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeNewsItem } from '../src/modules/collection/news.normalizer.js';

const sourceId = '11111111-1111-4111-8111-111111111111';

test('news normalizer produces stable identity and strips tracking parameters', () => {
  const first = normalizeNewsItem({
    sourceId,
    item: {
      title: '  Receita   divulga novidades da CBS  ',
      summary: '  Resumo   oficial. ',
      officialUrl: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/noticia/?utm_source=x&fbclid=abc#conteudo',
      externalId: 'noticia-123',
      publishedAt: new Date('2026-10-01T12:00:00Z'),
      tags: ['RTC', ' CBS ', 'RTC'],
    },
  });

  const replay = normalizeNewsItem({
    sourceId,
    item: {
      title: 'Receita divulga novidades da CBS',
      summary: 'Resumo oficial.',
      officialUrl: 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/noticia',
      externalId: 'noticia-123',
      publishedAt: new Date('2026-10-01T12:00:00Z'),
      tags: ['CBS', 'RTC'],
    },
  });

  assert.equal(first.title, 'Receita divulga novidades da CBS');
  assert.equal(first.officialUrl, 'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/noticia');
  assert.deepEqual(first.tags, ['CBS', 'RTC']);
  assert.equal(first.identityHash, replay.identityHash);
  assert.equal(first.contentHash, replay.contentHash);
  assert.equal(first.sourceItemKey, 'noticia-123');
});

test('news identity is source-scoped and content changes create a new content hash only', () => {
  const base = normalizeNewsItem({
    sourceId,
    item: {
      title: 'Reforma Tributária',
      summary: 'Resumo A',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-a',
    },
  });

  const changed = normalizeNewsItem({
    sourceId,
    item: {
      title: 'Reforma Tributária',
      summary: 'Resumo B',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-a',
    },
  });

  const otherSource = normalizeNewsItem({
    sourceId: '22222222-2222-4222-8222-222222222222',
    item: {
      title: 'Reforma Tributária',
      summary: 'Resumo A',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-a',
    },
  });

  assert.equal(base.identityHash, changed.identityHash);
  assert.notEqual(base.contentHash, changed.contentHash);
  assert.notEqual(base.identityHash, otherSource.identityHash);
});

test('official image is normalized and changes content version without changing identity', () => {
  const withoutImage = normalizeNewsItem({
    sourceId,
    item: {
      title: 'CBS em destaque',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-imagem',
      metadata: { source: 'RFB_NEWS' },
    },
  });
  const withImage = normalizeNewsItem({
    sourceId,
    item: {
      title: 'CBS em destaque',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-imagem',
      metadata: {
        source: 'RFB_NEWS',
        imageUrl: 'https://www.gov.br/receitafederal/imagens/cbs.jpg#preview',
      },
    },
  });
  const changedImage = normalizeNewsItem({
    sourceId,
    item: {
      title: 'CBS em destaque',
      officialUrl: 'https://www.gov.br/receitafederal/noticia-imagem',
      metadata: {
        source: 'RFB_NEWS',
        imageUrl: 'https://www.gov.br/receitafederal/imagens/cbs-v2.jpg',
      },
    },
  });

  assert.equal(withoutImage.identityHash, withImage.identityHash);
  assert.equal(withImage.identityHash, changedImage.identityHash);
  assert.notEqual(withoutImage.contentHash, withImage.contentHash);
  assert.notEqual(withImage.contentHash, changedImage.contentHash);
  assert.equal(withImage.metadata.imageUrl, 'https://www.gov.br/receitafederal/imagens/cbs.jpg');
});

test('news normalizer rejects unsupported URL protocols and invalid dates', () => {
  assert.throws(
    () => normalizeNewsItem({
      sourceId,
      item: {
        title: 'Notícia fiscal',
        officialUrl: 'file:///tmp/noticia',
      },
    }),
    /HTTP or HTTPS/,
  );

  assert.throws(
    () => normalizeNewsItem({
      sourceId,
      item: {
        title: 'Notícia fiscal',
        officialUrl: 'https://www.gov.br/noticia',
        publishedAt: new Date('invalid'),
      },
    }),
    /Invalid news publishedAt/,
  );
});
