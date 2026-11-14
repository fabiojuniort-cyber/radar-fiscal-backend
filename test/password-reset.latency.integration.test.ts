import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { heartbeatPasswordResetWorker, processPasswordResetOutboxOnce } from '../src/modules/auth/password-reset.worker.js';

const KEY='e'.repeat(64);
const PUBLIC_URL='https://trifaros.com.br/nova-senha';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

test('B-1: temporal floor active and provider latency/failure cannot affect HTTP 202', async()=>{
  assert.equal(process.env.NODE_ENV,'test');
  const adminUrl=process.env.DATABASE_ADMIN_URL ?? '';
  assert.match(adminUrl,/radar_fiscal_test/);
  const workerUrl=new URL(process.env.DATABASE_URL!);
  workerUrl.username='radar_worker_runtime';
  const db=createStandaloneDatabase({
    connectionString:workerUrl.toString(),poolMax:1,
    idleTimeoutMs:10_000,connectionTimeoutMs:5_000,
  });
  const admin=new Pool({connectionString:adminUrl,max:1});
  const app=await buildApp({passwordReset:{
    enabled:true,tokenKey:KEY,publicUrl:PUBLIC_URL,
  }});
  const email='timing-'+randomUUID()+'@example.test';
  const unknown='unknown-'+randomUUID()+'@example.test';
  let userId='',tenantId='';
  const scenarios=[
    {ms:0,fail:false},{ms:800,fail:false},
    {ms:2500,fail:false},{ms:4900,fail:false},
    {ms:2500,fail:true},
  ];
  try{
    await app.ready();
    assert.equal(await heartbeatPasswordResetWorker(db,KEY,randomUUID()),true);
    const registered=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'Tester Tempo',email,password:'Senha-Segura-2026!',
      confirmPassword:'Senha-Segura-2026!',acceptedTerms:true,
    }});
    assert.equal(registered.statusCode,201,registered.body);
    const created=registered.json<{user:{id:string};tenant:{id:string}}>();
    userId=created.user.id;tenantId=created.tenant.id;
    const measure=async(target:string)=>{
      const previous=process.env.NODE_ENV;
      process.env.NODE_ENV='production'; // Ativa piso temporal real do endpoint.
      const t0=performance.now();
      try{
        const res=await app.inject({method:'POST',url:'/auth/password/forgot',
          payload:{email:target}});
        return {status:res.statusCode,ms:Math.round(performance.now()-t0)};
      }finally{process.env.NODE_ENV=previous;}
    };
    for(const [index,scenario] of scenarios.entries()){
      let sendCalls=0;
      const known=await measure(email);
      const absent=await measure(unknown);
      assert.equal(known.status,202);
      assert.equal(absent.status,202);
      assert.equal(sendCalls,0,'No Zoho call in HTTP path');
      assert.ok(Math.abs(known.ms-absent.ms)<250,'Provider timing must not reveal account');
      assert.ok(known.ms>=1150 && absent.ms>=1150,'Temporal floor is active');
      let workerResult: string='EMPTY';
      for(let n=0;n<12 && sendCalls===0;n++){
        workerResult=await processPasswordResetOutboxOnce(db,{
          tokenKey:KEY,publicUrl:PUBLIC_URL,
          send:async()=>{
            sendCalls++;
            await new Promise((resolve)=>setTimeout(resolve,scenario.ms));
            if(scenario.fail)throw new Error('MOCK_ZOHO_FAIL');
          },
        });
      }
      assert.equal(sendCalls,1,'Durable worker handles provider separately');
      assert.equal(workerResult,scenario.fail?'RETRY':'ACCEPTED');
      console.log('AUTH_RESET_B1_AFTER '+JSON.stringify({
        case:index+1,zohoDelayMs:scenario.ms,zohoFailure:scenario.fail,
        knownMs:known.ms,unknownMs:absent.ms,deltaMs:known.ms-absent.ms,
        workerOutcome:workerResult,temporalFloorEnabled:true,
      }));
    }
  }finally{
    await app.close();await db.destroy();
    if(userId)await admin.query('DELETE FROM app_users WHERE id=$1',[userId]);
    if(tenantId)await admin.query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    const keys=[
      hash(email),hash('auth-reset-v1:request-email:'+email),
      hash('auth-reset-v1:request-email:'+unknown),
      hash('auth-reset-v1:request-ip:127.0.0.1'),
    ];
    await admin.query('DELETE FROM public_signup_rate_limits WHERE key_hash=ANY($1::text[])',[keys]);
    // Synthetic disposable database only: isolate AEAD fingerprint and
    // neutral inbox between successive suites with distinct fake test keys.
    await admin.query('DELETE FROM public.auth_password_reset_requests');
    await admin.query('DELETE FROM public.auth_password_reset_worker_heartbeats');
    await admin.query('DELETE FROM public.auth_password_reset_key_state');
    await admin.end();
  }
});
