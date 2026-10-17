import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { ensureCnaeFixture } from './onboarding-cnae-fixture.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const PASSWORD = 'ONB02-R3-Isolated-2026!';

function validCnpj(root: string): string {
  const base = root + '0001';
  const dv = (digits: string, weights: number[]) => {
    const remainder = [...weights].reduce((acc, w, i) => acc + w * Number(digits[i]), 0) % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + first + dv(base + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
}

test('ONB-02 R3: complete company graph, symmetric guards, legacy name, unrelated tenant and global publication', async () => {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'isolated DATABASE_ADMIN_URL is required');
  const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 3 });
  const app = await buildApp();
  const users: string[] = [];
  const tenants: string[] = [];
  let globalPublicationId: string | undefined;
  try {
    await app.ready();
    await ensureCnaeFixture(admin);
    const owner = async () => {
      const email = 'onb02-r3-' + randomUUID() + '@example.test';
      const signup = await app.inject({
        method: 'POST', url: '/auth/register',
        payload: { name: 'Test R3 Owner', email, password: PASSWORD,
          confirmPassword: PASSWORD, acceptedTerms: true },
      });
      assert.equal(signup.statusCode, 201, signup.body);
      const identity = signup.json<{ user: { id: string }; tenant: { id: string } }>();
      users.push(identity.user.id);
      tenants.push(identity.tenant.id);
      const login = await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      });
      assert.equal(login.statusCode, 200, login.body);
      return {
        tenantId: identity.tenant.id,
        headers: { authorization: 'Bearer ' + login.json<{ accessToken: string }>().accessToken,
          'x-tenant-id': identity.tenant.id },
      };
    };
    const a = await owner();
    const b = await owner();
    const base = randomUUID().replace(/\D/g, '').padEnd(16, '7');
    const cnpjA = validCnpj(base.slice(0, 8));
    const cnpjA2 = validCnpj(base.slice(8, 16) === base.slice(0, 8) ? '76543210' : base.slice(8, 16));
    const createCompany = async (
      account: typeof a, cnpj: string, name: string,
    ) => {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/companies/manual', headers: account.headers,
        payload: {
          cnpj, legalName: name, uf: 'GO',
          cnaes: [{ code: '6201501', description: 'descricao do browser', isPrimary: true }],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ company: { id: string }; establishment: { id: string } }>();
    };
    const target = await createCompany(a, cnpjA, 'Empresa Legada Excluir');
    const sibling = await createCompany(a, cnpjA2, 'Empresa do Mesmo Tenant');
    const remote = await createCompany(b, cnpjA, 'Empresa do Outro Tenant');

    // Immutable shared catalogue fixture, never a company-owned row.
    await admin.query(`
      INSERT INTO official_catalogs(code,name,maintainer)
      VALUES ('NCM','NCM','Receita Federal')
      ON CONFLICT(code) DO NOTHING;
      INSERT INTO official_catalog_editions(catalog_id,edition_code,source_url,status)
      SELECT c.id,'onb02-ci-only','https://www.gov.br/receitafederal/', 'CURRENT'
      FROM official_catalogs c WHERE c.code='NCM'
        AND NOT EXISTS (
          SELECT 1 FROM official_catalog_editions e
          WHERE e.catalog_id=c.id AND e.status='CURRENT'
        ) ON CONFLICT(catalog_id,edition_code) DO NOTHING;
      INSERT INTO official_catalog_entries(catalog_edition_id,official_code,description,metadata)
      SELECT e.id,'1234.56.78','NCM sintetica ONB02','{"assignable":true}'::jsonb
      FROM official_catalog_editions e
      JOIN official_catalogs c ON c.id=e.catalog_id
      WHERE c.code='NCM' AND e.status='CURRENT'
      ON CONFLICT(catalog_edition_id,official_code) DO NOTHING;
    `);
    const entry = (await admin.query<{ id: string }>(`
      SELECT oce.id FROM official_catalog_entries oce
      JOIN official_catalog_editions e ON e.id=oce.catalog_edition_id
      JOIN official_catalogs c ON c.id=e.catalog_id
      WHERE c.code='NCM' AND e.status='CURRENT'
        AND oce.official_code='1234.56.78' LIMIT 1
    `)).rows[0];
    assert.ok(entry, 'NCM fixture must exist before the purge');

    const pub = (await admin.query<{ id: string }>(`
      INSERT INTO publications(identity_hash,identity_strength,identity_basis,
         jurisdiction_level,title,act_type,act_number,primary_official_url)
      VALUES ($1,'STRONG','{}'::jsonb,'FEDERAL','Norma de teste R3','LEI','123',
              'https://example.test/ato')
      RETURNING id
    `, [sha(randomUUID())])).rows[0]!;
    globalPublicationId = pub.id;
    await admin.query(`
      INSERT INTO publication_versions(publication_id,version_no,content_hash,content_text)
      VALUES ($1,1,$2,'Texto global da norma, pertence ao acervo compartilhado')
    `, [pub.id, sha(randomUUID())]);

    const seed = async (companyId: string, label: string) => {
      const mp = (await admin.query<{ id: string }>(`
        INSERT INTO monitoring_profiles(company_id,name,criteria,is_active)
        VALUES($1,$2,'{"taxes":["ICMS"]}'::jsonb,true) RETURNING id
      `, [companyId,label])).rows[0]!;
      const cp = (await admin.query<{ id: string }>(`
        INSERT INTO company_publications(company_id,publication_id)
        VALUES($1,$2) RETURNING id
      `, [companyId,pub.id])).rows[0]!;
      const pm = (await admin.query<{ id: string }>(`
        INSERT INTO publication_matches(company_publication_id,monitoring_profile_id,
           profile_version,rule_engine_version,matched_fields)
        VALUES($1,$2,1,'TEST-R3','{"matched":true}'::jsonb)
        RETURNING id
      `, [cp.id,mp.id])).rows[0]!;
      return {mp:mp.id,cp:cp.id,pm:pm.id};
    };
    const refsA = await seed(target.company.id,'Monitoramento alvo');
    const refsA2 = await seed(sibling.company.id,'Monitoramento mesmo tenant');
    const refsB = await seed(remote.company.id,'Monitoramento outro tenant');

    await admin.query(`
      INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,
        personalization,is_current)
      VALUES($1,1,'LUCRO_REAL','{"products":["soja"]}'::jsonb,false),
            ($1,2,'LUCRO_REAL','{"products":["fertilizantes"]}'::jsonb,true)
    `,[target.company.id]);
    const product = (await admin.query<{ id: string }>(`
      INSERT INTO company_product_profiles(company_id,product_label)
      VALUES($1,'Adubo teste') RETURNING id
    `,[target.company.id])).rows[0]!;
    await admin.query(`
      INSERT INTO company_product_ncms(company_product_profile_id,official_catalog_entry_id)
      VALUES($1,$2)
    `,[product.id,entry.id]);
    await admin.query(`
      INSERT INTO company_cnae_ncms(company_id,cnae_code,official_catalog_entry_id)
      VALUES($1,'6201501',$2)
    `,[target.company.id,entry.id]);
    await admin.query(`
      INSERT INTO monitoring_profiles(company_id,name,is_active)
      VALUES($1,'Monitoramento inativo',false)
    `,[target.company.id]);

    // Populate OTHER tenants' relationships too: an empty table is not an
    // evidence of preservation after deletion.
    await admin.query(`
      INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,is_current)
      VALUES($1,1,'LUCRO_REAL',true),($2,1,'LUCRO_REAL',true)
    `,[sibling.company.id,remote.company.id]);
    const preservedProducts = (await admin.query<{ id: string; company_id: string }>(`
      INSERT INTO company_product_profiles(company_id,product_label)
      VALUES($1,'Semente de teste'),($2,'Defensivo de teste')
      RETURNING id,company_id
    `,[sibling.company.id,remote.company.id])).rows;
    for (const productOfOther of preservedProducts) {
      await admin.query(`
        INSERT INTO company_product_ncms(company_product_profile_id,official_catalog_entry_id)
        VALUES($1,$2)
      `,[productOfOther.id,entry.id]);
      await admin.query(`
        INSERT INTO company_cnae_ncms(company_id,cnae_code,official_catalog_entry_id)
        VALUES($1,'6201501',$2)
      `,[productOfOther.company_id,entry.id]);
    }

    const rowsSnapshot = async (query: string, ids: string[]) => {
      const result = await admin.query<{snapshot:string}>(`
        SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text),'[]'::jsonb)::text
          AS snapshot FROM (${query}) q
      `,[ids]);
      return result.rows[0]!.snapshot;
    };
    const otherCompanyIds = [sibling.company.id,remote.company.id];
    const snapshotOtherGraph = async () => Promise.all([
      'SELECT t.* FROM companies t WHERE t.id=ANY($1::uuid[])',
      'SELECT t.* FROM establishments t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_cnaes t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT ec.* FROM establishment_cnaes ec JOIN establishments e ON e.id=ec.establishment_id WHERE e.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_tax_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_product_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT n.* FROM company_product_ncms n JOIN company_product_profiles p ON p.id=n.company_product_profile_id WHERE p.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_cnae_ncms t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM monitoring_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_publications t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT pm.* FROM publication_matches pm JOIN company_publications cp ON cp.id=pm.company_publication_id WHERE cp.company_id=ANY($1::uuid[])',
    ].map(query=>rowsSnapshot(query,otherCompanyIds)));
    const otherGraphBefore = await snapshotOtherGraph();
    assert.ok(otherGraphBefore.every(rows=>rows!=='[]'),
      'unrelated companies must have nonempty rows in EVERY relation');

    const snapshotTargetAndAccount = async () => Promise.all([
      'SELECT t.* FROM companies t WHERE t.id=ANY($1::uuid[])',
      'SELECT t.* FROM establishments t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_cnaes t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT ec.* FROM establishment_cnaes ec JOIN establishments e ON e.id=ec.establishment_id WHERE e.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_tax_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_product_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT n.* FROM company_product_ncms n JOIN company_product_profiles p ON p.id=n.company_product_profile_id WHERE p.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_cnae_ncms t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM monitoring_profiles t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM company_publications t WHERE t.company_id=ANY($1::uuid[])',
      'SELECT pm.* FROM publication_matches pm JOIN company_publications cp ON cp.id=pm.company_publication_id WHERE cp.company_id=ANY($1::uuid[])',
      'SELECT t.* FROM tenants t JOIN companies c ON c.tenant_id=t.id WHERE c.id=ANY($1::uuid[])',
      'SELECT t.* FROM tenant_onboarding_profiles t JOIN companies c ON c.tenant_id=t.tenant_id WHERE c.id=ANY($1::uuid[])',
      'SELECT t.* FROM audit_log t JOIN companies c ON c.tenant_id=t.tenant_id WHERE c.id=ANY($1::uuid[])',
    ].map(query=>rowsSnapshot(query,[target.company.id])));

    const count = async (table: string, column: string, id: string) => {
      const row = await admin.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM ' + table + ' WHERE ' + column + '=$1',
        [id],
      );
      return Number(row.rows[0]!.total);
    };
    const stableRows = async (table: string, column: string, ids: string[]) => {
      const rows = await admin.query(
        'SELECT to_jsonb(t) AS data FROM ' + table +
          ' t WHERE ' + column + ' = ANY($1::uuid[]) ORDER BY id',
        [ids],
      );
      return rows.rows;
    };
    const globalsBefore = {
      publication: (await admin.query('SELECT * FROM publications WHERE id=$1',[pub.id])).rows,
      versions: (await admin.query('SELECT * FROM publication_versions WHERE publication_id=$1',[pub.id])).rows,
      ncm: (await admin.query('SELECT * FROM official_catalog_entries WHERE id=$1',[entry.id])).rows,
    };
    const siblingsBefore = await stableRows('companies','id',[sibling.company.id,remote.company.id]);
    const otherCpsBefore = await stableRows('company_publications','id',[refsA2.cp,refsB.cp]);
    const otherMpsBefore = await stableRows('monitoring_profiles','id',[refsA2.mp,refsB.mp]);
    const otherMatchesBefore = await stableRows('publication_matches','id',[refsA2.pm,refsB.pm]);

    // B1: both inverse links are blockers even in the same tenant.
    const disallowed = async (cpId: string, mpId: string) => {
      const row = (await admin.query<{ id: string }>(`
        INSERT INTO publication_matches(company_publication_id,monitoring_profile_id,
             profile_version,rule_engine_version)
        VALUES($1,$2,1,'TEST-R3-MISMATCH') RETURNING id
      `,[cpId,mpId])).rows[0]!;
      const blocked = await app.inject({
        method:'DELETE',url:'/api/v1/companies/'+target.company.id,headers:a.headers,
      });
      assert.equal(blocked.statusCode,409,'inconsistent match must block purge');
      assert.equal(await count('companies','id',target.company.id),1);
      await admin.query('DELETE FROM publication_matches WHERE id=$1',[row.id]);
    };
    await disallowed(refsA.cp, refsA2.mp);
    await disallowed(refsA2.cp, refsA.mp);
    await disallowed(refsA.cp, refsB.mp);
    await disallowed(refsB.cp, refsA.mp);

    // A concurrent writer already inserting the reverse link holds FK KEY
    // SHARE locks. The purge must wait on the profile/publication FOR UPDATE
    // locks, then observe the committed mismatch and refuse the deletion.
    const writer = await admin.connect();
    let insertedWhileOpen: string | undefined;
    try {
      await writer.query('BEGIN');
      const insert = await writer.query<{ id: string }>(`
        INSERT INTO publication_matches(company_publication_id,monitoring_profile_id,
          profile_version,rule_engine_version)
        VALUES($1,$2,1,'ONB02-CONCURRENT') RETURNING id
      `,[refsA.cp,refsB.mp]);
      insertedWhileOpen = insert.rows[0]!.id;
      let done = false;
      const pendingDelete = app.inject({
        method:'DELETE',url:'/api/v1/companies/'+target.company.id,headers:a.headers,
      }).then((response) => { done=true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(done,false,'deletion must wait for in-flight matching FK writer');
      await writer.query('COMMIT');
      const refused = await pendingDelete;
      assert.equal(refused.statusCode,409);
      assert.equal(await count('companies','id',target.company.id),1);
    } finally {
      // A real failed write remains atomic; remove test-only mismatched link.
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      if (insertedWhileOpen) await admin.query(
        'DELETE FROM publication_matches WHERE id=$1',[insertedWhileOpen]);
    }

    // Only a tenant admin may invoke the narrow definer function.
    const unauth = await app.inject({
      method:'DELETE',url:'/api/v1/companies/'+target.company.id,
    });
    assert.equal(unauth.statusCode,401);

    // An authenticated analyst of the same tenant has read permissions but
    // cannot use the owner-only irreversible deletion.
    const bToken = b.headers.authorization;
    await admin.query(`
      INSERT INTO tenant_memberships(tenant_id,user_id,role)
      VALUES($1,$2,'ANALYST')
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role
    `,[a.tenantId,users[1]]);
    const analystDelete = await app.inject({
      method:'DELETE',url:'/api/v1/companies/'+target.company.id,
      headers:{authorization:bToken,'x-tenant-id':a.tenantId},
    });
    assert.equal(analystDelete.statusCode,403,analystDelete.body);
    assert.equal(await count('companies','id',target.company.id),1);

    // A direct SQL call without authenticated tenant context must fail.
    const withoutContext = await admin.connect();
    try {
      await withoutContext.query('BEGIN');
      await withoutContext.query('SET LOCAL ROLE radar_app_runtime');
      await assert.rejects(
        () => withoutContext.query('SELECT public.app_purge_company($1::uuid)',[target.company.id]),
        /admin_required|permission denied/i,
      );
    } finally {
      await withoutContext.query('ROLLBACK').catch(() => undefined);
      withoutContext.release();
    }
    const permissions = (await admin.query<{
      worker_execute:boolean; app_delete:boolean;
    }>(`
      SELECT has_function_privilege('radar_worker_runtime',
             'public.app_purge_company(uuid)','EXECUTE') AS worker_execute,
             has_table_privilege('radar_app_runtime','public.companies','DELETE')
             AS app_delete
    `)).rows[0]!;
    assert.equal(permissions.worker_execute,false);
    assert.equal(permissions.app_delete,false);

    // B2: an unlinked legacy name is ambiguous and must fail closed.
    await admin.query('UPDATE tenant_onboarding_profiles SET cnpj=NULL,company_name=$2 WHERE tenant_id=$1',
      [a.tenantId,'Empresa Legada Excluir']);
    const ambiguous = await app.inject({
      method:'DELETE',url:'/api/v1/companies/'+target.company.id,headers:a.headers,
    });
    assert.equal(ambiguous.statusCode,409);
    assert.equal(await count('companies','id',target.company.id),1);
    // The CNPJ is the explicit legacy link, unlike a customized account name.
    await admin.query('UPDATE tenant_onboarding_profiles SET cnpj=$2 WHERE tenant_id=$1',
      [a.tenantId,cnpjA]);
    await admin.query('UPDATE tenants SET name=$2 WHERE id=$1',
      [a.tenantId,'Empresa Legada Excluir']);

    // Before purge the graph MUST be populated: zero-count assertions are not proof.
    const populated = [
      ['company_tax_profiles','company_id',target.company.id],
      ['company_product_profiles','company_id',target.company.id],
      ['company_product_ncms','company_product_profile_id',product.id],
      ['company_cnae_ncms','company_id',target.company.id],
      ['monitoring_profiles','company_id',target.company.id],
      ['company_publications','company_id',target.company.id],
      ['publication_matches','company_publication_id',refsA.cp],
      ['establishments','company_id',target.company.id],
      ['establishment_cnaes','establishment_id',target.establishment.id],
    ] as const;
    for (const [table,column,id] of populated) assert.ok(
      await count(table,column,id) > 0, table+' must have seeded children');

    const crossTenant = await app.inject({
      method:'DELETE',url:'/api/v1/companies/'+remote.company.id,headers:a.headers,
    });
    assert.equal(crossTenant.statusCode,404,crossTenant.body);
    // Inject a failure AFTER all DELETE statements. PostgreSQL sequences
    // are intentionally nontransactional; nextval proves the audit trigger
    // ran, even though the main transaction must roll back completely.
    const beforeRollback = await snapshotTargetAndAccount();
    await admin.query('CREATE SEQUENCE public.onb02_ci_audit_marker START 1');
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.onb02_ci_force_audit_failure()
      RETURNS trigger LANGUAGE plpgsql AS $onb02_ci$
      BEGIN
        IF NEW.action='COMPANY_PURGED' THEN
          PERFORM nextval('public.onb02_ci_audit_marker');
          RAISE EXCEPTION 'onb02_ci_forced_rollback';
        END IF;
        RETURN NEW;
      END $onb02_ci$;
      CREATE TRIGGER onb02_ci_force_audit_failure_trigger
      BEFORE INSERT ON public.audit_log
      FOR EACH ROW EXECUTE FUNCTION public.onb02_ci_force_audit_failure();
    `);
    try {
      const failedInAudit = await app.inject({
        method:'DELETE',url:'/api/v1/companies/'+target.company.id,headers:a.headers,
      });
      assert.equal(failedInAudit.statusCode,500,'must have reached injected audit failure');
      const marker=(await admin.query<{last_value:string}>(
        'SELECT last_value::text FROM public.onb02_ci_audit_marker')).rows[0]!;
      assert.equal(marker.last_value,'1','audit failure MUST run after deletion');
      assert.deepEqual(await snapshotTargetAndAccount(),beforeRollback,
        'all private and audit rows must roll back byte-for-byte');
      assert.deepEqual(await snapshotOtherGraph(),otherGraphBefore,
        'unrelated tenants must be unchanged after abort');
      assert.equal(await count('companies','id',target.company.id),1);
      for (const [table,column,id] of populated) assert.ok(
        await count(table,column,id)>0,'rollback must restore '+table);
      const stillLegacy = (await admin.query(`
        SELECT p.cnpj,p.company_name,t.name FROM tenant_onboarding_profiles p
          JOIN tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1
      `,[a.tenantId])).rows[0];
      assert.equal(stillLegacy.cnpj,cnpjA);
      assert.equal(stillLegacy.company_name,'Empresa Legada Excluir');
      assert.equal(stillLegacy.name,'Empresa Legada Excluir');
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS onb02_ci_force_audit_failure_trigger ON public.audit_log');
      await admin.query('DROP FUNCTION IF EXISTS public.onb02_ci_force_audit_failure()');
      await admin.query('DROP SEQUENCE IF EXISTS public.onb02_ci_audit_marker');
    }

    // Two concurrent irreversible requests: exactly one may succeed,
    // the second must observe that the company is already gone.
    const deletedResponses = await Promise.all([1,2].map(() => app.inject({
      method:'DELETE',url:'/api/v1/companies/'+target.company.id,headers:a.headers,
    })));
    assert.deepEqual(deletedResponses.map(x=>x.statusCode).sort((x,y)=>x-y),
      [204,404],'concurrent DELETE must have exactly one successful purge');
    assert.equal(await count('companies','id',target.company.id),0);
    for (const [table,column,id] of populated) assert.equal(
      await count(table,column,id),0,table+' retains former company data');
    assert.equal(await count('company_cnaes','company_id',target.company.id),0);
    assert.deepEqual(await stableRows('companies','id',[sibling.company.id,remote.company.id]),siblingsBefore);
    assert.deepEqual(await stableRows('company_publications','id',[refsA2.cp,refsB.cp]),otherCpsBefore);
    assert.deepEqual(await stableRows('monitoring_profiles','id',[refsA2.mp,refsB.mp]),otherMpsBefore);
    assert.deepEqual(await stableRows('publication_matches','id',[refsA2.pm,refsB.pm]),otherMatchesBefore);
    assert.deepEqual((await admin.query('SELECT * FROM publications WHERE id=$1',[pub.id])).rows,globalsBefore.publication);
    assert.deepEqual((await admin.query('SELECT * FROM publication_versions WHERE publication_id=$1',[pub.id])).rows,globalsBefore.versions);
    assert.deepEqual((await admin.query('SELECT * FROM official_catalog_entries WHERE id=$1',[entry.id])).rows,globalsBefore.ncm);
    const legacy=(await admin.query(`
      SELECT p.company_name,p.cnpj,t.name AS account_name,
             p.terms_accepted_at,p.privacy_policy_accepted_at
      FROM tenant_onboarding_profiles p JOIN tenants t ON t.id=p.tenant_id
      WHERE p.tenant_id=$1
    `,[a.tenantId])).rows[0];
    assert.equal(legacy.company_name,null);
    assert.equal(legacy.cnpj,null);
    assert.equal(legacy.account_name,'Conta TriFaros');
    assert.ok(legacy.terms_accepted_at);
    assert.ok(legacy.privacy_policy_accepted_at);
    assert.deepEqual(await snapshotOtherGraph(),otherGraphBefore,
      'every populated other-company relationship remains exactly identical');
    const purgeAudits=(await admin.query<{
      actor_type:string;actor_id:string;entity_id:string|null;after_data:any;
      before_data:any;
    }>(`
      SELECT actor_type,actor_id,entity_id,after_data,before_data
      FROM audit_log WHERE tenant_id=$1 AND action='COMPANY_PURGED'
    `,[a.tenantId])).rows;
    assert.equal(purgeAudits.length,1,'two DELETEs must create exactly one audit');
    assert.equal(purgeAudits[0]!.actor_type,'USER');
    assert.equal(purgeAudits[0]!.actor_id,users[0]);
    assert.equal(purgeAudits[0]!.entity_id,null);
    assert.equal(purgeAudits[0]!.before_data,null);
    assert.deepEqual(purgeAudits[0]!.after_data,{purged:true});

    const recreate = await createCompany(a,cnpjA,'Novo perfil do zero');
    assert.notEqual(recreate.company.id,target.company.id);
    assert.notEqual(recreate.establishment.id,target.establishment.id);
    assert.equal(await count('company_tax_profiles','company_id',recreate.company.id),0);
    assert.equal(await count('company_product_profiles','company_id',recreate.company.id),0);
    assert.equal(await count('company_publications','company_id',recreate.company.id),0);
  } finally {
    await app.close();
    try {
      if (tenants.length) {
        // Only disposable CI tenant fixtures. A failed assertion must not
        // trigger a SECOND error via monitoring_profiles' NO ACTION FK.
        await admin.query(`
          DELETE FROM publication_matches pm WHERE
            pm.company_publication_id IN (
              SELECT cp.id FROM company_publications cp
              JOIN companies c ON c.id = cp.company_id
              WHERE c.tenant_id = ANY($1::uuid[])
            ) OR pm.monitoring_profile_id IN (
              SELECT mp.id FROM monitoring_profiles mp
              JOIN companies c ON c.id = mp.company_id
              WHERE c.tenant_id = ANY($1::uuid[])
            )
        `,[tenants]);
        await admin.query(
          "DELETE FROM audit_log WHERE action='COMPANY_PURGED' AND tenant_id=ANY($1::uuid[])",
          [tenants],
        );
      }
      if (users.length) await admin.query(
        'DELETE FROM app_users WHERE id=ANY($1::uuid[])',[users]);
      if (tenants.length) await admin.query(
        'DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
      if (globalPublicationId) await admin.query(
        'DELETE FROM publications WHERE id=$1',[globalPublicationId]);
    } finally {
      await admin.end();
    }
  }
});
