import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = ['Ncm', 'Profile', '2026', '!'].join('-');

function cnpjFromSeed(seed: string): string {
  const digits = seed.replace(/\D/g, '').padEnd(12, '7').slice(0, 12);
  const digit = (value: string, weights: number[]) => {
    const total = weights.reduce(
      (sum, weight, index) => sum + Number(value[index]) * weight,
      0,
    );
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = digit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit(
    digits + String(first),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  return digits + String(first) + String(second);
}

async function registerAndLogin(app: FastifyInstance, suffix: string) {
  const email = `ncm-${suffix}@example.test`;
  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'NCM Owner',
      email,
      company: `NCM Tenant ${suffix}`,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      acceptedTerms: true,
    },
  });
  assert.equal(register.statusCode, 201);
  const registered = register.json<{
    tenant: { id: string };
    user: { id: string };
  }>();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);

  return {
    tenantId: registered.tenant.id,
    userId: registered.user.id,
    accessToken: login.json<{ accessToken: string }>().accessToken,
  };
}

test('product/NCM API uses the current official catalog and preserves tenant isolation', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL is required.');

  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const app = await buildApp();
  const users: string[] = [];
  const tenants: string[] = [];
  let publicationId: string | undefined;

  try {
    await app.ready();
    const first = await registerAndLogin(app, randomUUID());
    const second = await registerAndLogin(app, randomUUID());
    users.push(first.userId, second.userId);
    tenants.push(first.tenantId, second.tenantId);

    const firstHeaders = {
      authorization: `Bearer ${first.accessToken}`,
      'x-tenant-id': first.tenantId,
    };
    const secondHeaders = {
      authorization: `Bearer ${second.accessToken}`,
      'x-tenant-id': second.tenantId,
    };

    const companyResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: firstHeaders,
      payload: {
        legalName: 'Empresa NCM de Teste Ltda',
        cnpj: cnpjFromSeed('123456780001'),
      },
    });
    assert.equal(companyResponse.statusCode, 201);
    const companyId = companyResponse.json<{ company: { id: string } }>().company.id;

    await admin.query(
      `INSERT INTO cnaes (code, description, is_active)
       VALUES ('0111301', 'Cultivo de arroz', TRUE)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
    );
    await admin.query(
      `INSERT INTO company_cnaes (company_id, cnae_code, is_primary)
       VALUES ($1::uuid, '0111301', TRUE)
       ON CONFLICT (company_id, cnae_code)
       DO UPDATE SET is_primary = TRUE`,
      [companyId],
    );

    // The immediately preceding CI gate imports an idempotent CURRENT NCM
    // edition. Reuse that official catalog instead of mutating its lifecycle.
    const entries = await admin.query<{ id: string; official_code: string }>(
      `SELECT e.id, e.official_code
       FROM official_catalog_entries e
       INNER JOIN official_catalog_editions ed
         ON ed.id = e.catalog_edition_id
       INNER JOIN official_catalogs c
         ON c.id = ed.catalog_id
       WHERE c.code = 'NCM'
         AND ed.status = 'CURRENT'
         AND e.official_code = ANY($1::text[])
       ORDER BY e.official_code`,
      [['1006.30.11', '1006.20.99']],
    );
    assert.equal(entries.rows.length, 2);
    const firstEntry = entries.rows.find(
      (row) => row.official_code === '1006.30.11',
    );
    assert.ok(firstEntry);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/ncm?q=1006',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/ncm?q=10063011',
      headers: firstHeaders,
    });
    assert.equal(search.statusCode, 200);
    assert.equal(
      search.json<{ items: Array<{ code: string }> }>().items[0]?.code,
      '10063011',
    );

    // Only the NCMs under a product's codes (Produtos table).
    const byPrefix = await app.inject({
      method: 'GET',
      url: '/api/v1/ncm?prefixes=1006.30,9999&limit=200',
      headers: firstHeaders,
    });
    assert.equal(byPrefix.statusCode, 200, byPrefix.body);
    const prefixed = byPrefix.json<{ items: Array<{ code: string }> }>().items;
    assert.ok(prefixed.some((item) => item.code === '10063011'));
    assert.ok(prefixed.every((item) => item.code.startsWith('100630') || item.code.startsWith('9999')));

    const invalidCnae = await app.inject({
      method: 'POST',
      url: `/api/v1/companies/${companyId}/product-profiles`,
      headers: firstHeaders,
      payload: {
        cnaeCode: '9999999',
        productLabel: 'Produto inválido',
        ncmCodes: ['10063011'],
      },
    });
    assert.equal(invalidCnae.statusCode, 400);
    assert.equal(
      invalidCnae.json<{ error: string }>().error,
      'cnae_not_linked',
    );

    const invalidNcm = await app.inject({
      method: 'POST',
      url: `/api/v1/companies/${companyId}/product-profiles`,
      headers: firstHeaders,
      payload: {
        cnaeCode: '0111301',
        productLabel: 'Arroz',
        ncmCodes: ['99999999'],
      },
    });
    assert.equal(invalidNcm.statusCode, 400);
    assert.equal(
      invalidNcm.json<{ error: string }>().error,
      'invalid_ncm_codes',
    );

    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/companies/${companyId}/product-profiles`,
      headers: firstHeaders,
      payload: {
        cnaeCode: '0111301',
        productLabel: 'Arroz',
        ncmCodes: ['10063011'],
      },
    });
    assert.equal(create.statusCode, 201);
    const profile = create.json<{
      id: string;
      cnaeCode: string;
      productLabel: string;
      ncms: Array<{ code: string }>;
    }>();
    assert.equal(profile.cnaeCode, '0111301');
    assert.equal(profile.productLabel, 'Arroz');
    assert.deepEqual(
      profile.ncms.map((item) => item.code),
      ['10063011'],
    );

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/api/v1/companies/${companyId}/product-profiles`,
      headers: secondHeaders,
    });
    assert.equal(crossTenant.statusCode, 404);

    // NCMs of a CNAE, independent of products.
    const cnaeNcmsUrl = `/api/v1/companies/${companyId}/cnae-ncms`;
    const addCnaeNcm = await app.inject({
      method: 'POST',
      url: cnaeNcmsUrl,
      headers: firstHeaders,
      payload: { cnaeCode: '0111301', ncmCodes: ['1006.30.11', '10063011'] },
    });
    assert.equal(addCnaeNcm.statusCode, 201, addCnaeNcm.body);
    const cnaeNcms = addCnaeNcm.json<{ items: Array<{ id: string; cnaeCode: string; code: string }> }>().items;
    assert.deepEqual(cnaeNcms.map((item) => [item.cnaeCode, item.code]), [['0111301', '10063011']]);
    const again = await app.inject({
      method: 'POST',
      url: cnaeNcmsUrl,
      headers: firstHeaders,
      payload: { cnaeCode: '0111301', ncmCodes: ['10063011'] },
    });
    assert.equal(again.json<{ items: unknown[] }>().items.length, 1, 'adding twice keeps one');
    const invalidCnaeNcm = await app.inject({
      method: 'POST',
      url: cnaeNcmsUrl,
      headers: firstHeaders,
      payload: { cnaeCode: '0111301', ncmCodes: ['99999999'] },
    });
    assert.equal(invalidCnaeNcm.statusCode, 400);
    const otherCnae = await app.inject({
      method: 'POST',
      url: cnaeNcmsUrl,
      headers: firstHeaders,
      payload: { cnaeCode: '4930202', ncmCodes: ['10063011'] },
    });
    assert.equal(otherCnae.statusCode, 400, 'CNAE must belong to the company');
    const crossTenantNcms = await app.inject({ method: 'GET', url: cnaeNcmsUrl, headers: secondHeaders });
    assert.equal(crossTenantNcms.statusCode, 404);
    const crossTenantDelete = await app.inject({
      method: 'DELETE',
      url: `${cnaeNcmsUrl}/${cnaeNcms[0]!.id}`,
      headers: secondHeaders,
    });
    assert.equal(crossTenantDelete.statusCode, 404);
    const removed = await app.inject({
      method: 'DELETE',
      url: `${cnaeNcmsUrl}/${cnaeNcms[0]!.id}`,
      headers: firstHeaders,
    });
    assert.equal(removed.statusCode, 204);
    const afterRemove = await app.inject({ method: 'GET', url: cnaeNcmsUrl, headers: firstHeaders });
    assert.deepEqual(afterRemove.json<{ items: unknown[] }>().items, []);

    const update = await app.inject({
      method: 'PUT',
      url: `/api/v1/companies/${companyId}/product-profiles/${profile.id}`,
      headers: firstHeaders,
      payload: {
        cnaeCode: '0111301',
        productLabel: 'Arroz beneficiado',
        ncmCodes: ['10062099'],
      },
    });
    assert.equal(update.statusCode, 200);
    assert.equal(
      update.json<{ productLabel: string }>().productLabel,
      'Arroz beneficiado',
    );
    assert.deepEqual(
      update
        .json<{ ncms: Array<{ code: string }> }>()
        .ncms.map((item) => item.code),
      ['10062099'],
    );

    const publication = await admin.query<{ id: string }>(
      `INSERT INTO publications (
         identity_hash, identity_strength, identity_basis,
         jurisdiction_level, title, published_on
       ) VALUES (
         $1,
         'STRONG',
         '{}'::jsonb,
         'FEDERAL',
         'Norma com NCM',
         DATE '2026-10-01'
       )
       RETURNING id`,
      [createHash('sha256').update(randomUUID()).digest('hex')],
    );
    publicationId = publication.rows[0]!.id;

    const version = await admin.query<{ id: string }>(
      `INSERT INTO publication_versions (
         publication_id, version_no, content_hash, content_text, is_current
       ) VALUES (
         $1::uuid,
         1,
         $2,
         'Tabela NCM 1006.30.11',
         TRUE
       )
       RETURNING id`,
      [
        publicationId,
        createHash('sha256').update(randomUUID()).digest('hex'),
      ],
    );

    await admin.query(
      `INSERT INTO publication_ncm_mentions (
         publication_version_id, ncm_code, official_catalog_entry_id,
         verification_status, method_type, detector_key, detector_version,
         confidence, excerpt
       ) VALUES (
         $1::uuid,
         '10063011',
         $2::uuid,
         'CATALOG_MATCHED',
         'RULE',
         'ncm-regex',
         '1',
         0.99,
         'NCM 1006.30.11'
       )`,
      [version.rows[0]!.id, firstEntry.id],
    );

    const publicationNcms = await app.inject({
      method: 'GET',
      url: `/api/v1/publications/${publicationId}/ncms`,
      headers: firstHeaders,
    });
    assert.equal(publicationNcms.statusCode, 200);
    const mention = publicationNcms.json<{
      items: Array<{ code: string; description: string | null }>;
    }>().items[0];
    assert.equal(mention?.code, '10063011');
    assert.equal(
      mention?.description,
      'Arroz semibranqueado ou branqueado.',
    );

    // Card NCM of the tax profile: only catalog NCMs; matches the act's NCMs.
    const profileBody = (ncmCodes: string[]) => ({
      expectedVersion: 0,
      taxRegime: 'LUCRO_REAL',
      segments: [],
      activities: [],
      personalization: { ncmCodes, taxonomy: null },
    });
    const invalidProfileNcm = await app.inject({
      method: 'PUT',
      url: `/api/v1/companies/${companyId}/tax-profile`,
      headers: firstHeaders,
      payload: profileBody(['99999999']),
    });
    assert.equal(invalidProfileNcm.statusCode, 400, invalidProfileNcm.body);
    assert.equal(invalidProfileNcm.json<{ error: string }>().error, 'invalid_ncm_codes');
    const savedProfileNcm = await app.inject({
      method: 'PUT',
      url: `/api/v1/companies/${companyId}/tax-profile`,
      headers: firstHeaders,
      payload: profileBody(['1006.30.11']),
    });
    assert.equal(savedProfileNcm.statusCode, 200, savedProfileNcm.body);
    const affinity = await app.inject({
      method: 'GET',
      url: `/api/v1/companies/${companyId}/publications/${publicationId}/affinity`,
      headers: firstHeaders,
    });
    assert.equal(affinity.statusCode, 200, affinity.body);
    const affinityBody = affinity.json<{ status: string; matches: Array<{ code: string; dimensionCode: string }> }>();
    assert.equal(affinityBody.status, 'OK');
    assert.deepEqual(affinityBody.matches.map((m) => [m.dimensionCode, m.code]), [['ncm', '10063011']]);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/companies/${companyId}/product-profiles/${profile.id}`,
      headers: firstHeaders,
    });
    assert.equal(remove.statusCode, 204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/api/v1/companies/${companyId}/product-profiles`,
      headers: firstHeaders,
    });
    assert.equal(afterDelete.statusCode, 200);
    assert.deepEqual(
      afterDelete.json<{ items: unknown[] }>().items,
      [],
    );
  } finally {
    await app.close();

    if (publicationId) {
      await admin.query(
        `DELETE FROM publication_ncm_mentions
         WHERE publication_version_id IN (
           SELECT id
           FROM publication_versions
           WHERE publication_id = $1::uuid
         )`,
        [publicationId],
      );
      await admin.query(
        'DELETE FROM publications WHERE id = $1::uuid',
        [publicationId],
      );
    }

    if (tenants.length > 0) {
      await admin.query(
        'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
        [tenants],
      );
    }
    if (users.length > 0) {
      await admin.query(
        'DELETE FROM app_users WHERE id = ANY($1::uuid[])',
        [users],
      );
    }

    await admin.end();
  }
});
