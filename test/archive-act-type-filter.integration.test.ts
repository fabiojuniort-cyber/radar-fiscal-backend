import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Act-Type-Test-2026!Safe';

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
         'FEDERAL', $3, $4, current_date
       )`,
      [id, hash, actType, title],
    );
    return id;
  }

  try {
    await app.ready();

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

    const facets = await app.inject({
      method: 'GET',
      url: '/api/v2/archive/facets',
      headers,
    });
    assert.equal(facets.statusCode, 200, facets.body);
    const facetBody = facets.json<FacetsBody>();
    assert.ok(facetBody.actTypes.includes('Lei Complementar'));
    assert.ok(facetBody.actTypes.includes('Decreto'));
    assert.ok(!facetBody.actTypes.includes('Aviso de Licitação'));
    assert.equal(
      new Set(facetBody.actTypes).size,
      facetBody.actTypes.length,
      'act type facet must not contain duplicates',
    );

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
