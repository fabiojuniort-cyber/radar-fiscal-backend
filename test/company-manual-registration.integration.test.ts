import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { ensureCnaeFixture } from './onboarding-cnae-fixture.js';

const PASSWORD = 'Manual-Seguro-2026!';

function cnpjFromSeed(seed: string, suffix = '0001'): string {
  const digits = seed
    .replace(/\D/g, '')
    .padEnd(8, '7')
    .slice(0, 8) + suffix;

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
    'manual-' + suffix + '@example.test';

  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Manual Owner',
      email,
      company: 'Manual Company ' + suffix,
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

  return {
    tenantId: registered.tenant.id,
    userId: registered.user.id,
    accessToken:
      login.json<{ accessToken: string }>()
        .accessToken,
  };
}

test(
  'manual company fallback creates and reactivates the matrix without external registry dependency',
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

    try {
      await app.ready();
      await ensureCnaeFixture(admin);

      const owner = await registerAndLogin(
        app,
        randomUUID(),
      );
      users.push(owner.userId);
      tenants.push(owner.tenantId);

      const headers = {
        authorization:
          'Bearer ' + owner.accessToken,
        'x-tenant-id': owner.tenantId,
      };
      const cnpj = cnpjFromSeed(
        randomUUID(),
      );

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/companies/manual',
        headers,
        payload: {
          cnpj,
          legalName:
            'Empresa Manual de Teste Ltda.',
          uf: 'GO',
          municipalityName: 'Goiânia',
          municipalityIbgeCode: '5208707',
          postalCode: '74000000',
          street: 'Rua Manual',
          streetNumber: '100',
          district: 'Centro',
          stateRegistration: '110042490114',
          businessLocationCode:
            'MATRIZ-MANUAL',
          cnaes: [
            {
              code: '6201501',
              description:
                'Desenvolvimento de programas de computador sob encomenda',
              isPrimary: true,
            },
          ],
        },
      });

      assert.equal(created.statusCode, 201);

      const body = created.json<{
        company: {
          id: string;
          legalName: string;
          cnpj: string;
          businessLocationCode:
            string | null;
        };
        establishment: {
          id: string;
          stateRegistration:
            string | null;
          stateRegistrationSource:
            string | null;
          stateRegistrationLookupStatus:
            string | null;
          businessLocationCode:
            string | null;
          cnaes: Array<{
            code: string;
            isPrimary: boolean;
          }>;
        };
        registry: {
          source: string;
        };
      }>();

      assert.equal(body.company.cnpj, cnpj);
      assert.equal(
        body.company.businessLocationCode,
        'MATRIZ-MANUAL',
      );
      assert.equal(
        body.establishment
          .businessLocationCode,
        'MATRIZ-MANUAL',
      );
      assert.equal(
        body.establishment
          .stateRegistration,
        '110042490114',
      );
      assert.equal(
        body.establishment
          .stateRegistrationSource,
        'MANUAL',
      );
      assert.equal(
        body.establishment
          .stateRegistrationLookupStatus,
        null,
      );
      assert.equal(
        body.establishment.cnaes[0]
          ?.isPrimary,
        true,
      );
      assert.equal(
        body.registry.source,
        'MANUAL',
      );

      const persisted = await app.inject({
        method: 'GET',
        url:
          '/api/v1/companies/' +
          body.company.id +
          '/establishments',
        headers,
      });

      assert.equal(
        persisted.statusCode,
        200,
      );

      const persistedHeadOffice =
        persisted.json<{
          items: Array<{
            id: string;
            stateRegistration:
              string | null;
            stateRegistrationSource:
              string | null;
            stateRegistrationLookupStatus:
              string | null;
            businessLocationCode:
              string | null;
            cnaes: unknown[];
          }>;
        }>().items[0];

      assert.equal(
        persistedHeadOffice?.id,
        body.establishment.id,
      );
      assert.equal(
        persistedHeadOffice
          ?.businessLocationCode,
        'MATRIZ-MANUAL',
      );
      assert.equal(
        persistedHeadOffice
          ?.stateRegistrationSource,
        'MANUAL',
      );
      assert.equal(
        persistedHeadOffice
          ?.stateRegistrationLookupStatus,
        null,
      );
      assert.equal(
        persistedHeadOffice?.cnaes.length,
        1,
      );

      const deleted = await app.inject({
        method: 'DELETE',
        url:
          '/api/v1/companies/' +
          body.company.id,
        headers,
      });

      assert.equal(deleted.statusCode, 204);

      const recreated = await app.inject({
        method: 'POST',
        url: '/api/v1/companies/manual',
        headers,
        payload: {
          cnpj,
          legalName:
            'Empresa Manual Reativada Ltda.',
          reactivateInactive: true,
          uf: 'GO',
          municipalityName: 'Goiânia',
        },
      });

      assert.equal(
        recreated.statusCode,
        201,
      );

      const recreatedBody =
        recreated.json<{
          company: { id: string };
          establishment: {
            id: string;
          };
        }>();

      assert.equal(
        recreatedBody.company.id,
        body.company.id,
      );
      assert.equal(
        recreatedBody.establishment.id,
        body.establishment.id,
      );

      const afterReactivation =
        await app.inject({
          method: 'GET',
          url:
            '/api/v1/companies/' +
            body.company.id +
            '/establishments',
          headers,
        });

      const reactivatedHeadOffice =
        afterReactivation.json<{
          items: Array<{
            businessLocationCode:
              string | null;
            stateRegistration:
              string | null;
            stateRegistrationSource:
              string | null;
          }>;
        }>().items[0];

      assert.equal(
        reactivatedHeadOffice
          ?.businessLocationCode,
        'MATRIZ-MANUAL',
      );
      assert.equal(
        reactivatedHeadOffice
          ?.stateRegistration,
        '110042490114',
      );
      assert.equal(
        reactivatedHeadOffice
          ?.stateRegistrationSource,
        'MANUAL',
      );
    } finally {
      await app.close();

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
