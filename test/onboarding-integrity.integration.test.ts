import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { ensureCnaeFixture } from './onboarding-cnae-fixture.js';

const PASSWORD = 'Integrity-Secure-2026!';
const primary = [{ code: '6201501', description: 'Texto adulterado enviado pelo browser', isPrimary: true }];

function cnpj(root: string, branch: string): string {
  const base = root + branch;
  const check = (digits: string, weights: number[]) => {
    const mod = [...weights].reduce((sum, factor, idx) => sum + factor * Number(digits[idx]), 0) % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const first = check(base, [5,4,3,2,9,8,7,6,5,4,3,2]);
  return base + first + check(base + first, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
}

test('ONB-01 registration: official CNAE integrity, tenant isolation, root, duplicate and reactivation', async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL required');
  const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
  const app = await buildApp();
  const users: string[] = [];
  const tenants: string[] = [];
  try {
    await app.ready();
    await ensureCnaeFixture(admin);

    const newOwner = async () => {
      const email = `onb01-integrity-${randomUUID()}@example.test`;
      const registered = await app.inject({
        method: 'POST', url: '/auth/register',
        payload: { name: 'Integrity Owner', email, password: PASSWORD,
          confirmPassword: PASSWORD, acceptedTerms: true },
      });
      assert.equal(registered.statusCode, 201, registered.body);
      const identity = registered.json<{ user: { id: string }; tenant: { id: string } }>();
      users.push(identity.user.id);
      tenants.push(identity.tenant.id);
      const logged = await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      });
      assert.equal(logged.statusCode, 200, logged.body);
      const token = logged.json<{ accessToken: string }>().accessToken;
      return { headers: { authorization: 'Bearer ' + token, 'x-tenant-id': identity.tenant.id } };
    };

    const a = await newOwner();
    const b = await newOwner();
    const root = randomUUID().replace(/\D/g, '').padEnd(8, '6').slice(0, 8);
    const otherRoot = root === '12345678' ? '87654321' : '12345678';
    const headCnpj = cnpj(root, '0001');
    const branchCnpj = cnpj(root, '0002');
    const foreignCnpj = cnpj(otherRoot, '0002');
    const headPayload = {
      cnpj: headCnpj, legalName: 'Empresa Integridade Original', uf: 'GO', cnaes: primary,
    };

    const crossTenant = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual',
      headers: { ...b.headers, 'x-tenant-id': a.headers['x-tenant-id'] },
      payload: headPayload,
    });
    assert.equal(crossTenant.statusCode, 403, crossTenant.body);

    const fictitious = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual', headers: a.headers,
      payload: { ...headPayload, cnaes: [{ code: '0000000', description: 'Inventado', isPrimary: true }] },
    });
    assert.equal(fictitious.statusCode, 400, fictitious.body);
    assert.equal(fictitious.json<{ error: string }>().error, 'invalid_cnae');
    const noCnae = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual', headers: a.headers,
      payload: { ...headPayload, cnaes: [] },
    });
    assert.equal(noCnae.statusCode, 400, noCnae.body);

    const originalCnae = await admin.query<{ description: string }>(
      "SELECT description FROM cnaes WHERE code = '6201501'"
    );

    const created = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual',
      headers: a.headers, payload: headPayload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const companyId = created.json<{ company: { id: string } }>().company.id;

    const afterCnae = await admin.query<{ description: string }>(
      "SELECT description FROM cnaes WHERE code = '6201501'"
    );
    assert.equal(afterCnae.rowCount, 1);
    assert.notEqual(afterCnae.rows[0]?.description, primary[0]?.description);
    if (originalCnae.rows[0]) {
      assert.equal(afterCnae.rows[0]?.description, originalCnae.rows[0].description);
    }
    const fakeGlobal = await admin.query(
      "SELECT code FROM cnaes WHERE code = '0000000'"
    );
    assert.equal(fakeGlobal.rowCount, 0);

    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual', headers: a.headers,
      payload: { ...headPayload, legalName: 'NÃO DEVE SOBRESCREVER' },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);

    const persisted = await admin.query<{ legal_name: string }>(
      'SELECT legal_name FROM companies WHERE id = $1', [companyId]
    );
    assert.equal(persisted.rows[0]?.legal_name, headPayload.legalName);

    const crossRoot = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: foreignCnpj, name: 'Filial de outro CNPJ',
        uf: 'GO', typeCode: 'OTHER', cnaes: primary },
    });
    assert.equal(crossRoot.statusCode, 409, crossRoot.body);
    assert.equal(crossRoot.json<{ error: string }>().error, 'establishment_cnpj_root_mismatch');

    const branch = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: branchCnpj, name: 'Filial autorizada',
        uf: 'GO', typeCode: 'OTHER', cnaes: primary },
    });
    assert.equal(branch.statusCode, 201, branch.body);
    const branchId = branch.json<{ establishment: { id: string } }>().establishment.id;

    const repeatBranch = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: branchCnpj, name: 'Nome adulterado',
        uf: 'GO', typeCode: 'OTHER', cnaes: primary },
    });
    assert.equal(repeatBranch.statusCode, 409, repeatBranch.body);

    const branchPersisted = await admin.query<{ name: string }>(
      'SELECT name FROM establishments WHERE id = $1', [branchId]
    );
    assert.equal(branchPersisted.rows[0]?.name, 'Filial autorizada');

    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/establishments/' + branchId, headers: a.headers,
    });
    assert.equal(deleted.statusCode, 204, deleted.body);

    const implicit = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: branchCnpj, name: 'Nunca reativar implicitamente',
        uf: 'GO', typeCode: 'OTHER' },
    });
    assert.equal(implicit.statusCode, 409, implicit.body);
    assert.equal(implicit.json<{ error: string }>().error, 'reactivation_required');

    const reactivation = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: branchCnpj, name: 'Não reescrever',
        uf: 'GO', typeCode: 'OTHER', reactivateInactive: true },
    });
    assert.equal(reactivation.statusCode, 201, reactivation.body);
    assert.equal(reactivation.json<{ establishment: { id: string } }>().establishment.id, branchId);
    const afterReactivation = await admin.query<{ name: string; is_active: boolean }>(
      'SELECT name, is_active FROM establishments WHERE id = $1', [branchId]
    );
    assert.equal(afterReactivation.rows[0]?.name, 'Filial autorizada');
    assert.equal(afterReactivation.rows[0]?.is_active, true);
  } finally {
    await app.close();
    if (users.length) await admin.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [users]);
    if (tenants.length) await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
    await admin.end();
  }
});
