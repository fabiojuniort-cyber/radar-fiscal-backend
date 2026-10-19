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
      return { headers: { authorization: 'Bearer ' + token, 'x-tenant-id': identity.tenant.id, 'x-company-delete-intent': 'permanent-v1' } };
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

    const assertReadback = async (response: { establishment: Record<string, unknown> }) => {
      const read = await app.inject({ method: 'GET',
        url: '/api/v1/companies/' + companyId + '/establishments', headers: a.headers });
      assert.equal(read.statusCode, 200, read.body);
      const stored = read.json<{ items: Array<Record<string, unknown>> }>().items
        .find((item) => item.id === response.establishment.id);
      assert.ok(stored);
      for (const [key, value] of Object.entries(response.establishment)) {
        assert.deepEqual(value, stored[key], 'POST/GET mismatch for ' + key);
      }
      const sql = await admin.query('SELECT name, uf, establishment_type_code FROM establishments WHERE id = $1',
        [response.establishment.id]);
      assert.equal(response.establishment.name, sql.rows[0].name);
      assert.equal(response.establishment.uf, sql.rows[0].uf);
      assert.equal(response.establishment.typeCode, sql.rows[0].establishment_type_code);
    };
    await assertReadback(created.json());

    const afterCnae = await admin.query<{ description: string }>(
      "SELECT description FROM cnaes WHERE code = '6201501'"
    );
    assert.equal(afterCnae.rowCount, 1);
    assert.equal(created.json().establishment.cnaes[0].description, afterCnae.rows[0]?.description);
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
    assert.equal(implicit.json<{ error: string }>().error, 'establishment_inactive_requires_deletion');

    const reactivation = await app.inject({
      method: 'POST', url: '/api/v1/establishments/manual', headers: a.headers,
      payload: { companyId, cnpj: branchCnpj, name: 'Não reescrever',
        uf: 'GO', typeCode: 'OTHER', reactivateInactive: true },
    });
    assert.equal(reactivation.statusCode,410,reactivation.body);
    assert.equal(reactivation.json<{error:string}>().error,'reactivation_removed');
    const afterReactivation = await admin.query<{ name: string; is_active: boolean }>(
      'SELECT name, is_active FROM establishments WHERE id = $1', [branchId]
    );
    assert.equal(afterReactivation.rows[0]?.name, 'Filial autorizada');
    assert.equal(afterReactivation.rows[0]?.is_active, false);

    // R3 contract: company purge removes private profile/establishment data.
    const otherTenantCompany = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual',
      headers: b.headers, payload: headPayload,
    });
    assert.equal(otherTenantCompany.statusCode, 201, otherTenantCompany.body);
    const otherTenantCompanyId =
      otherTenantCompany.json<{ company: { id: string } }>().company.id;

    await admin.query(
      "INSERT INTO company_tax_profiles (company_id,version_no,tax_regime,personalization) VALUES ($1,1,'LUCRO_REAL',$2::jsonb)",
      [companyId, JSON.stringify({ keywords: ['only-first-tenant'] })],
    );
    await admin.query(
      "INSERT INTO company_product_profiles (company_id,product_label) VALUES ($1,'Produto do tenant apagado')",
      [companyId],
    );
    await admin.query(
      "INSERT INTO monitoring_profiles (company_id,name) VALUES ($1,'Monitoramento removido')",
      [companyId],
    );

    const crossTenantDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/companies/' + otherTenantCompanyId,
      headers: a.headers,
    });
    assert.equal(crossTenantDelete.statusCode, 404, crossTenantDelete.body);

    const deleteCompany = await app.inject({
      method: 'DELETE', url: '/api/v1/companies/' + companyId, headers: a.headers,
    });
    assert.equal(deleteCompany.statusCode, 204, deleteCompany.body);

    const count = async (query: string, id: string) => {
      const res = await admin.query<{ total: number }>(query, [id]);
      return Number(res.rows[0]?.total ?? -1);
    };
    for (const table of ['companies', 'company_tax_profiles', 'company_cnaes',
      'company_product_profiles', 'monitoring_profiles', 'company_publications',
      'company_cnae_ncms'] as const) {
      const column = table === 'companies' ? 'id' : 'company_id';
      assert.equal(await count(
        'SELECT count(*)::int AS total FROM ' + table + ' WHERE ' + column + ' = $1',
        companyId,
      ), 0, table + ' must be removed');
    }
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM establishments WHERE company_id = $1',
      companyId,
    ), 0, 'all establishments must be removed');
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM establishment_cnaes WHERE establishment_id = $1',
      branchId,
    ), 0);
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM companies WHERE id = $1',
      otherTenantCompanyId,
    ), 1, 'another tenant must remain intact');

    const missingDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/companies/' + companyId, headers: a.headers,
    });
    assert.equal(missingDelete.statusCode, 404, missingDelete.body);

    // Same CNPJ creates a NEW identity/profile rather than resurrecting history.
    const fresh = await app.inject({
      method: 'POST', url: '/api/v1/companies/manual',
      headers: a.headers, payload: {
        ...headPayload,
        legalName: 'Nova Empresa Criada do Zero',
        uf: 'SP', municipalityName: 'Nova unidade',
      },
    });
    assert.equal(fresh.statusCode, 201, fresh.body);
    const freshId = fresh.json<{ company: { id: string; legalName: string } }>().company.id;
    assert.notEqual(freshId, companyId);
    assert.equal(fresh.json().company.legalName, 'Nova Empresa Criada do Zero');
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM company_tax_profiles WHERE company_id = $1',
      freshId,
    ), 0, 'new company profile must start empty');
    assert.equal(await count(
      'SELECT count(*)::int AS total FROM company_product_profiles WHERE company_id = $1',
      freshId,
    ), 0, 'new company products must start empty');

  } finally {
    await app.close();
    if (users.length) await admin.query('DELETE FROM app_users WHERE id = ANY($1::uuid[])', [users]);
    if (tenants.length) {
      await admin.query("DELETE FROM audit_log WHERE action = 'COMPANY_PURGED' AND tenant_id = ANY($1::uuid[])", [tenants]);
      await admin.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]);
    }
    await admin.end();
  }
});
