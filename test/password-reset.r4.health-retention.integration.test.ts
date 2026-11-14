import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  encryptResetRecipient, passwordResetRecipientDigest,
} from '../src/modules/auth/password-reset.service.js';
import {
  readPasswordResetQueueHealth,
  processPasswordResetRequestOnce,
  passwordResetQueueWarningCodes,
} from '../src/modules/auth/password-reset.worker.js';

const KEY='a'.repeat(64);
const PUBLIC_URL='https://trifaros.com.br/nova-senha';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const day=86400_000;
const minute=60_000;

test('AUTH-RESET-04 R4: two-stage health, failure, pause, reaper, recovery and retention',async()=>{
  assert.equal(process.env.NODE_ENV,'test');
  const adminUrl=process.env.DATABASE_ADMIN_URL ?? '';
  assert.match(adminUrl,/radar_fiscal_test/);
  const appUrl=new URL(process.env.DATABASE_URL!);
  const workerUrl=new URL(appUrl);workerUrl.username='radar_worker_runtime';
  const admin=new Pool({connectionString:adminUrl,max:2});
  let worker=createStandaloneDatabase({
    connectionString:workerUrl.toString(),poolMax:1,
    idleTimeoutMs:10_000,connectionTimeoutMs:5_000,
  });
  const app=await buildApp();
  const fixtureIds:string[]=[];
  const tokenDigests:string[]=[];
  let userId='',tenantId='';
  const newRequest=async(
    state:'PENDING'|'CLAIMED'|'PREPARED'|'UNKNOWN'|'SUPERSEDED'|'EXPIRED'|'FAILED',
    created:Date,updated:Date,digest?:string,
  )=>{
    const id=randomUUID(),email='r4-'+id+'@example.test';
    const active=state==='PENDING'||state==='CLAIMED';
    const secret=active?encryptResetRecipient(email,id,KEY):null;
    const dd=digest??passwordResetRecipientDigest(email,KEY);
    await admin.query(
      'INSERT INTO public.auth_password_reset_requests '+
      '(id,email_digest,encrypted_email,nonce,auth_tag,status,created_at,updated_at,expires_at,claim_id,claimed_until) '+
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id,dd,secret?.ciphertext??null,secret?.nonce??null,
       secret?.authTag??null,state,created,updated,
       new Date(Date.now()+20*minute),
       state==='CLAIMED'?randomUUID():null,
       state==='CLAIMED'?new Date(Date.now()+20_000):null],
    );
    fixtureIds.push(id);
    return id;
  };
  try {
    await app.ready();
    const reg=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'R4 Health Synthetic',email:'r4-health-'+randomUUID()+'@example.test',
      password:'Senha-Exemplo-2026!',confirmPassword:'Senha-Exemplo-2026!',
      acceptedTerms:true,
    }});
    assert.equal(reg.statusCode,201,reg.body);
    const identity=reg.json<{user:{id:string};tenant:{id:string}}>();
    userId=identity.user.id;tenantId=identity.tenant.id;

    const deliveryDigest=passwordResetRecipientDigest(
      'synthetic-delivery-'+randomUUID()+'@example.test',KEY,
    );
    for(let i=0;i<2;i++){
      const digest=sha('synthetic-r4-delivery-'+randomUUID());
      tokenDigests.push(digest);
      await admin.query(
        'INSERT INTO public.auth_password_reset_tokens '+
        '(token_hash,user_id,expires_at,email_digest) VALUES ($1,$2,$3,$4)',
        [digest,userId,new Date(Date.now()+25*minute),deliveryDigest],
      );
      const state=i===0?'PENDING':'FAILED';
      await admin.query(
        'INSERT INTO public.auth_password_reset_outbox '+
        '(id,token_hash,status,encrypted_token,nonce,auth_tag,created_at,updated_at) '+
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
        [randomUUID(),digest,state,
          i===0?'synthetic-token-cipher':null,
          i===0?'synthetic-iv':null,i===0?'synthetic-tag':null,
          new Date(Date.now()-(i===0?3*minute:minute))],
      );
    }
    const now=Date.now();
    const agedId=await newRequest('PENDING',new Date(now-10*minute),new Date(now-10*minute));
    await newRequest('PENDING',new Date(now-minute),new Date(now-minute));
    await newRequest('PENDING',new Date(now-minute),new Date(now-minute));
    await newRequest('CLAIMED',new Date(now-minute),new Date(now-minute));
    await newRequest('FAILED',new Date(now-minute),new Date(now-minute));

    // No worker loop at all: health must still expose both-stage backlog.
    const paused=await readPasswordResetQueueHealth(worker);
    assert.equal(paused.neutral.pending,3);
    assert.equal(paused.neutral.claimed,1);
    assert.equal(paused.neutral.failed,1);
    assert.ok(paused.neutral.oldestPendingSeconds>=590);
    assert.equal(paused.delivery.pending,1);
    assert.equal(paused.delivery.failed,1);
    assert.ok(paused.delivery.oldestPendingSeconds>=170);
    const alerts=passwordResetQueueWarningCodes(paused,2,0);
    assert.ok(alerts.includes('NEUTRAL_FAILED'));
    assert.ok(alerts.includes('NEUTRAL_PENDING_AGED'));
    assert.ok(alerts.includes('NEUTRAL_CLAIM_PERSISTENT'));
    assert.ok(alerts.includes('DELIVERY_FAILED'));
    assert.ok(alerts.includes('DELIVERY_PENDING_AGED'));
    console.log('R4_W4_AFTER '+JSON.stringify({pausedWorker:true,health:paused,alerts}));

    // Restart worker connection; durable metrics must survive process death.
    await worker.destroy();
    worker=createStandaloneDatabase({connectionString:workerUrl.toString(),
      poolMax:1,idleTimeoutMs:10_000,connectionTimeoutMs:5_000});
    assert.equal((await readPasswordResetQueueHealth(worker)).neutral.pending,3);

    // Reaper only expires the chosen aged request and destroys ciphertext.
    await admin.query(
      "UPDATE public.auth_password_reset_requests "+
      "SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[agedId],
    );
    await admin.query('SELECT public.auth_password_reset_reap()');
    const reaped=await admin.query<{status:string;cipher:string|null}>(
      'SELECT status,encrypted_email AS cipher FROM public.auth_password_reset_requests WHERE id=$1',
      [agedId],
    );
    assert.equal(reaped.rows[0]?.status,'EXPIRED');
    assert.equal(reaped.rows[0]?.cipher,null);
    assert.equal((await readPasswordResetQueueHealth(worker)).neutral.pending,2);

    // Preparation recovery for a synthetic nonexistent account (no send).
    const state=await processPasswordResetRequestOnce(worker,{
      tokenKey:KEY,publicUrl:PUBLIC_URL,
      send:async()=>{throw Error('NEVER_SEND_R4_FIXTURE');},
    });
    assert.equal(state,'UNKNOWN');
    const recovered=await readPasswordResetQueueHealth(worker);
    assert.equal(recovered.neutral.pending,1);
    assert.equal(recovered.neutral.claimed,1);
    assert.equal(recovered.neutral.failed,1);
    console.log('R4_W4_RECOVER '+JSON.stringify({health:recovered,outcome:state}));

    // RET candidate: 30 days is a TEST PARAMETER, NOT an approved policy.
    const old=new Date(Date.now()-31*day);
    const recent=new Date(Date.now()-day);
    const oldUnknown=await newRequest('UNKNOWN',old,old);
    const oldFailed=await newRequest('FAILED',old,old);
    const recentTerm=await newRequest('PREPARED',recent,recent);
    const pendingOld=await newRequest('PENDING',old,old);
    const claimedOld=await newRequest('CLAIMED',old,old);
    const protectedTerminal=await newRequest('UNKNOWN',old,old,deliveryDigest);

    const access=await admin.query<{app:boolean;worker:boolean}>(
      "SELECT "+
      "has_function_privilege('radar_app_runtime',"+
      "'public.auth_password_reset_purge_terminal(integer,boolean)','EXECUTE') AS app,"+
      "has_function_privilege('radar_worker_runtime',"+
      "'public.auth_password_reset_purge_terminal(integer,boolean)','EXECUTE') AS worker",
    );
    assert.equal(access.rows[0]?.app,false);
    assert.equal(access.rows[0]?.worker,false);

    const dry=await admin.query<{count:string}>(
      'SELECT public.auth_password_reset_purge_terminal(30,TRUE)::text AS count',
    );
    assert.equal(dry.rows[0]?.count,'2');
    assert.equal((await admin.query<{n:string}>(
      'SELECT count(*)::text AS n FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])',
      [[oldUnknown,oldFailed]],
    )).rows[0]?.n,'2','Dry run cannot delete');
    await assert.rejects(admin.query(
      'SELECT public.auth_password_reset_purge_terminal(0,FALSE)',
    ));
    const purged=await admin.query<{count:string}>(
      'SELECT public.auth_password_reset_purge_terminal(30,FALSE)::text AS count',
    );
    assert.equal(purged.rows[0]?.count,'2');
    const remaining=await admin.query<{id:string}>(
      'SELECT id FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])',
      [[oldUnknown,oldFailed,recentTerm,pendingOld,claimedOld,protectedTerminal]],
    );
    const kept=new Set(remaining.rows.map(r=>r.id));
    assert.ok(!kept.has(oldUnknown)&&!kept.has(oldFailed));
    for(const id of [recentTerm,pendingOld,claimedOld,protectedTerminal]){
      assert.ok(kept.has(id),'Recent/active/linked request must survive');
    }
    console.log('R4_RET_CANDIDATE '+JSON.stringify({
      simulatedRetentionDays:30,dryRun:Number(dry.rows[0]?.count),
      deleted:Number(purged.rows[0]?.count),recentKept:true,
      activeKept:true,linkedActiveTokenKept:true,
    }));
  } finally {
    await admin.query(
      'DELETE FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])',
      [fixtureIds],
    );
    if(userId)await admin.query('DELETE FROM public.app_users WHERE id=$1',[userId]);
    if(tenantId)await admin.query('DELETE FROM public.tenants WHERE id=$1',[tenantId]);
    await worker.destroy();
    await app.close();
    await admin.end();
  }
});
