import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Archive-Date-Test-2026!Safe';

interface ArchiveBody {
  totalItems: number;
  totalIsCapped: boolean;
  items: Array<{
    id: string;
    title: string;
    actType: string | null;
    publishedOn: string | null;
  }>;
}

test('Acervo filters published_on by exact date and inclusive range', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const marker = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourceCode = `date-${marker}`;
  const email = `archive-date-${randomUUID()}@example.test`;

  async function publication(
    publishedOn: string,
    actType: string,
    title: string,
  ): Promise<string> {
    const id = randomUUID();
    const hash = createHash('sha256').update(id).digest('hex');
    await admin.query(
      `INSERT INTO publications (
         id, identity_hash, identity_strength, identity_basis,
         jurisdiction_level, act_type, title, published_on
       ) VALUES (
         $1, $2, 'STRONG', '{}'::jsonb,
         'FEDERAL', $3, $4, $5::date
       )`,
      [id, hash, actType, title, publishedOn],
    );
    return id;
  }

  try {
    await app.ready();

    const source = await admin.query<{ id: string }>(
      `INSERT INTO sources (
         code, name, jurisdiction_level, base_url, connector_key
       ) VALUES ($1, $2, 'FEDERAL', $3, $4)
       RETURNING id`,
      [
        sourceCode,
        `DATE-01 ${marker}`,
        `https://date-${marker}.example.test`,
        `date-${marker}`,
      ],
    );
    const sourceId = source.rows[0]?.id;
    assert.ok(sourceId);

    const juneFirst = await publication(
      '2024-06-01',
      'Decreto',
      `Decreto inicial ${marker}`,
    );
    const juneFifteenth = await publication(
      '2024-06-15',
      'Lei Complementar',
      `Lei Complementar ${marker}`,
    );
    const juneThirtieth = await publication(
      '2024-06-30',
      'Decreto',
      `Decreto final ${marker}`,
    );
    const julyFirst = await publication(
      '2024-07-01',
      'Decreto',
      `Decreto fora ${marker}`,
    );
    const hidden = await publication(
      '2024-06-15',
      'Aviso de Licitação',
      `Aviso oculto ${marker}`,
    );

    for (const [index, publicationId] of [
      juneFirst,
      juneFifteenth,
      juneThirtieth,
      julyFirst,
      hidden,
    ].entries()) {
      await admin.query(
        `INSERT INTO publication_origins (
           publication_id, source_id, external_id, official_url
         ) VALUES ($1, $2, $3, $4)`,
        [
          publicationId,
          sourceId,
          `${marker}-${index}`,
          `https://date-${marker}.example.test/${index}`,
        ],
      );
    }

    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Archive Date Reader',
        email,
        company: `Archive Date Company ${marker}`,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(register.statusCode, 201, register.body);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = {
      authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}`,
    };

    const exact = await app.inject({
      method: 'GET',
      url:
        `/api/v2/archive?limit=50&source=${encodeURIComponent(sourceCode)}` +
        '&publishedOn=2024-06-15',
      headers,
    });
    assert.equal(exact.statusCode, 200, exact.body);
    const exactBody = exact.json<ArchiveBody>();
    assert.equal(exactBody.totalItems, 1);
    assert.equal(exactBody.totalIsCapped, false);
    assert.deepEqual(exactBody.items.map((item) => item.id), [juneFifteenth]);
    assert.equal(exactBody.items[0]?.publishedOn, '2024-06-15');
    assert.ok(!exactBody.items.some((item) => item.id === hidden));

    const range = await app.inject({
      method: 'GET',
      url:
        `/api/v2/archive?limit=50&source=${encodeURIComponent(sourceCode)}` +
        '&publishedFrom=2024-06-01&publishedTo=2024-06-30',
      headers,
    });
    assert.equal(range.statusCode, 200, range.body);
    const rangeBody = range.json<ArchiveBody>();
    assert.equal(rangeBody.totalItems, 3);
    assert.deepEqual(
      new Set(rangeBody.items.map((item) => item.id)),
      new Set([juneFirst, juneFifteenth, juneThirtieth]),
    );
    assert.ok(!rangeBody.items.some((item) => item.id === julyFirst));
    assert.ok(!rangeBody.items.some((item) => item.id === hidden));

    // This specifically exercises CAT-01's source + actType path, which uses
    // publication_source_feed through EXISTS rather than joining it as `f`.
    const combined = await app.inject({
      method: 'GET',
      url:
        `/api/v2/archive?limit=50&source=${encodeURIComponent(sourceCode)}` +
        '&publishedFrom=2024-06-01&publishedTo=2024-06-30' +
        '&actType=' + encodeURIComponent('Lei Complementar'),
      headers,
    });
    assert.equal(combined.statusCode, 200, combined.body);
    const combinedBody = combined.json<ArchiveBody>();
    assert.equal(combinedBody.totalItems, 1);
    assert.deepEqual(combinedBody.items.map((item) => item.id), [juneFifteenth]);

    const future = await app.inject({
      method: 'GET',
      url: '/api/v2/archive?publishedOn=2999-01-01',
      headers,
    });
    assert.equal(future.statusCode, 400, future.body);

    const inverted = await app.inject({
      method: 'GET',
      url:
        '/api/v2/archive?publishedFrom=2024-07-01&publishedTo=2024-06-01',
      headers,
    });
    assert.equal(inverted.statusCode, 400, inverted.body);

    const mixed = await app.inject({
      method: 'GET',
      url:
        '/api/v2/archive?publishedOn=2024-06-15&publishedFrom=2024-06-01',
      headers,
    });
    assert.equal(mixed.statusCode, 400, mixed.body);
  } finally {
    await app.close();
    await admin.end();
  }
});
