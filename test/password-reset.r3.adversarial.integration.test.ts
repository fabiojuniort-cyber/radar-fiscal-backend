import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { heartbeatPasswordResetWorker } from '../src/modules/auth/password-reset.worker.js';

const KEY='d'.repeat(64);
const URL_FIXED='https://trifaros.com.br/nova-senha';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const median=(input:number[])=>{
 const sorted=[...input].sort((a,b)=>a-b);
 return sorted[Math.floor(sorted.length/2)]!;
};

test('R3 adversarial B1: real PostgreSQL row locks and partial intake failures',async()=>{
 assert.equal(process.env.NODE_ENV,'test');
 const connection=process.env.DATABASE_ADMIN_URL??'';
 assert.match(connection,/radar_fiscal_test/);
 const apiUrl=new URL(process.env.DATABASE_URL!);
 const workerUrl=new URL(apiUrl);workerUrl.username='radar_worker_runtime';
 const worker=createStandaloneDatabase({connectionString:workerUrl.toString(),
   poolMax:1,idleTimeoutMs:10000,connectionTimeoutMs:5000});
 const admin=new Pool({connectionString:connection,max:3});
 const app=await buildApp({passwordReset:{
   enabled:true,publicUrl:URL_FIXED,tokenKey:KEY,
 }});
 const email='r3-lock-'+randomUUID()+'@example.test';
 const absent='r3-absent-'+randomUUID()+'@example.test';
 let uid='',tenant='';
 let holding:import('pg').PoolClient|null=null;
 const keys=[email,absent].map(x=>hash('auth-reset-v1:request-email:'+x));
 keys.push(hash('auth-reset-v1:request-ip:127.0.0.1'));
 const measure=async(address:string)=>{
   const was=process.env.NODE_ENV;
   process.env.NODE_ENV='production'; // Forces the full 1200ms floor.
   const start=performance.now();
   try{
     const response=await app.inject({
       method:'POST',url:'/auth/password/forgot',payload:{email:address},
     });
     return {status:response.statusCode,ms:Math.round(performance.now()-start)};
   }finally{process.env.NODE_ENV=was;}
 };
 try{
   await app.ready();
   assert.equal(await heartbeatPasswordResetWorker(worker,KEY,randomUUID()),true);
   const created=await app.inject({method:'POST',url:'/auth/register',payload:{
     name:'Lock Test',email,password:'Senha-Exemplo-2026!',
     confirmPassword:'Senha-Exemplo-2026!',acceptedTerms:true,
   }});
   assert.equal(created.statusCode,201,created.body);
   const identity=created.json<{user:{id:string};tenant:{id:string}}>();
   uid=identity.user.id;tenant=identity.tenant.id;

   holding=await admin.connect();
   await holding.query('BEGIN');
   await holding.query('SELECT id FROM public.app_users WHERE id=$1 FOR UPDATE',[uid]);

   // Real row lock lasting longer than the temporal floor.
   // The HTTP ingress no longer queries this table and must not wait for it.
   const known:number[]=[],unknown:number[]=[];
   const started=performance.now();
   for(let i=0;i<5;i++){
     const a=await measure(email),b=await measure(absent);
     assert.equal(a.status,202);
     assert.equal(b.status,202);
     known.push(a.ms);unknown.push(b.ms);
   }
   const elapsed=performance.now()-started;
   assert.ok(elapsed>11000,'Five pairs must exercise real 1.2 second floor');
   assert.ok(known.every(x=>x>=1100));
   assert.ok(unknown.every(x=>x>=1100));
   assert.ok(Math.abs(median(known)-median(unknown))<200,
     'PG row lock may not reveal known account');
   console.log('R3_REAL_PG_LOCK '+JSON.stringify({
     existingMs:known,missingMs:unknown,
     medianDeltaMs:median(known)-median(unknown),
     lockedRow:true,pisoTemporarioAtivo:true,
   }));
   await holding.query('COMMIT');holding.release();holding=null;

   // Register a distinct KNOWN account that has not consumed its quota.
   const faultKnown='r3-fault-known-'+randomUUID()+'@example.test';
   const faultUnknown='r3-fault-unknown-'+randomUUID()+'@example.test';
   const createdFault=await app.inject({method:'POST',url:'/auth/register',payload:{
     name:'Fault Test',email:faultKnown,password:'Senha-Exemplo-2026!',
     confirmPassword:'Senha-Exemplo-2026!',acceptedTerms:true,
   }});
   assert.equal(createdFault.statusCode,201,createdFault.body);
   const ids=createdFault.json<{user:{id:string};tenant:{id:string}}>();
   faultUid=ids.user.id;faultTenant=ids.tenant.id;
   keys.push(hash('auth-reset-v1:request-email:'+faultKnown),
     hash('auth-reset-v1:request-email:'+faultUnknown));
   // Isolated fault injection: both known and unknown must fail identically.
   await admin.query("CREATE FUNCTION public.r3_fail_neutral_insert() RETURNS trigger "+
     "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-intake-unavailable'; END $$");
   await admin.query("CREATE TRIGGER r3_force_intake_fail BEFORE INSERT "+
     "ON public.auth_password_reset_requests FOR EACH ROW EXECUTE FUNCTION "+
     "public.r3_fail_neutral_insert()");
   // Distinct emails avoid the rate-limit quota exhausted above.
   const a=await measure(faultKnown);
   const b=await measure(faultUnknown);
   assert.equal(a.status,500);
   assert.equal(b.status,500);
   assert.ok(Math.abs(a.ms-b.ms)<200,
     'Partial outbox failure cannot be conditional on account existence');
   console.log('R3_REAL_PG_ERROR '+JSON.stringify({
     knownStatus:a.status,missingStatus:b.status,
     knownMs:a.ms,missingMs:b.ms,
   }));
 }finally{
   if(holding){
     try{await holding.query('ROLLBACK');}finally{holding.release();}
   }
   await admin.query('DROP TRIGGER IF EXISTS r3_force_intake_fail ON public.auth_password_reset_requests');
   await admin.query('DROP FUNCTION IF EXISTS public.r3_fail_neutral_insert()');
   await app.close();await worker.destroy();
   if(uid)await admin.query('DELETE FROM app_users WHERE id=$1',[uid]);
   if(faultUid)await admin.query('DELETE FROM app_users WHERE id=$1',[faultUid]);
   if(tenant)await admin.query('DELETE FROM tenants WHERE id=$1',[tenant]);
   if(faultTenant)await admin.query('DELETE FROM tenants WHERE id=$1',[faultTenant]);
   await admin.query('DELETE FROM public_signup_rate_limits WHERE key_hash=ANY($1::text[])',[keys]);
   await admin.query('DELETE FROM public.auth_password_reset_requests');
   await admin.query('DELETE FROM public.auth_password_reset_worker_heartbeats');
   await admin.query('DELETE FROM public.auth_password_reset_key_state');
   await admin.end();
 }
});
