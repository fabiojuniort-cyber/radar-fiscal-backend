import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CompiledQuery, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../src/infrastructure/database/database.types.js';
import { purgeCompany } from '../src/modules/company/company-purge.service.js';

class FixtureRollback extends Error {}
const databaseUrl = process.env.DATABASE_ADMIN_URL;
function isolatedDatabase() {
  assert.ok(databaseUrl);
  const url = new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname));
  assert.ok(['/radar_fiscal_test','/onb02_r6_test'].includes(url.pathname));
  assert.equal(url.search,'','connection override parameters are not allowed');
  assert.equal(process.env.CI, 'true', 'isolated CI only; no production database');
  return new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:databaseUrl,max:2})})});
}
async function fixture(trx:Transaction<DB>, scale:boolean) {
  const q = async <T=Record<string,unknown>>(text:string, params:readonly unknown[]=[]) =>
    (await trx.executeQuery<T>(CompiledQuery.raw(text,params))).rows;
  const tenant=(await q<{id:string}>("INSERT INTO tenants(name,slug) VALUES('R6 synthetic account',$1) RETURNING id",[randomUUID()]))[0]!.id;
  const actor=(await q<{id:string}>("INSERT INTO app_users(email,name) VALUES($1,'Synthetic actor') RETURNING id",[randomUUID()+'@example.test']))[0]!.id;
  await q("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenant,actor]);
  const cnpj=randomUUID().replace(/\D/g,'').padEnd(14,'7').slice(0,8)+'000100';
  const company=(await q<{id:string}>(`
    INSERT INTO companies(tenant_id,head_office_cnpj,legal_name)
    VALUES($1,$2,'R6 Synthetic Company') RETURNING id
  `,[tenant,cnpj]))[0]!.id;
  const branches=await q<{id:string}>(`
    INSERT INTO establishments(company_id,cnpj,name,establishment_type_code,is_head_office,uf)
    VALUES($1,$2,'R6 Synthetic HQ','HEAD_OFFICE',true,'GO'),
      ($1,$3,'R6 Synthetic Branch','OFFICE',false,'GO') RETURNING id
  `,[company,cnpj,cnpj.slice(0,8)+'000200']);
  await q(`INSERT INTO company_tax_profiles(company_id,version_no,tax_regime,is_current,personalization)
    SELECT $1,n,'LUCRO_REAL',n=11,jsonb_build_object('products',jsonb_build_array('synthetic',n))
    FROM generate_series(1,11) n`,[company]);
  await q(`INSERT INTO cnaes(code,description)
    SELECT (9000000+n)::text,'R6 synthetic activity '||n FROM generate_series(1,35) n
    ON CONFLICT(code) DO NOTHING`);
  await q(`INSERT INTO company_cnaes(company_id,cnae_code,is_primary)
    SELECT $1,(9000000+n)::text,n=1 FROM generate_series(1,35)n`,[company]);
  await q(`INSERT INTO establishment_cnaes(establishment_id,cnae_code,is_primary)
    SELECT CASE WHEN n<=24 THEN $1::uuid ELSE $2::uuid END,
      (9000000+CASE WHEN n<=24 THEN n ELSE n-12 END)::text,n IN(1,25)
    FROM generate_series(1,47)n`,[branches[0]!.id,branches[1]!.id]);
  const products=await q<{id:string}>(`INSERT INTO company_product_profiles(company_id,product_label)
    SELECT $1,'R6 synthetic product '||n FROM generate_series(1,5)n RETURNING id`,[company]);
  await q(`INSERT INTO official_catalogs(code,name,maintainer) VALUES('NCM','NCM','Synthetic CI')
    ON CONFLICT(code) DO NOTHING;
    INSERT INTO official_catalog_editions(catalog_id,edition_code,source_url,status)
    SELECT c.id,'onb02-r6-synthetic','https://example.test/','CURRENT' FROM official_catalogs c
    WHERE c.code='NCM' AND NOT EXISTS(SELECT 1 FROM official_catalog_editions e WHERE e.catalog_id=c.id AND e.status='CURRENT')
    ON CONFLICT(catalog_id,edition_code) DO NOTHING;
    INSERT INTO official_catalog_entries(catalog_edition_id,official_code,description,metadata)
    SELECT e.id,'1234.56.78','R6 synthetic NCM','{"assignable":true}'::jsonb
    FROM official_catalog_editions e JOIN official_catalogs c ON c.id=e.catalog_id
    WHERE c.code='NCM' AND e.status='CURRENT'
    ON CONFLICT(catalog_edition_id,official_code) DO NOTHING`);
  const entry=(await q<{id:string}>(`SELECT oce.id FROM official_catalog_entries oce
    JOIN official_catalog_editions e ON e.id=oce.catalog_edition_id
    JOIN official_catalogs c ON c.id=e.catalog_id
    WHERE c.code='NCM' AND e.status='CURRENT' AND oce.official_code='1234.56.78' LIMIT 1`))[0]!.id;
  await q(`INSERT INTO company_product_ncms(company_product_profile_id,official_catalog_entry_id)
    VALUES($1,$3),($2,$3)`,[products[0]!.id,products[1]!.id,entry]);
  await q(`INSERT INTO company_cnae_ncms(company_id,cnae_code,official_catalog_entry_id)
    SELECT $1,(9000000+n)::text,$2 FROM generate_series(1,13)n`,[company,entry]);
  await q("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[actor,tenant]);
  const graph=async()=> (await q<{graph:Record<string,number>}>(`SELECT jsonb_build_object(
    'companies',(SELECT count(*) FROM companies WHERE id=$1),
    'establishments',(SELECT count(*) FROM establishments WHERE company_id=$1),
    'company_tax_profiles',(SELECT count(*) FROM company_tax_profiles WHERE company_id=$1),
    'company_cnaes',(SELECT count(*) FROM company_cnaes WHERE company_id=$1),
    'establishment_cnaes',(SELECT count(*) FROM establishment_cnaes ec JOIN establishments e ON e.id=ec.establishment_id WHERE e.company_id=$1),
    'company_product_profiles',(SELECT count(*) FROM company_product_profiles WHERE company_id=$1),
    'company_product_ncms',(SELECT count(*) FROM company_product_ncms n JOIN company_product_profiles p ON p.id=n.company_product_profile_id WHERE p.company_id=$1),
    'company_cnae_ncms',(SELECT count(*) FROM company_cnae_ncms WHERE company_id=$1),
    'monitoring_profiles',(SELECT count(*) FROM monitoring_profiles WHERE company_id=$1),
    'company_publications',(SELECT count(*) FROM company_publications WHERE company_id=$1),
    'publication_matches',(SELECT count(*) FROM publication_matches pm JOIN monitoring_profiles mp ON mp.id=pm.monitoring_profile_id WHERE mp.company_id=$1)
  ) AS graph`,[company]))[0]!.graph;
  const expected={companies:1,establishments:2,company_tax_profiles:11,company_cnaes:35,
    establishment_cnaes:47,company_product_profiles:5,company_product_ncms:2,company_cnae_ncms:13,
    monitoring_profiles:0,company_publications:0,publication_matches:0};
  assert.deepEqual(await graph(),expected);
  if(!scale) await q(`INSERT INTO audit_log(tenant_id,actor_type,action,entity_type,entity_id,before_data)
    VALUES($1,'SYSTEM','COMPANY_UPDATED','company',$2,
      jsonb_build_object('company_id',$2::text,'is_active',true))`,[tenant,company]);
  if(scale) {
    const source=(await q<{id:string}>(`INSERT INTO sources(code,name,jurisdiction_level,base_url,connector_key)
      VALUES($1,'R6 synthetic global source','FEDERAL','https://example.test/',$1) RETURNING id`,[randomUUID()]))[0]!.id;
    const run=(await q<{id:string}>(`INSERT INTO collection_runs(source_id,scheduled_for,trigger_type,status)
      VALUES($1,now(),'MANUAL','SUCCESS') RETURNING id`,[source]))[0]!.id;
    await q(`INSERT INTO collection_items(collection_run_id,source_item_key,status,raw_metadata)
      SELECT $1,n::text,'PROCESSED_EXISTING',jsonb_build_object('official',true,'text',repeat('x',128))
      FROM generate_series(1,420000)n`,[run]);
    await q(`INSERT INTO audit_log(tenant_id,actor_type,action,entity_type,entity_id,before_data,after_data)
      SELECT $1,'SYSTEM','COMPANY_UPDATED','company',$2::text,
        jsonb_build_object('company_id',$2::text,'is_active',true),
        jsonb_build_object('company_id',$2::text,'is_active',false)
      FROM generate_series(1,150000)n`,[tenant,company]);
    const before=(await q<{n:string;hash:string}>(`SELECT count(*)::text n,
      md5(string_agg(md5(to_jsonb(i)::text),'' ORDER BY i.id)) hash
      FROM collection_items i WHERE collection_run_id=$1`,[run]))[0]!;
    assert.equal(Number(before.n),420000);
    assert.equal(Number((await q<{n:string}>("SELECT count(*)::text n FROM audit_log WHERE tenant_id=$1",[tenant]))[0]!.n),150000);
    return {q,tenant,company,actor,graph,expected,run,before};
  }
  return {q,tenant,company,actor,graph,expected,run:undefined,before:undefined};
}

test('ONB-02 R7: graph-only purge with 150k audits and recorded company graph; stages; global rows unchanged', {timeout:180000}, async()=>{
  const db=isolatedDatabase();
  try {
    await assert.rejects(db.transaction().execute(async trx=>{
      const version=await sql<{server_version:string}>`SHOW server_version`.execute(trx);
      assert.match(version.rows[0]!.server_version,/^18\./);
      const f=await fixture(trx,true);
      await f.q('ANALYZE audit_log');
      await f.q('ANALYZE collection_items');
      await f.q("SELECT set_config('app.onb02_measure','on',true)");
      const start=performance.now();
      assert.equal(await purgeCompany(trx,f.company),true);
      const clientMs=performance.now()-start;
      const metrics=(await f.q<{metrics:Record<string,number>}>(`
        SELECT current_setting('app.onb02_purge_metrics')::jsonb AS metrics`))[0]!.metrics;
      for(const value of Object.values(await f.graph()))assert.equal(value,0);
      const after=(await f.q<{n:string;hash:string}>(`SELECT count(*)::text n,
        md5(string_agg(md5(to_jsonb(i)::text),'' ORDER BY i.id)) hash
        FROM collection_items i WHERE collection_run_id=$1`,[f.run]))[0]!;
      assert.deepEqual(after,f.before);
      assert.equal(Number((await f.q<{n:string}>(`SELECT count(*)::text n FROM audit_log
        WHERE tenant_id=$1 AND action='COMPANY_UPDATED'`,[f.tenant]))[0]!.n),150000);
      assert.ok(metrics.total_ms<30000);
      console.log('ONB02_R7_FULL_PURGE '+JSON.stringify({
        postgres:version.rows[0]!.server_version,audit_rows:150000,collection_items:420000,
        graph_rows:116,graph:f.expected,client_total_ms:clientMs,stage_ms:metrics,
        preserved_global_rows:true,fixture:'synthetic row-count match; not production hardware/JSON distribution'
      }));
      throw new FixtureRollback();
    }),FixtureRollback);
  } finally { await db.destroy(); }
});

test('ONB-02 R7: service statement timeout cancels AFTER cascade and rolls back every stage', {timeout:60000}, async()=>{
  const db=isolatedDatabase();
  try {
    await assert.rejects(db.transaction().execute(async trx=>{
      const f=await fixture(trx,false);
      await f.q(`CREATE FUNCTION public.onb02_r6_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.action='COMPANY_PURGED' THEN PERFORM pg_sleep(31); END IF; RETURN NEW; END $fn$;
        CREATE TRIGGER onb02_r6_slow_audit BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION public.onb02_r6_slow_audit()`);
      await f.q('SAVEPOINT before_purge');
      const before=await f.graph();
      const auditBefore=await f.q('SELECT before_data,entity_id FROM audit_log WHERE tenant_id=$1',[f.tenant]);
      const settingsBefore=await f.q('SHOW statement_timeout');
      await assert.rejects(purgeCompany(trx,f.company),(error:unknown)=>
        (error as {code?:string}).code==='57014');
      await f.q('ROLLBACK TO SAVEPOINT before_purge');
      assert.deepEqual(await f.graph(),before);
      assert.deepEqual(await f.q('SELECT before_data,entity_id FROM audit_log WHERE tenant_id=$1',[f.tenant]),auditBefore);
      assert.deepEqual(await f.q('SHOW statement_timeout'),settingsBefore);
      assert.equal(Number((await f.q<{n:string}>(
        "SELECT count(*)::text n FROM audit_log WHERE tenant_id=$1 AND action='COMPANY_PURGED'",[f.tenant]))[0]!.n),0);
      console.log('ONB02_R7_STATEMENT_TIMEOUT rollback=PASS sqlstate=57014');
      throw new FixtureRollback();
    }),FixtureRollback);
  } finally { await db.destroy(); }
});

test('ONB-02 R7: service lock timeout rolls back audit changes and releases locks', {timeout:30000}, async()=>{
  const db=isolatedDatabase();
  const blocker=new Pool({connectionString:databaseUrl,max:1});
  const hold=await blocker.connect();
  const key=Math.floor(Math.random()*1000000000)+1;
  try {
    await hold.query('SELECT pg_advisory_lock($1)',[key]);
    await assert.rejects(db.transaction().execute(async trx=>{
      const f=await fixture(trx,false);
      await f.q(`CREATE FUNCTION public.onb02_r6_locked_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN OLD; END $fn$;
        CREATE TRIGGER onb02_r6_locked_delete BEFORE DELETE ON companies
        FOR EACH ROW EXECUTE FUNCTION public.onb02_r6_locked_delete()`);
      const before=await f.graph();
      const audits=await f.q('SELECT before_data,entity_id FROM audit_log WHERE tenant_id=$1',[f.tenant]);
      const timeouts=await f.q('SHOW lock_timeout');
      await f.q('SAVEPOINT before_locked_purge');
      await assert.rejects(purgeCompany(trx,f.company),(error:unknown)=>
        (error as {code?:string}).code==='55P03');
      await f.q('ROLLBACK TO SAVEPOINT before_locked_purge');
      assert.deepEqual(await f.graph(),before);
      assert.deepEqual(await f.q('SELECT before_data,entity_id FROM audit_log WHERE tenant_id=$1',[f.tenant]),audits);
      assert.deepEqual(await f.q('SHOW lock_timeout'),timeouts);
      console.log('ONB02_R7_LOCK_TIMEOUT rollback=PASS sqlstate=55P03');
      throw new FixtureRollback();
    }),FixtureRollback);
  } finally {
    await hold.query('SELECT pg_advisory_unlock($1)',[key]);
    hold.release();await blocker.end();await db.destroy();
  }
});
