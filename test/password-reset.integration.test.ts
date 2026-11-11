import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { requestPasswordReset, passwordResetRecipientDigest, type PasswordResetMessage } from '../src/modules/auth/password-reset.service.js';
import {
  heartbeatPasswordResetWorker,
  processPasswordResetRequestOnce,
  processPasswordResetOutboxOnce,
} from '../src/modules/auth/password-reset.worker.js';

const OLD='Senha-Antiga-2026!', NEW='Senha-Nova-2026!', NEXT='Senha-Final-2026!';
const KEY='b'.repeat(64), PUBLIC_URL='https://trifaros.com.br/nova-senha';
const hash=(input:string)=>createHash('sha256').update(input).digest('hex');
const getToken=(mail:PasswordResetMessage):string=>{
  const u=new URL(mail.link);
  assert.equal(u.origin,'https://trifaros.com.br');
  assert.equal(u.search,'');
  const token=new URLSearchParams(u.hash.slice(1)).get('token');
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  return token!;
};

test('R3: persistent neutral ingress, worker concurrency, leases, revocation and RLS',async()=>{
  assert.equal(process.env.NODE_ENV,'test');
  const adminUrl=process.env.DATABASE_ADMIN_URL ?? '';
  assert.match(adminUrl,/radar_fiscal_test/);
  const apiUrl=new URL(process.env.DATABASE_URL!);
  const workerUrl=new URL(apiUrl);workerUrl.username='radar_worker_runtime';
  const args={connectionString:workerUrl.toString(),poolMax:2,
    idleTimeoutMs:10000,connectionTimeoutMs:5000};
  const worker=createStandaloneDatabase(args),worker2=createStandaloneDatabase(args);
  const admin=new Pool({connectionString:adminUrl,max:2});
  const runtime=new Pool({connectionString:apiUrl.toString(),max:1});
  const inbox:PasswordResetMessage[]=[];
  const sender=async(m:PasswordResetMessage)=>{inbox.push(m);};
  const settings={tokenKey:KEY,publicUrl:PUBLIC_URL,send:sender};
  let app=await buildApp({passwordReset:{enabled:true,tokenKey:KEY,publicUrl:PUBLIC_URL}});
  const unique=randomUUID();
  const accounts:Array<{id:string,tenant:string,email:string}>=[];
  const known='r3-user-'+unique+'@example.test';
  const absent='r3-missing-'+unique+'@example.test';
  const tracked=new Set<string>();
  const track=(e:string)=>tracked.add(hash('auth-reset-v1:request-email:'+e));
  const issue=async(email:string)=>app.inject({
    method:'POST',url:'/auth/password/forgot',payload:{email},
  });
  const reset=async(token:string,password=NEW)=>app.inject({
    method:'POST',url:'/auth/password/reset',
    payload:{token,password,confirmPassword:password},
  });
  const login=async(password:string)=>app.inject({
    method:'POST',url:'/auth/login',payload:{email:known,password},
  });
  const create=async(email:string)=>{
    const response=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'Conta Sintetica R3',email,password:OLD,confirmPassword:OLD,acceptedTerms:true,
    }});
    assert.equal(response.statusCode,201,response.body);
    const d=response.json<{user:{id:string};tenant:{id:string}}>();
    accounts.push({id:d.user.id,tenant:d.tenant.id,email});
    track(email);
    return d.user.id;
  };
  const requestOnly=async()=>{
    for(let i=0;i<12;i++){
      const state=await processPasswordResetRequestOnce(worker,settings);
      if(state==='PREPARED')return;
      if(state===null)throw Error('No request pending');
    }
    throw Error('No request prepared in 12 claims');
  };
  const deliverOne=async()=>{
    const previous=inbox.length;
    for(let i=0;i<15 && inbox.length===previous;i++){
      await processPasswordResetOutboxOnce(worker,settings);
    }
    assert.equal(inbox.length,previous+1,'Expected exactly one synthetic email');
    return getToken(inbox[inbox.length-1]!);
  };
  try{
    await app.ready();
    // Runtime fails closed before any compatible worker has heartbeated.
    const unavailable=await issue(known);
    assert.equal(unavailable.statusCode,503);
    assert.equal(await heartbeatPasswordResetWorker(worker,KEY,randomUUID()),true);
    assert.equal(await heartbeatPasswordResetWorker(worker2,'c'.repeat(64),randomUUID()),false,
      'Different AEAD key may never register as active');
    const userId=await create(known);
    const oldLogin=await login(OLD);
    assert.equal(oldLogin.statusCode,200);
    const oldJwt=oldLogin.json<{accessToken:string}>().accessToken;
    const oldCookie=oldLogin.headers['set-cookie'];
    const cookie=(Array.isArray(oldCookie)?oldCookie[0]:oldCookie)?.split(';')[0];
    assert.ok(cookie);

    const a=await issue(known),b=await issue(absent);
    track(absent);
    assert.equal(a.statusCode,202);assert.equal(b.statusCode,202);
    assert.deepEqual(a.json(),b.json());
    assert.equal(inbox.length,0);
    const neutral=await admin.query<{total:string}>(
      "SELECT count(*)::text AS total FROM auth_password_reset_requests WHERE status='PENDING'",
    );
    assert.equal(neutral.rows[0]?.total,'2');
    const noOutbox=await admin.query<{total:string}>(
      'SELECT count(*)::text AS total FROM auth_password_reset_outbox',
    );
    assert.equal(noOutbox.rows[0]?.total,'0');

    // Restart before worker processes intake; request remains durable.
    await app.close();
    app=await buildApp({passwordReset:{enabled:true,tokenKey:KEY,publicUrl:PUBLIC_URL}});
    await app.ready();
    const token1=await deliverOne();
    assert.equal((await admin.query<{count:string}>(
      "SELECT count(*)::text AS count FROM auth_password_reset_outbox WHERE status='ACCEPTED'",
    )).rows[0]?.count,'1');
    const after=await admin.query<{cipher:string|null}>(
      "SELECT encrypted_token AS cipher FROM auth_password_reset_outbox "+
      "WHERE status='ACCEPTED' LIMIT 1",
    );
    assert.equal(after.rows[0]?.cipher,null);
    // Consume unknown request (never generate or send link).
    for(let i=0;i<4;i++){
      const state=await processPasswordResetRequestOnce(worker,settings);
      if(state==='UNKNOWN')break;
    }
    assert.equal(inbox.length,1);

    // New neutral request invalidates old link before a worker prepares it.
    assert.equal((await issue(known)).statusCode,202);
    assert.equal((await reset(token1)).statusCode,400);
    await requestOnly();
    const pending=await admin.query<{id:string}>(
      "SELECT id FROM auth_password_reset_outbox WHERE status='PENDING' ORDER BY created_at DESC LIMIT 1",
    );
    assert.equal(pending.rowCount,1);
    const retry=await processPasswordResetOutboxOnce(worker,{
      ...settings,send:async()=>{throw Error('SYNTHETIC_FAILED_SEND');},
    });
    assert.equal(retry,'RETRY');
    await admin.query("UPDATE auth_password_reset_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[pending.rows[0]?.id]);
    const token2=await deliverOne();
    assert.equal((await reset(token2)).statusCode,204);
    assert.equal((await reset(token2)).statusCode,400);
    assert.equal((await login(OLD)).statusCode,401);
    assert.equal((await login(NEW)).statusCode,200);
    assert.equal((await app.inject({method:'GET',url:'/auth/me',headers:{
      authorization:'Bearer '+oldJwt,
    }})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/auth/refresh',headers:{
      cookie:cookie!,'x-csrf-protection':'1',
    }})).statusCode,401);

    // SKIP LOCKED: exactly one of two live workers sends prepared job.
    assert.equal((await issue(known)).statusCode,202);
    await requestOnly();
    const before=inbox.length;
    const contenders=await Promise.all([
      processPasswordResetOutboxOnce(worker,settings),
      processPasswordResetOutboxOnce(worker2,settings),
    ]);
    assert.equal(inbox.length,before+1);
    assert.equal(contenders.filter(x=>x==='ACCEPTED').length,1);
    const token3=getToken(inbox[inbox.length-1]!);
    assert.equal((await reset(token3,NEXT)).statusCode,204);
    assert.equal((await login(NEW)).statusCode,401);
    assert.equal((await login(NEXT)).statusCode,200);

    // Three crashes after CLAIM without beginning send do NOT consume attempts.
    assert.equal((await issue(known)).statusCode,202);
    await requestOnly();
    for(let i=0;i<3;i++){
      const c=await admin.query<{job_id:string;lease_id:string}>(
        'SELECT * FROM public.auth_password_reset_claim(6)',
      );
      assert.equal(c.rowCount,1);
      await admin.query("UPDATE auth_password_reset_outbox SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",[c.rows[0]?.job_id]);
    }
    const claimCount=await admin.query<{attempts:number}>(
      "SELECT attempt_count AS attempts FROM auth_password_reset_outbox WHERE status='CLAIMED' ORDER BY created_at DESC LIMIT 1",
    );
    assert.equal(claimCount.rows[0]?.attempts,0);
    const token4=await deliverOne();
    assert.match(token4,/^[A-Za-z0-9_-]{43}$/);

    // Lease after expiration: old ACK is rejected, later worker can reclaim.
    assert.equal((await issue(known)).statusCode,202);
    await requestOnly();
    const stale=await admin.query<{job_id:string;lease_id:string}>(
      'SELECT * FROM public.auth_password_reset_claim(6)',
    );
    assert.equal(stale.rowCount,1);
    await admin.query("UPDATE auth_password_reset_outbox SET claimed_until=clock_timestamp()-interval '1 second' WHERE id=$1",[stale.rows[0]?.job_id]);
    const ack=await admin.query<{state:string}>(
      "SELECT public.auth_password_reset_finish($1::uuid,$2::uuid,true,'SYNTHETIC',0) AS state",
      [stale.rows[0]?.job_id,stale.rows[0]?.lease_id],
    );
    assert.equal(ack.rows[0]?.state,'IGNORED');
    await deliverOne();

    // Synthetically advance the 15-minute e-mail quota window; do not
    // weaken the actual anti-abuse limit for the application.
    await admin.query(
      'DELETE FROM public_signup_rate_limits WHERE key_hash=$1',
      [hash('auth-reset-v1:request-email:'+known)],
    );

    // Expired token must not be sent; ciphertext should be destroyed by reaper.
    assert.equal((await issue(known)).statusCode,202);
    await requestOnly();
    const exp=await admin.query<{id:string;token_hash:string}>(
      "SELECT o.id,o.token_hash FROM auth_password_reset_outbox o "+
      "WHERE o.status='PENDING' ORDER BY o.created_at DESC LIMIT 1",
    );
    assert.equal(exp.rowCount,1);
    await admin.query(
      "UPDATE auth_password_reset_tokens SET expires_at=clock_timestamp()-interval '1 second',"+
      "created_at=clock_timestamp()-interval '2 hour' WHERE token_hash=$1",
      [exp.rows[0]?.token_hash],
    );
    const beforeExpiry=inbox.length;
    await processPasswordResetOutboxOnce(worker,settings);
    assert.equal(inbox.length,beforeExpiry);
    const expired=await admin.query<{status:string,encrypted_token:string|null}>(
      'SELECT status,encrypted_token FROM auth_password_reset_outbox WHERE id=$1',
      [exp.rows[0]?.id],
    );
    assert.equal(expired.rows[0]?.status,'EXPIRED');
    assert.equal(expired.rows[0]?.encrypted_token,null);

    // Deactivation after preparation cancels pending delivery.
    assert.equal((await issue(known)).statusCode,202);
    await requestOnly();
    const disabled=await admin.query<{id:string}>(
      "SELECT id FROM auth_password_reset_outbox WHERE status='PENDING' ORDER BY created_at DESC LIMIT 1",
    );
    await admin.query("UPDATE app_users SET status='INACTIVE' WHERE id=$1",[userId]);
    const beforeInactive=inbox.length;
    await processPasswordResetOutboxOnce(worker,settings);
    assert.equal(inbox.length,beforeInactive);
    assert.equal((await admin.query<{status:string}>(
      'SELECT status FROM auth_password_reset_outbox WHERE id=$1',
      [disabled.rows[0]?.id],
    )).rows[0]?.status,'CANCELLED');
    await admin.query("UPDATE app_users SET status='ACTIVE' WHERE id=$1",[userId]);

    // Six distinct IPs: known account, only five neutral requests, all 202.
    const victim='victim-'+randomUUID()+'@example.test';
    await create(victim);
    for(let i=0;i<6;i++){
      await requestPasswordReset(app.db,{
        email:victim,ip:'192.0.2.'+(10+i),
        publicUrl:PUBLIC_URL,tokenKey:KEY,
      });
      tracked.add(hash('auth-reset-v1:request-ip:192.0.2.'+(10+i)));
    }
    assert.equal((await issue(victim)).statusCode,202);
    const countVictim=await admin.query<{total:string}>(
      "SELECT count(*)::text AS total FROM auth_password_reset_requests "+
      "WHERE email_digest=$1",
      [passwordResetRecipientDigest(victim,KEY)],
    );
    assert.equal(countVictim.rows[0]?.total,'5',
      'Email quota admits exactly five neutral rows, irrespective of account');
    // Role boundaries: no direct table access or unrestricted token issuance.
    const grants=await admin.query<{
      appRead:boolean;workerRead:boolean;appIssue:boolean;workerIssue:boolean;
      appEnqueue:boolean;workerPrepare:boolean;
    }>(
      "SELECT "+
      "has_table_privilege('radar_app_runtime','public.auth_password_reset_outbox','SELECT') AS \"appRead\","+
      "has_table_privilege('radar_worker_runtime','public.auth_password_reset_outbox','SELECT') AS \"workerRead\","+
      "has_function_privilege('radar_app_runtime','public.auth_password_reset_issue(text,text,integer,text,text,text)','EXECUTE') AS \"appIssue\","+
      "has_function_privilege('radar_worker_runtime','public.auth_password_reset_issue(text,text,integer,text,text,text)','EXECUTE') AS \"workerIssue\","+
      "has_function_privilege('radar_app_runtime','public.auth_password_reset_enqueue(uuid,text,text,text,text,integer)','EXECUTE') AS \"appEnqueue\","+
      "has_function_privilege('radar_worker_runtime','public.auth_password_reset_prepare_request(uuid,uuid,text,text,text,text,text,integer)','EXECUTE') AS \"workerPrepare\""
    );
    assert.deepEqual(grants.rows[0],{
      appRead:false,workerRead:false,appIssue:false,workerIssue:false,
      appEnqueue:true,workerPrepare:true,
    });
    const client=await runtime.connect();
    try{
      await client.query('CREATE TEMP TABLE app_users(id UUID,email TEXT,status TEXT)');
      await assert.rejects(client.query(
        'SELECT * FROM public.auth_password_reset_requests'
      ));
      await assert.rejects(client.query(
        'SELECT * FROM public.auth_password_reset_outbox'
      ));
    }finally{client.release();}

  } finally {
    await app.close();await worker.destroy();await worker2.destroy();await runtime.end();
    for(const a of accounts){
      await admin.query('DELETE FROM app_users WHERE id=$1',[a.id]);
      await admin.query('DELETE FROM tenants WHERE id=$1',[a.tenant]);
    }
    tracked.add(hash('auth-reset-v1:request-ip:127.0.0.1'));
    tracked.add(hash('auth-reset-v1:confirm-ip:127.0.0.1'));
    tracked.add(hash(known));
    await admin.query('DELETE FROM public_signup_rate_limits WHERE key_hash=ANY($1::text[])',[[...tracked]]);
    await admin.end();
  }
});
