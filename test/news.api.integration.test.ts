import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'News-Test-2026!Safe';

test('news API requires auth and returns latest official news with search, image and fresh-date fallback', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required for news API integration tests.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const suffix = randomUUID();
  const email = `news-${suffix}@example.test`;
  const sourceId = randomUUID();
  const newsId = randomUUID();
  const undatedNewsId = randomUUID();
  const imageUrl = 'https://www.gov.br/receitafederal/imagens/noticias/ibs-cbs.jpg';

  try {
    await app.ready();

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/v1/news',
    });
    assert.equal(unauthorized.statusCode, 401);

    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'News Reader',
        email,
        company: `News Company ${suffix}`,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(register.statusCode, 201);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const accessToken = login.json<{ accessToken: string }>().accessToken;

    await admin.query(
      `INSERT INTO sources (
         id, code, name, jurisdiction_level, agency, base_url,
         connector_key, content_kind, is_active
       ) VALUES ($1, $2, 'Receita Federal — Notícias', 'FEDERAL', 'RFB',
         'https://www.gov.br/receitafederal/pt-br/assuntos/noticias',
         $3, 'NEWS', TRUE)`,
      [sourceId, `rfb-news-test-${suffix}`, `rfb-news-test-${suffix}`],
    );

    await admin.query(
      `INSERT INTO news_items (
         id, source_id, identity_hash, agency, official_url
       ) VALUES
         ($1, $2, $3, 'Receita Federal', $4),
         ($5, $2, $6, 'Receita Federal', $7)`,
      [
        newsId,
        sourceId,
        'a'.repeat(64),
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/ibs-cbs-test',
        undatedNewsId,
        'c'.repeat(64),
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/simples-test',
      ],
    );

    await admin.query(
      `INSERT INTO news_item_versions (
         news_item_id, version_no, content_hash, title, summary, category,
         published_at, official_url, tags, source_metadata, collected_at
       ) VALUES
         ($1, 1, $2, $3, $4, 'Tributação', $5, $6, $7, $8::jsonb, $9),
         ($10, 1, $11, $12, $13, 'Tributação', NULL, $14, $15, '{}'::jsonb, $16)`,
      [
        newsId,
        'b'.repeat(64),
        'Receita publica orientação sobre IBS e CBS',
        'Documentos fiscais e Reforma Tributária.',
        new Date('2026-09-20T13:00:00Z'),
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/ibs-cbs-test',
        ['IBS', 'CBS', 'RTC'],
        JSON.stringify({ imageUrl }),
        new Date('2026-09-20T13:05:00Z'),
        undatedNewsId,
        'd'.repeat(64),
        'Receita divulga atualização de outubro sobre Simples Nacional',
        'Notícia coletada na virada do mês sem timestamp oficial parseado.',
        'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/outubro/simples-test',
        ['Simples Nacional'],
        new Date('2026-10-02T18:10:00Z'),
      ],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/news?page=1&limit=10',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.statusCode, 200);

    const body = response.json<{
      items: Array<{
        id: string;
        sourceName: string;
        title: string;
        category: string | null;
        publishedAt: string | null;
        officialUrl: string;
        imageUrl: string | null;
        tags: string[];
      }>;
      totalItems: number;
      totalPages: number;
    }>();

    assert.equal(body.totalItems, 2);
    assert.equal(body.totalPages, 1);
    assert.equal(body.items[0]?.id, undatedNewsId);
    assert.equal(body.items[0]?.publishedAt, null);
    assert.equal(body.items[1]?.id, newsId);
    assert.equal(body.items[1]?.sourceName, 'Receita Federal — Notícias');
    assert.equal(body.items[1]?.category, 'Tributação');
    assert.equal(body.items[1]?.imageUrl, imageUrl);
    assert.deepEqual(body.items[1]?.tags, ['IBS', 'CBS', 'RTC']);
    assert.match(body.items[1]?.officialUrl ?? '', /gov\.br\/receitafederal/);

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/news?q=IBS',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json<{ totalItems: number }>().totalItems, 1);

    const noMatch = await app.inject({
      method: 'GET',
      url: '/api/v1/news?q=assunto-inexistente',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(noMatch.statusCode, 200);
    assert.deepEqual(noMatch.json<{ items: unknown[] }>().items, []);
  } finally {
    await admin.query(
      'DELETE FROM news_item_versions WHERE news_item_id = ANY($1::uuid[])',
      [[newsId, undatedNewsId]],
    );
    await admin.query(
      'DELETE FROM news_items WHERE id = ANY($1::uuid[])',
      [[newsId, undatedNewsId]],
    );
    await admin.query('DELETE FROM sources WHERE id = $1', [sourceId]);
    await app.close();
    await admin.end();
  }
});
