import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { ensureCnaeFixture } from './onboarding-cnae-fixture.js';

const PASSWORD = 'Manual-Filial-2026!';

function cnpjFromSeed(seed: string, suffix = '0001'): string {
  const digits = seed.replace(/\D/g, '').padEnd(8, '6').slice(0, 8) + suffix;

  const calculate = (
    value: string,
    weights: number[],
  ): number => {
    const sum = weights.reduce(
      (total, weight, index) =>
        total + Number(value[index]) * weight,
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
    'manual-branch-' + suffix + '@example.test';

  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Manual Branch Owner',
      email,
      company: 'Manual Branch ' + suffix,
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
  'manual establishment fallback reactivates the same branch and preserves internal data when omitted',
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
      const matrixCnpj = cnpjFromSeed(
        randomUUID(),
      );
      const branchCnpj = cnpjFromSeed(matrixCnpj, '0002');

      const companyCreate = await app.inject({
        method: 'POST',
        url: '/api/v1/companies/manual',
        headers,
        payload: {
          cnpj: matrixCnpj,
          legalName:
            'Empresa Manual com Filial Ltda.',
          uf: 'GO',
          businessLocationCode: 'MATRIZ-001',
          cnaes: [{ code: '6201501', description: 'Desenvolvimento de programas', isPrimary: true }],
        },
      });

      assert.equal(
        companyCreate.statusCode,
        201,
      );

      const company = companyCreate.json<{
        company: { id: string };
      }>().company;

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/establishments/manual',
        headers,
        payload: {
          companyId: company.id,
          cnpj: branchCnpj,
          name: 'Filial Manual Rio Verde',
          typeCode: 'OTHER',
          uf: 'GO',
          municipalityName: 'Rio Verde',
          postalCode: '75900000',
          stateRegistration: '109998887',
          businessLocationCode: 'FILIAL-003',
          cnaes: [
            {
              code: '4632001',
              description:
                'Comércio atacadista de cereais',
              isPrimary: true,
            },
          ],
        },
      });

      assert.equal(created.statusCode, 201);

      const branch = created.json<{
        establishment: {
          id: string;
          businessLocationCode: string | null;
          stateRegistration: string | null;
          stateRegistrationSource: string | null;
        };
      }>().establishment;

      assert.equal(
        branch.businessLocationCode,
        'FILIAL-003',
      );
      assert.equal(
        branch.stateRegistration,
        '109998887',
      );
      assert.equal(
        branch.stateRegistrationSource,
        'MANUAL',
      );

      const deleted = await app.inject({
        method: 'DELETE',
        url:
          '/api/v1/establishments/' +
          branch.id,
        headers,
      });

      assert.equal(deleted.statusCode, 204);

      const reactivated = await app.inject({
        method: 'POST',
        url: '/api/v1/establishments/manual',
        headers,
        payload: {
          companyId: company.id,
          cnpj: branchCnpj,
          name: 'Filial Manual Reativada',
          reactivateInactive: true,
          typeCode: 'OTHER',
          uf: 'GO',
        },
      });

      assert.equal(reactivated.statusCode,410,reactivated.body);
      assert.equal(reactivated.json<{error:string}>().error,'reactivation_removed');
      const inactive=await admin.query<{is_active:boolean;business_location_code:string}>(
        'SELECT is_active,business_location_code FROM establishments WHERE id=$1',[branch.id]);
      assert.equal(inactive.rows[0]?.is_active,false);
      assert.equal(inactive.rows[0]?.business_location_code,'FILIAL-003');

      const headOfficeConflict =
        await app.inject({
          method: 'POST',
          url: '/api/v1/establishments/manual',
          headers,
          payload: {
            companyId: company.id,
            cnpj: matrixCnpj,
            name: 'Não pode virar filial',
            typeCode: 'OTHER',
            uf: 'GO',
          },
        });

      assert.equal(
        headOfficeConflict.statusCode,
        409,
      );
      assert.equal(
        headOfficeConflict.json<{
          error: string;
        }>().error,
        'head_office_conflict',
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
