import assert from 'node:assert/strict';
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';

const PASSWORD = 'Launch-Seguro-2026!';

function cnpjFromSeed(seed: string): string {
  const digits = seed
    .replace(/\D/g, '')
    .padEnd(12, '7')
    .slice(0, 12);

  const calculate = (
    value: string,
    weights: number[],
  ): number => {
    const sum = weights.reduce(
      (total, weight, index) =>
        total +
        Number(value[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2
      ? 0
      : 11 - remainder;
  };

  const first = calculate(
    digits,
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  const second = calculate(
    digits + String(first),
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );

  return digits + String(first) + String(second);
}

async function registerAndLogin(
  app: FastifyInstance,
  suffix: string,
) {
  const email =
    'launch-' + suffix + '@example.test';
  const company =
    'Launch Company ' + suffix;

  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Launch Owner',
      email,
      company,
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
    payload: {
      email,
      password: PASSWORD,
    },
  });

  assert.equal(login.statusCode, 200);

  const body = login.json<{
    accessToken: string;
  }>();

  return {
    email,
    userId: registered.user.id,
    tenantId: registered.tenant.id,
    accessToken: body.accessToken,
  };
}

test(
  'launch product API keeps tenant data isolated and supports account setup',
  async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL;

    assert.ok(
      adminUrl,
      'DATABASE_ADMIN_URL is required for integration tests.',
    );

    const admin = new Pool({
      connectionString: adminUrl,
      max: 1,
    });
    const app = await buildApp();
    const users: string[] = [];
    const tenants: string[] = [];
    const publications: string[] = [];

    try {
      await app.ready();

      const first = await registerAndLogin(
        app,
        randomUUID(),
      );
      const second = await registerAndLogin(
        app,
        randomUUID(),
      );

      users.push(first.userId, second.userId);
      tenants.push(first.tenantId, second.tenantId);

      const firstHeaders = {
        authorization:
          'Bearer ' + first.accessToken,
        'x-tenant-id': first.tenantId,
      };

      const initial = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: firstHeaders,
      });

      assert.equal(initial.statusCode, 200);

      const initialBody = initial.json<{
        tenant: { id: string };
        onboarding: {
          companyName: string;
        } | null;
        companies: unknown[];
      }>();

      assert.equal(
        initialBody.tenant.id,
        first.tenantId,
      );
      assert.ok(initialBody.onboarding);
      assert.deepEqual(
        initialBody.companies,
        [],
      );

      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: {
          authorization:
            'Bearer ' + second.accessToken,
          'x-tenant-id': first.tenantId,
        },
      });

      assert.equal(
        forbidden.statusCode,
        403,
      );

      const companyCnpj = cnpjFromSeed(
        '123450000001',
      );

      const companyResponse =
        await app.inject({
          method: 'POST',
          url: '/api/v1/companies',
          headers: firstHeaders,
          payload: {
            legalName:
              'Empresa Real de Teste Ltda',
            tradeName:
              'Empresa Real',
            cnpj: companyCnpj,
          },
        });

      assert.equal(
        companyResponse.statusCode,
        201,
      );

      const company =
        companyResponse.json<{
          company: {
            id: string;
            cnpj: string;
          };
        }>().company;

      assert.equal(
        company.cnpj,
        companyCnpj,
      );

      const establishmentResponse =
        await app.inject({
          method: 'POST',
          url: '/api/v1/establishments',
          headers: firstHeaders,
          payload: {
            companyId: company.id,
            cnpj: companyCnpj,
            name: 'Matriz Goiânia',
            typeCode: 'HEAD_OFFICE',
            isHeadOffice: true,
            uf: 'GO',
            municipalityName: 'Goiânia',
            postalCode: '74000000',
          },
        });

      assert.equal(
        establishmentResponse.statusCode,
        201,
      );

      const profileResponse =
        await app.inject({
          method: 'PUT',
          url:
            '/api/v1/companies/' +
            company.id +
            '/tax-profile',
          headers: firstHeaders,
          payload: {
            taxRegime: 'LUCRO_REAL',
            segments: ['AGRONEGOCIO'],
            activities: [
              'Comércio de insumos',
            ],
            personalization: {
              taxes: [
                'ICMS',
                'IBS',
                'CBS',
              ],
              products: [
                'Fertilizantes',
              ],
              operations: [
                'Venda interestadual',
              ],
              documents: ['NF-e'],
              obligations: ['EFD'],
              keywords: [
                'crédito presumido',
              ],
            },
          },
        });

      assert.equal(
        profileResponse.statusCode,
        200,
      );

      const establishments =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/companies/' +
            company.id +
            '/establishments',
          headers: firstHeaders,
        });

      assert.equal(
        establishments.statusCode,
        200,
      );
      assert.equal(
        establishments.json<{
          items: unknown[];
        }>().items.length,
        1,
      );

      const profile = await app.inject({
        method: 'GET',
        url:
          '/api/v1/companies/' +
          company.id +
          '/tax-profile',
        headers: firstHeaders,
      });

      assert.equal(profile.statusCode, 200);
      assert.equal(
        profile.json<{
          profile: {
            taxRegime: string;
          } | null;
        }>().profile?.taxRegime,
        'LUCRO_REAL',
      );

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/account',
        headers: firstHeaders,
      });

      assert.equal(after.statusCode, 200);
      assert.equal(
        after.json<{
          companies: Array<{
            id: string;
            establishmentCount: number;
          }>;
        }>().companies[0]
          ?.establishmentCount,
        1,
      );

      const archivePublication =
        await admin.query<{
          id: string;
        }>(
          `
            INSERT INTO publications (
              identity_hash,
              identity_strength,
              identity_basis,
              jurisdiction_level,
              title,
              published_on
            )
            VALUES (
              $1,
              'STRONG',
              '{}'::jsonb,
              'FEDERAL',
              'Ato oficial para busca do Acervo',
              DATE '2026-09-30'
            )
            RETURNING id
          `,
          [
            randomBytes(32).toString(
              'hex',
            ),
          ],
        );

      const archivePublicationId =
        archivePublication.rows[0]?.id;

      assert.ok(archivePublicationId);
      publications.push(
        archivePublicationId,
      );

      await admin.query(
        `
          INSERT INTO publication_versions (
            publication_id,
            version_no,
            content_hash,
            content_text,
            relevant_excerpt,
            is_current
          )
          VALUES (
            $1,
            1,
            $2,
            $3,
            $4,
            true
          )
        `,
        [
          archivePublicationId,
          randomBytes(32).toString(
            'hex',
          ),
          'Norma sobre crédito presumido aplicável a fertilizantes.',
          'Crédito presumido para fertilizantes.',
        ],
      );

      const archiveSearch =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/archive?q=fertilizantes&page=1&limit=1',
          headers: {
            authorization:
              'Bearer ' +
              first.accessToken,
          },
        });

      assert.equal(
        archiveSearch.statusCode,
        200,
      );

      const archiveBody =
        archiveSearch.json<{
          page: number;
          limit: number;
          hasMore: boolean;
          items: Array<{
            id: string;
            title: string;
            excerpt: string | null;
          }>;
        }>();

      assert.equal(
        archiveBody.page,
        1,
      );
      assert.equal(
        archiveBody.limit,
        1,
      );
      assert.equal(
        archiveBody.items[0]?.id,
        archivePublicationId,
      );
      assert.match(
        archiveBody.items[0]?.excerpt ??
          '',
        /fertilizantes/i,
      );

      const crossTenantCompanyRead =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/companies/' +
            company.id +
            '/establishments',
          headers: {
            authorization:
              'Bearer ' +
              second.accessToken,
            'x-tenant-id':
              second.tenantId,
          },
        });

      assert.equal(
        crossTenantCompanyRead.statusCode,
        200,
      );
      assert.deepEqual(
        crossTenantCompanyRead.json(),
        { items: [] },
      );
    } finally {
      await app.close();

      if (publications.length > 0) {
        await admin.query(
          'DELETE FROM publications WHERE id = ANY($1::uuid[])',
          [publications],
        );
      }

      if (users.length > 0) {
        await admin.query(
          'DELETE FROM app_users WHERE id = ANY($1::uuid[])',
          [users],
        );
      }

      if (tenants.length > 0) {
        await admin.query(
          'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
          [tenants],
        );
      }

      await admin.end();
    }
  },
);
