import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {applyAuditBackfill,planAuditBackfill} from '../src/modules/audit/audit-backfill.js';
import {buildApp} from '../src/app.js';

const url=process.env.DATABASE_ADMIN_URL;
function isolated(){
 assert.equal(process.env.CI,'true');
 assert.ok(url);
 const u=new URL(url);
 assert.ok(['localhost','127.0.0.1'].includes(u.hostname));
 assert.equal(u.pathname,'/radar_fiscal_test');
 assert.equal(u.search,'');
 return new Pool({connectionString:url,max:2,options:'-c jit=off -c statement_timeout=45000 -c lock_timeout=5000'});
}
test('R7: allowlist rejects unregistered events, unknown keys, nested payloads, names and CNPJ',async()=>{
 const pool=isolated();
 try {
  const action='COMPANY_UPDATED', entity='company';
  for(const payload of [
    {unknownField:true},{cnpj:'blocked'},{legalName:'blocked'},{tradeName:'blocked'},
    {message:'blocked'},{company_id:{name:'blocked'}},{is_active:'blocked'},
    {['private-' + randomUUID()]:true}
  ]){
   await assert.rejects(pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,after_data)
     VALUES('SYSTEM','system:worker',$1,$2,$3::jsonb)`,[action,entity,JSON.stringify(payload)]),
     (e:unknown)=>(e as {code?:string}).code==='23514');
  }
  await assert.rejects(pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type)
    VALUES('SYSTEM','system:worker','UNREGISTERED_NEW_EVENT','company')`),
    (e:unknown)=>(e as {code?:string}).code==='23514');
  for (const [column,value] of [['entity_id','not-an-opaque-id'],['request_id','not-an-opaque-id']] as const) {
   await assert.rejects(pool.query(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,${column})
     VALUES('SYSTEM','system:worker','COMPANY_UPDATED','company',$1)`,[value]),
     (e:unknown)=>(e as {code?:string}).code==='23514');
  }
  const safe=await pool.query<{id:string}>(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,after_data)
    VALUES('SYSTEM','system:worker','COMPANY_UPDATED','company','{"is_active":true}') RETURNING id`);
  await assert.rejects(pool.query("SET ROLE radar_worker; SELECT * FROM public.audit_backfill_batch(10)"),
    (e:unknown)=>(e as {code?:string}).code==='42501');
  await pool.query('RESET ROLE');
  await pool.query('DELETE FROM audit_log WHERE id=$1',[safe.rows[0]!.id]);
 }finally{await pool.end();}
});
test('R7: 150k legacy audits, read-only plan, atomic batch failure, restart, idempotency, unrelated entities unchanged',{timeout:240000},async()=>{
 let pool=isolated(); const tenants:string[]=[];
 try {
  assert.match((await pool.query<{server_version:string}>('SHOW server_version')).rows[0]!.server_version,/^18\./);
  await applyAuditBackfill(pool);
  for(let i=0;i<2;i++)tenants.push((await pool.query<{id:string}>(
    "INSERT INTO tenants(name,slug) VALUES('R7 synthetic account',$1) RETURNING id",[randomUUID()])).rows[0]!.id);
  const company=(await pool.query<{id:string}>(`INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
    VALUES($1,'R7 unrelated synthetic entity',$2) RETURNING id`,
    [tenants[1],randomUUID().replace(/\D/g,'').padEnd(14,'7').slice(0,14)])).rows[0]!.id;
  const companyBefore=(await pool.query('SELECT to_jsonb(c) data FROM companies c WHERE id=$1',[company])).rows;
  const client=await pool.connect();
  try {
   await client.query('BEGIN');
   // Only this isolated legacy-fixture transaction bypasses the new-write guard.
   // There is no runtime flag or callable application bypass.
   await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_allowlist_guard');
   await client.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,before_data,after_data)
    SELECT CASE WHEN n%2=0 THEN $1::uuid ELSE $2::uuid END,'SYSTEM','system:worker',
      CASE WHEN n%3=0 THEN 'COMPANY_CREATED' ELSE 'COMPANY_UPDATED' END,
      'company',CASE WHEN n%2=0 THEN $3::text ELSE lpad(n::text,14,'0') END,
      jsonb_build_object('company_id',$3::text,'is_active',true,'cnpj',lpad(n::text,14,'0'),
        'legalName',normalize('Empresa Sintética Árvore',NFD),
        'nested',jsonb_build_object('message','old private text'),
        gen_random_uuid()::text,'old private key'),
      jsonb_build_object('company_id',$3::text,'is_active',false,'tradeName','old private name')
    FROM generate_series(1,100000)n`,[tenants[0],tenants[1],company]);
   await client.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,after_data)
    SELECT $1,'ADMIN',NULL,'TAXONOMY_CURATION_IMPORT','taxonomy_curation',
      jsonb_build_object('rows',n,'created',1,'errors',0)
    FROM generate_series(1,50000)n`,[tenants[1]]);
   await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_allowlist_guard');
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  console.log('ONB02_R71_STAGE legacy_fixture_committed');
  const gateClient=await pool.connect();
  try {
   await gateClient.query('BEGIN');
   const actor=(await gateClient.query<{id:string}>(
     "INSERT INTO app_users(email,name) VALUES($1,'R7 synthetic actor') RETURNING id",
     [randomUUID()+'@example.test'])).rows[0]!.id;
   await gateClient.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenants[1],actor]);
   await gateClient.query("SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",[actor,tenants[1]]);
   await assert.rejects(gateClient.query('SELECT public.app_purge_company($1)',[company]),
     (e:unknown)=>(e as {code?:string;message?:string}).code==='55000' &&
       (e as {message?:string}).message==='company_purge_audit_backfill_required');
  }finally{await gateClient.query('ROLLBACK');gateClient.release();}
  const headers=async()=> (await pool.query<{hash:string}>(`SELECT md5(string_agg(
    md5(jsonb_build_array(id,tenant_id,actor_type,actor_id,action,entity_type,occurred_at,correlation_id)::text),
    '' ORDER BY id)) hash FROM audit_log WHERE tenant_id=ANY($1::uuid[])`,[tenants])).rows[0]!.hash;
  const safeHash=async()=> (await pool.query<{hash:string}>(`SELECT md5(string_agg(
    md5(jsonb_build_array(entity_id,before_data,after_data)::text),'' ORDER BY id)) hash
    FROM audit_log WHERE tenant_id=$1 AND action='TAXONOMY_CURATION_IMPORT'`,[tenants[1]])).rows[0]!.hash;
  const beforeHeaders=await headers(),beforeSafe=await safeHash();
  const checkpointBefore=(await pool.query('SELECT * FROM audit_backfill_checkpoint')).rows;
  assert.equal((await planAuditBackfill(pool)).pending,150000);
  assert.deepEqual((await pool.query('SELECT * FROM audit_backfill_checkpoint')).rows,checkpointBefore,'plan must not mutate checkpoint');
  await pool.query(`CREATE FUNCTION public.onb02_r7_fail_batch() RETURNS trigger LANGUAGE plpgsql AS $f$
   BEGIN RAISE EXCEPTION 'synthetic_batch_interruption'; END $f$;
   CREATE TRIGGER onb02_r7_fail_batch BEFORE UPDATE ON audit_log
   FOR EACH ROW EXECUTE FUNCTION public.onb02_r7_fail_batch()`);
  try {await assert.rejects(applyAuditBackfill(pool,{batchSize:5000,maxBatches:1}));}
  finally {await pool.query('DROP TRIGGER onb02_r7_fail_batch ON audit_log; DROP FUNCTION public.onb02_r7_fail_batch()');}
  assert.equal((await planAuditBackfill(pool)).pending,150000);
  assert.deepEqual((await pool.query('SELECT * FROM audit_backfill_checkpoint')).rows,checkpointBefore,'failed batch must not advance');
  console.log('ONB02_R71_STAGE failed_batch_rolled_back');
  const start=performance.now();
  const first=await applyAuditBackfill(pool,{batchSize:5000,maxBatches:3});
  assert.equal(first.processed,15000);assert.equal(first.remaining,135000);assert.equal(first.completed,false);
  console.log('ONB02_R71_STAGE first_three_batches_committed');
  await pool.end();
  console.log('ONB02_R71_STAGE original_pool_closed');
  pool=isolated(); // Actual new connection after a committed interruption.
  const resumed=await applyAuditBackfill(pool,{batchSize:5000});
  console.log('ONB02_R71_STAGE resumed_batches_committed');
  const elapsed=performance.now()-start;
  assert.equal(resumed.processed,135000);assert.equal(resumed.remaining,0);
  assert.equal((await applyAuditBackfill(pool)).processed,0);
  assert.equal(await headers(),beforeHeaders,'action/date/author/tenant/correlation preserved');
  assert.equal(await safeHash(),beforeSafe,'other event permitted context unchanged');
  assert.deepEqual((await pool.query('SELECT to_jsonb(c) data FROM companies c WHERE id=$1',[company])).rows,companyBefore);
  const remaining=(await pool.query<{n:string}>(`SELECT count(*)::text n FROM audit_log WHERE tenant_id=ANY($1::uuid[])
    AND (before_data IS DISTINCT FROM public.audit_project(action,entity_type,before_data)
      OR after_data IS DISTINCT FROM public.audit_project(action,entity_type,after_data)
      OR entity_id IS DISTINCT FROM public.audit_entity_reference(entity_id))`,[tenants])).rows[0]!.n;
  assert.equal(Number(remaining),0);
  const retained=await pool.query<{n:string}>(`SELECT count(*)::text n FROM audit_log
    WHERE tenant_id=ANY($1::uuid[]) AND action='COMPANY_UPDATED'
      AND before_data=jsonb_build_object('company_id',$2::text,'is_active',true)
      AND after_data=jsonb_build_object('company_id',$2::text,'is_active',false)`,[tenants,company]);
  assert.equal(Number(retained.rows[0]!.n),66667,'known event retains exactly the permitted context');
  const created=await pool.query<{n:string}>(`SELECT count(*)::text n FROM audit_log
    WHERE tenant_id=ANY($1::uuid[]) AND action='COMPANY_CREATED'
      AND before_data=jsonb_build_object('company_id',$2::text,'is_active',true)
      AND after_data=jsonb_build_object('company_id',$2::text,'is_active',false)`,[tenants,company]);
  assert.equal(Number(created.rows[0]!.n),33333,'second known event uses its explicit rule');
  console.log('ONB02_R7_BACKFILL '+JSON.stringify({rows:150000,batchSize:5000,
    total_ms:elapsed,first_ms:first.elapsedMs,resume_ms:resumed.elapsedMs,
    restart:true,idempotent:true,atomicFailure:true,headersPreserved:true,otherEntityPreserved:true}));
 } finally {
  if(tenants.length){
   await pool.query('DELETE FROM audit_log WHERE tenant_id=ANY($1::uuid[])',[tenants]);
   await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
  }
  await pool.end();
 }
});
test('R7: company history resolves current names, distinguishes deletion from unavailable and isolates tenant',async()=>{
 const pool=isolated();const app=await buildApp();const users:string[]=[],tenants:string[]=[];
 try{
  await app.ready();
  const signup=async()=>{
   const password='Synthetic-R7-Password-2026!';
   const email=randomUUID()+'@example.test';
   const r=await app.inject({method:'POST',url:'/auth/register',payload:{
    name:'Synthetic actor',email,password,confirmPassword:password,acceptedTerms:true}});
   assert.equal(r.statusCode,201);
   const x=r.json<{user:{id:string};tenant:{id:string}}>();users.push(x.user.id);tenants.push(x.tenant.id);
   const login=await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
   return {tenant:x.tenant.id,headers:{authorization:'Bearer '+login.json<{accessToken:string}>().accessToken,'x-tenant-id':x.tenant.id}};
  };
  const a=await signup(),b=await signup();
  const company=(await pool.query<{id:string}>(`INSERT INTO companies(tenant_id,legal_name,head_office_cnpj)
    VALUES($1,'R7 current synthetic name',$2) RETURNING id`,
    [a.tenant,randomUUID().replace(/\D/g,'').padEnd(14,'7').slice(0,14)])).rows[0]!.id;
  const missing=randomUUID(),deleted=randomUUID();
  await pool.query(`INSERT INTO audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data)
    VALUES($1,'SYSTEM','system:worker','COMPANY_UPDATED','company',$2,'{}'),
      ($1,'SYSTEM','system:worker','COMPANY_UPDATED','company',$3,'{}'),
      ($1,'SYSTEM','system:worker','COMPANY_PURGED','company',$4,'{"purged":true}'),
      ($5,'SYSTEM','system:worker','COMPANY_PURGED','company',$3,'{"purged":true}')`,
    [a.tenant,company,missing,deleted,b.tenant]);
  const list=async()=>{const r=await app.inject({method:'GET',url:'/api/v1/company-audit-history',headers:a.headers});assert.equal(r.statusCode,200);return r.json<{items:Array<{companyState:string;companyName:string|null}>}>().items};
  let items=await list();
  assert.equal(items.length,3);
  assert.equal(items.filter(i=>i.companyState==='PRESENT'&&i.companyName==='R7 current synthetic name').length,1);
  assert.equal(items.filter(i=>i.companyState==='DELETED').length,1);
  assert.equal(items.filter(i=>i.companyState==='UNAVAILABLE').length,1,'other tenant tombstone is not evidence');
  await pool.query("UPDATE companies SET legal_name='R7 renamed synthetic name' WHERE id=$1",[company]);
  items=await list();
  assert.ok(items.some(i=>i.companyName==='R7 renamed synthetic name'),'name resolved live, not historical snapshot');
  const denied=await app.inject({method:'GET',url:'/api/v1/company-audit-history',headers:{...b.headers,'x-tenant-id':a.tenant}});
  assert.equal(denied.statusCode,403);
 }finally{
  await app.close();
  if(tenants.length)await pool.query('DELETE FROM audit_log WHERE tenant_id=ANY($1::uuid[])',[tenants]);
  if(users.length)await pool.query('DELETE FROM app_users WHERE id=ANY($1::uuid[])',[users]);
  if(tenants.length)await pool.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])',[tenants]);
  await pool.end();
 }
});
