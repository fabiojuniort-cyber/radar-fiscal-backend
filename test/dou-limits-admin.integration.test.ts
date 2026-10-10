import assert from 'node:assert/strict';
import { createHmac,randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const adminUrl=process.env.DATABASE_ADMIN_URL;
const appUrl=process.env.DATABASE_URL;
const gateUrl=process.env.DATABASE_DOU_LIMITS_URL;
const signingKey=process.env.DOU_LIMITS_SIGNING_SECRET;
if (!adminUrl || !appUrl || !gateUrl || !signingKey)
 throw new Error('OPS-DL-01 requires isolated PG test credentials');
const path='/api/v1/admin/platform/dou-download-limits';
const original={pdfMiB:20,zipMiB:64,expandedZipMiB:128,xmlEntryMiB:8};
const modified={pdfMiB:20,zipMiB:32,expandedZipMiB:64,xmlEntryMiB:8};
async function session(app:Awaited<ReturnType<typeof buildApp>>,label:string) {
 const email='dou-security-'+label+'-'+randomUUID()+'@example.invalid';
 const response=await app.inject({method:'POST',url:'/auth/register',payload:{
  name:'DOU Security Test',email,company:'DOU test fixture',
  password:'Test-DOU-Settings-2026!',confirmPassword:'Test-DOU-Settings-2026!',acceptedTerms:true,
 }});
 assert.equal(response.statusCode,201,response.body);
 const id=response.json<{user:{id:string}}>().user.id;
 const login=await app.inject({method:'POST',url:'/auth/login',
  payload:{email,password:'Test-DOU-Settings-2026!'}});
 assert.equal(login.statusCode,200,login.body);
 const accessToken=login.json<{accessToken:string}>().accessToken;
 return {id,headers:{authorization:'Bearer '+accessToken}};
}
test('OPS-DL-01 R2: SQL identity spoof denied; signed write, replay, concurrency, revocation',async()=>{
 const admin=new Pool({connectionString:adminUrl,max:2});
 const generic=new Pool({connectionString:appUrl,max:2});
 const gate=new Pool({connectionString:gateUrl,max:2});
 const app=await buildApp();
 const ids:string[]=[];
 const gateSql='SELECT public.platform_admin_set_dou_limits($1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text)';
 const signedArguments=(actor:string,limits:typeof modified,issued=Math.floor(Date.now()/1000))=>{
  const nonce=randomUUID();
  const statement=['OPS-DL-01/v1',actor,String(issued),nonce,
   String(limits.pdfMiB),String(limits.zipMiB),
   String(limits.expandedZipMiB),String(limits.xmlEntryMiB)].join('|');
  const mac=createHmac('sha256',Buffer.from(signingKey,'hex')).update(statement,'utf8').digest('hex');
  return [actor,JSON.stringify(limits),issued,nonce,mac] as const;
 };
 const expectPermissionDenied=async(action:Promise<unknown>,reason:string)=>{
  await assert.rejects(action,(e:unknown)=>(e as {code?:string}).code==='42501',reason);
 };
 let sourceCreated=false;
 let oldConfig:unknown;
 try {
  const pre=await admin.query<{connector_config:unknown}>(
   "SELECT connector_config FROM public.sources WHERE code='dou' AND connector_key='dou'");
  if (!pre.rows.length) {
   const ins=await admin.query(
    `INSERT INTO public.sources(code,name,jurisdiction_level,base_url,connector_key,connector_config)
      VALUES('dou','DOU SQL security fixture','FEDERAL','https://inlabs.in.gov.br','dou','{}'::jsonb)
      RETURNING id`);
   sourceCreated=ins.rowCount===1;
  }
  const src=await admin.query<{connector_config:unknown}>(
   "SELECT connector_config FROM public.sources WHERE code='dou' AND connector_key='dou'");
  assert.equal(src.rows.length,1);
  oldConfig=src.rows[0]!.connector_config;
  const real=await session(app,'admin');
  const customer=await session(app,'customer');
  ids.push(real.id,customer.id);
  await admin.query(`INSERT INTO public.platform_user_roles(user_id,role,granted_by)
                      VALUES($1,'PLATFORM_ADMIN','ops-dl-r2-ci')`,[real.id]);
  const good=await app.inject({method:'GET',url:path,headers:real.headers});
  assert.equal(good.statusCode,200,good.body);
  assert.equal(good.json().editable,true);
  for(const method of ['GET','PUT'] as const){
   const denied=await app.inject({method,url:path,headers:customer.headers,
      ...(method==='PUT'?{payload:modified}:{})});
   assert.equal(denied.statusCode,403,denied.body);
  }

  // Adversarial: database access as the ordinary app runtime + spoofed GUC
  // is NOT sufficient to invoke the privileged SQL function.
  const escaped=await generic.connect();
  try {
   await escaped.query('BEGIN');
   await escaped.query("SELECT set_config('app.user_id',$1,true)",[real.id]);
   await assert.rejects(
    escaped.query(`SELECT public.platform_admin_set_dou_limits(
      $1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text)`,
     [real.id,JSON.stringify(modified),Math.floor(Date.now()/1000),randomUUID(),'0'.repeat(64)]),
    (e:unknown)=>(e as {code?:string}).code==='42501');
   await escaped.query('ROLLBACK');
  }finally {escaped.release();}

  const bad=await gate.query(`SELECT public.platform_admin_set_dou_limits(
      $1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text)`,
   [real.id,JSON.stringify(modified),Math.floor(Date.now()/1000),randomUUID(),'0'.repeat(64)]
  ).then(()=>false,(e:unknown)=>(e as {code?:string}).code==='42501');
  assert.equal(bad,true,'a dedicated connection cannot invent a MAC either');

  // Read the effective catalog ACLs, not only the migration source.
  const perms=await admin.query<{
   role_login:boolean;superuser:boolean;bypass_rls:boolean;inherit:boolean;
   can_execute_gateway:boolean;app_can_execute_gateway:boolean;
   app_can_update_sources:boolean;gate_can_update_sources:boolean;
   gate_can_read_signing_keys:boolean;gate_can_read_used_nonces:boolean;
   gate_can_read_audit:boolean;gate_can_insert_audit:boolean;
   gate_is_app_member:boolean;gate_is_worker_member:boolean;
   gate_can_create_schema_objects:boolean;
  }>(`SELECT
    r.rolcanlogin AS role_login,r.rolsuper AS superuser,
    r.rolbypassrls AS bypass_rls,r.rolinherit AS inherit,
    has_function_privilege('radar_dou_limits_runtime',
      'public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)','EXECUTE') AS can_execute_gateway,
    has_function_privilege('radar_app_runtime',
      'public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)','EXECUTE') AS app_can_execute_gateway,
    has_table_privilege('radar_app_runtime','public.sources','UPDATE') AS app_can_update_sources,
    has_table_privilege('radar_dou_limits_runtime','public.sources','UPDATE') AS gate_can_update_sources,
    has_table_privilege('radar_dou_limits_runtime','public.ops_dou_limits_signing_keys','SELECT') AS gate_can_read_signing_keys,
    has_table_privilege('radar_dou_limits_runtime','public.ops_dou_limits_used_nonces','SELECT') AS gate_can_read_used_nonces,
    has_table_privilege('radar_dou_limits_runtime','public.audit_log','SELECT') AS gate_can_read_audit,
    has_table_privilege('radar_dou_limits_runtime','public.audit_log','INSERT') AS gate_can_insert_audit,
    pg_has_role('radar_dou_limits_runtime','radar_app','MEMBER') AS gate_is_app_member,
    pg_has_role('radar_dou_limits_runtime','radar_worker','MEMBER') AS gate_is_worker_member,
    has_schema_privilege('radar_dou_limits_runtime','public','CREATE') AS gate_can_create_schema_objects
   FROM pg_catalog.pg_roles r WHERE r.rolname='radar_dou_limits_runtime'`);
  assert.equal(perms.rows.length,1);
  assert.deepEqual(perms.rows[0],{
   role_login:true,superuser:false,bypass_rls:false,inherit:false,
   can_execute_gateway:true,app_can_execute_gateway:false,
   app_can_update_sources:false,gate_can_update_sources:false,
   gate_can_read_signing_keys:false,gate_can_read_used_nonces:false,
   gate_can_read_audit:false,gate_can_insert_audit:false,
   gate_is_app_member:false,gate_is_worker_member:false,
   gate_can_create_schema_objects:false,
  });
  const definer=await admin.query<{owner:string;is_definer:boolean;config:string[]|null}>(`
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      p.prosecdef AS is_definer,p.proconfig AS config
    FROM pg_catalog.pg_proc p
    WHERE p.oid='public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)'::regprocedure`);
  assert.equal(definer.rows.length,1);
  assert.equal(definer.rows[0]!.is_definer,true);
  assert.notEqual(definer.rows[0]!.owner,'radar_dou_limits_runtime');
  assert.notEqual(definer.rows[0]!.owner,'radar_app_runtime');
  assert.ok(definer.rows[0]!.config?.some(x=>x.includes('search_path=pg_catalog, pg_temp')||x.includes('search_path=pg_catalog,pg_temp')));
  await expectPermissionDenied(gate.query('SELECT key_id FROM public.ops_dou_limits_signing_keys'),
    'dedicated login must not read signing key inventory');
  await expectPermissionDenied(gate.query('SELECT nonce FROM public.ops_dou_limits_used_nonces'),
    'dedicated login must not read replay ledger');
  await expectPermissionDenied(gate.query("UPDATE public.sources SET updated_at=now() WHERE code='dou'"),
    'dedicated login must not update source table directly');
  await expectPermissionDenied(gate.query('SET ROLE radar_app'),
    'dedicated login must not assume application role');

  // Legitimately signed statements are still rejected when any bound claim is changed.
  const authentic=signedArguments(real.id,{...modified,zipMiB:16});
  const alteredPayload=[...authentic];alteredPayload[1]=JSON.stringify({...modified,zipMiB:17});
  const alteredActor=[...authentic];alteredActor[0]=customer.id;
  const alteredNonce=[...authentic];alteredNonce[3]=randomUUID();
  for(const [name,args] of [
    ['payload changed',alteredPayload],['actor changed',alteredActor],
    ['nonce changed',alteredNonce],
  ] as const){
    await expectPermissionDenied(gate.query(gateSql,args),
      'MAC must bind the exact '+name);
  }
  for(const issued of [Math.floor(Date.now()/1000)-121,Math.floor(Date.now()/1000)+121]){
    await expectPermissionDenied(gate.query(gateSql,signedArguments(real.id,modified,issued)),
      'validly signed but expired/future-dated statement must fail');
  }
  const invalidNonces=await admin.query<{n:string}>(`
    SELECT count(*)::text AS n FROM public.ops_dou_limits_used_nonces
    WHERE nonce=$1::uuid`,[authentic[3]]);
  assert.equal(invalidNonces.rows[0]!.n,'0',
    'invalidly signed attempts must not burn the authentic nonce');

  const saved=await app.inject({method:'PUT',url:path,headers:real.headers,payload:modified});
  assert.equal(saved.statusCode,200,saved.body);
  assert.deepEqual(saved.json().limits,modified);
  const read=await app.inject({method:'GET',url:path,headers:real.headers});
  assert.deepEqual(read.json().limits,modified);

  const issue=Math.floor(Date.now()/1000),nonce=randomUUID();
  const msg=['OPS-DL-01/v1',real.id,String(issue),nonce,'20','16','64','8'].join('|');
  const mac=createHmac('sha256',Buffer.from(signingKey,'hex')).update(msg).digest('hex');
  const signed=[real.id,JSON.stringify({...modified,zipMiB:16}),issue,nonce,mac];
  const once=await gate.query('SELECT public.platform_admin_set_dou_limits($1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text)',signed);
  assert.equal(once.rowCount,1);
  await assert.rejects(
    gate.query('SELECT public.platform_admin_set_dou_limits($1::uuid,$2::jsonb,$3::bigint,$4::uuid,$5::text)',signed),
    (e:unknown)=>(e as {code?:string}).code==='23505','a valid signed request must be single-use');

  // Two legitimate independent signed requests are serialized and audited.
  const variants=[{...modified,zipMiB:24},{...modified,zipMiB:32}];
  const results=await Promise.all(variants.map(payload=>
    app.inject({method:'PUT',url:path,headers:real.headers,payload})));
  for(const r of results) assert.equal(r.statusCode,200,r.body);
  const winner=await app.inject({method:'GET',url:path,headers:real.headers});
  assert.ok([24,32].includes(winner.json().limits.zipMiB));
  const audit=await admin.query<{after_data:{zipMiB:number}}>(
    "SELECT after_data FROM public.audit_log WHERE action='DOU_DOWNLOAD_LIMITS_UPDATED' AND actor_id=$1",
    [real.id]);
  assert.equal(audit.rows.length,4);
  for(const row of audit.rows) assert.ok([16,24,32].includes(row.after_data.zipMiB));

  // No generic app table update, including if user identity can be changed.
  await assert.rejects(
   generic.query("UPDATE public.sources SET updated_at=now() WHERE code='dou'"),
   (e:unknown)=>(e as {code?:string}).code==='42501');
  // A MAC issued while the actor was authorized cannot survive revocation.
  const signedBeforeRevocation=signedArguments(real.id,{...modified,zipMiB:18});
  await admin.query(`UPDATE public.platform_user_roles
    SET revoked_at=now(),revoked_by='ops-dl-r2-ci'
    WHERE user_id=$1 AND role='PLATFORM_ADMIN' AND revoked_at IS NULL`,[real.id]);
  const revoked=await app.inject({method:'PUT',url:path,headers:real.headers,payload:original});
  assert.equal(revoked.statusCode,403,revoked.body);
  await expectPermissionDenied(gate.query(gateSql,signedBeforeRevocation),
    'pre-signed SQL authorization must be rejected after role revocation');
  const revokedNonce=await admin.query<{n:string}>(`
    SELECT count(*)::text AS n FROM public.ops_dou_limits_used_nonces
    WHERE nonce=$1::uuid`,[signedBeforeRevocation[3]]);
  assert.equal(revokedNonce.rows[0]!.n,'0');


 }finally{
  if(sourceCreated){
   await admin.query("DELETE FROM public.sources WHERE code='dou' AND connector_key='dou'");
  }else if(oldConfig!==undefined){
   await admin.query(
    "UPDATE public.sources SET connector_config=$1::jsonb WHERE code='dou' AND connector_key='dou'",
    [JSON.stringify(oldConfig)]);
  }
  if(ids.length) await admin.query(`UPDATE public.platform_user_roles
   SET revoked_at=COALESCE(revoked_at,now()),revoked_by=COALESCE(revoked_by,'ops-dl-ci-cleanup')
   WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL`,[ids]);
  await app.close();await gate.end();await generic.end();await admin.end();
 }
});
