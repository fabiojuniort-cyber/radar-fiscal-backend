import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Act-Type-Test-2026!Safe';
// Fixed historical UTC calendar date; independent of CI timezone and midnight.
const FIXTURE_PUBLISHED_ON_UTC = '2025-06-15';

interface ArchiveBody {
  totalItems: number;
  totalIsCapped: boolean;
  items: Array<{
    id: string;
    title: string;
    actType: string | null;
  }>;
}

interface FacetsBody {
  ufs: string[];
  sources: Array<{ code: string; name: string }>;
  actTypes: string[];
}

test('Acervo exposes and filters by the collected legal act type', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const marker = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `act-type-${randomUUID()}@example.test`;

  async function publication(actType: string, title: string): Promise<string> {
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
      [id, hash, actType, title, FIXTURE_PUBLISHED_ON_UTC],
    );
    return id;
  }

  try {
    await app.ready();

    await admin.query(
      `INSERT INTO sources (
         code, name, jurisdiction_level, base_url, connector_key, is_active
       ) VALUES (
         'cat01-dou', 'CAT-01 DOU', 'FEDERAL',
         'https://example.invalid/cat01-dou', 'cat01-dou', false
       )
       ON CONFLICT (code) DO NOTHING`,
    );
    const source = await admin.query<{ id: string }>(
      `SELECT id FROM sources WHERE code = 'cat01-dou'`,
    );
    const sourceId = source.rows[0]?.id;
    assert.ok(sourceId, 'test source must exist');

    const complementaryLaw = await publication(
      'Lei Complementar',
      `Lei Complementar ${marker}`,
    );
    const decree = await publication(
      'Decreto',
      `Decreto ${marker}`,
    );
    await publication(
      'Aviso de Licitação',
      `Aviso de Licitação ${marker}`,
    );

    await admin.query(
      `INSERT INTO publication_origins (
         publication_id, source_id, external_id, official_url
       ) VALUES ($1, $2, $3, $4)`,
      [
        complementaryLaw,
        sourceId,
        `cat01-${marker}`,
        `https://example.invalid/cat01/${complementaryLaw}`,
      ],
    );

    const catalog = await admin.query<{ act_type: string }>(
      `SELECT act_type
       FROM publication_act_type_catalog
       WHERE act_type IN ('Lei Complementar', 'Decreto', 'Aviso de Licitação')
       ORDER BY act_type`,
    );
    assert.deepEqual(
      catalog.rows.map((row) => row.act_type),
      ['Aviso de Licitação', 'Decreto', 'Lei Complementar'],
      'insert trigger must register collected act types without normalizing them',
    );

    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Act Type Reader',
        email,
        company: `Act Type Company ${marker}`,
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

    const emptyType = `Tipo sem documento ${marker}`;
    await admin.query(
      'INSERT INTO publication_act_type_catalog (act_type) VALUES ($1)', [emptyType],
    );
    const facets = await app.inject({
      method: 'GET',
      url: '/api/v2/archive/facets',
      headers,
    });
    assert.equal(facets.statusCode, 200, facets.body);
    const facetBody = facets.json<FacetsBody>();
    assert.ok(!facetBody.actTypes.includes(emptyType));
    assert.ok(facetBody.actTypes.includes('Lei Complementar'));
    assert.ok(facetBody.actTypes.includes('Decreto'));
    assert.ok(!facetBody.actTypes.includes('Aviso de Licitação'));
    assert.equal(
      new Set(facetBody.actTypes).size,
      facetBody.actTypes.length,
      'act type facet must not contain duplicates',
    );

    const publishedOn = FIXTURE_PUBLISHED_ON_UTC;
    const cases: Array<Record<string, string>> = [
      { source: 'cat01-dou' },
      { q: marker },
      { q: marker, source: 'cat01-dou', publishedOn },
      { q: marker, jurisdiction: 'STATE' },
      { q: marker, publishedTo: '2000-01-01' },
      { q: marker, actType: 'Decreto' },
      { q: 'de' },
    ];
    for (const filters of cases) {
      const params = new URLSearchParams(filters);
      const filteredFacets = await app.inject({
        method: 'GET', url: '/api/v2/archive/facets?' + params, headers,
      });
      const filteredSearch = await app.inject({
        method: 'GET', url: '/api/v2/archive?limit=50&' + params, headers,
      });
      assert.equal(filteredFacets.statusCode, 200, filteredFacets.body);
      assert.equal(filteredSearch.statusCode, 200, filteredSearch.body);
      const expected = [...new Set(filteredSearch.json<ArchiveBody>().items
        .map((item) => item.actType).filter((value): value is string => Boolean(value)))].sort();
      assert.deepEqual(filteredFacets.json<FacetsBody>().actTypes, expected);
    }

    const response = await app.inject({
      method: 'GET',
      url:
        '/api/v2/archive?limit=50&actType=' +
        encodeURIComponent('Lei Complementar'),
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<ArchiveBody>();
    assert.equal(body.totalItems, 1);
    assert.equal(body.totalIsCapped, false);
    assert.deepEqual(body.items.map((item) => item.id), [complementaryLaw]);
    assert.equal(body.items[0]?.actType, 'Lei Complementar');
    assert.ok(!body.items.some((item) => item.id === decree));

    const sourceAndType = await app.inject({
      method: 'GET',
      url:
        '/api/v2/archive?limit=50&source=cat01-dou&actType=' +
        encodeURIComponent('Lei Complementar'),
      headers,
    });
    assert.equal(sourceAndType.statusCode, 200, sourceAndType.body);
    assert.deepEqual(
      sourceAndType.json<ArchiveBody>().items.map((item) => item.id),
      [complementaryLaw],
      'source + actType must preserve publication_source_feed semantics',
    );

    const absent = await app.inject({
      method: 'GET',
      url:
        '/api/v2/archive?limit=50&actType=' +
        encodeURIComponent('Lei complementar'),
      headers,
    });
    assert.equal(absent.statusCode, 200, absent.body);
    assert.equal(absent.json<ArchiveBody>().totalItems, 0);
  } finally {
    await app.close();
    await admin.end();
  }
});
