import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import {
  requestPasswordReset,
  type PasswordResetMessage,
} from '../src/modules/auth/password-reset.service.js';
import { processPasswordResetOutboxOnce } from '../src/modules/auth/password-reset.worker.js';

const OLD = 'Senha-Antiga-2026!';
const NEW = 'Senha-Nova-2026!';
const NEXT = 'Senha-Final-2026!';
const KEY = 'b'.repeat(64);
const RESET_URL = 'https://trifaros.com.br/nova-senha';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenFromLink = (m: PasswordResetMessage) => {
  const u = new URL(m.link);
  assert.equal(u.origin, 'https://trifaros.com.br');
  assert.equal(u.search, '');
  const t = new URLSearchParams(u.hash.substring(1)).get('token');
  assert.match(t,/^[A-Za-z0-9_-]{43}$/);
  return t!;
};

test('AUTH-RESET-02 PG: outbox, restart, retry, revocation, privilege, concurrency', async () => {
  assert.equal(process.env.NODE_ENV,'test');
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? '';
  assert.match(adminUrl,/radar_fiscal_test/);
  const runtimeUrl = new URL(process.env.DATABASE_URL!);
  const workerUrl = new URL(runtimeUrl);
  workerUrl.username = 'radar_worker_runtime';
  const dbArgs = {
    connectionString: workerUrl.toString(),
    poolMax: 2, idleTimeoutMs: 10_000, connectionTimeoutMs: 5_000,
  };
  const admin = new Pool({connectionString:adminUrl,max:2});
  const worker = createStandaloneDatabase(dbArgs);
  const worker2 = createStandaloneDatabase(dbArgs);
  const runtime = new Pool({connectionString:runtimeUrl.toString(),max:1});
  const settings = {tokenKey:KEY,publicUrl:RESET_URL};
  let app = await buildApp({passwordReset:{enabled:true,tokenKey:KEY,publicUrl:RESET_URL}});
  const inbox:PasswordResetMessage[] = [];
  const sender = async (m:PasswordResetMessage) => {inbox.push(m);};
  const unique=randomUUID();
  const email='reset02-'+unique+'@example.test';
  const unknown='missing02-'+unique+'@example.test';
  let userId='',tenantId='';
  let victimUserId='',victimTenantId='';
  const tracked:string[]=[];
  const track=(addr:string) => tracked.push(hash('auth-reset-v1:request-email:'+addr));
  const forgot=async (addr:string) => app.inject({
    method:'POST',url:'/auth/password/forgot',payload:{email:addr},
  });
  const reset=async (token:string,password=NEW) => app.inject({
    method:'POST',url:'/auth/password/reset',
    payload:{token,password,confirmPassword:password},
  });
  const login=async (password:string) => app.inject({
    method:'POST',url:'/auth/login',payload:{email,password},
  });
  const finish = async () => processPasswordResetOutboxOnce(worker,{...settings,send:sender});
  const latest = async () => {
    const result=await admin.query<{id:string;status:string;encrypted_token:string|null;nonce:string|null;auth_tag:string|null;token_hash:string;used_at:Date|null}>(
      'SELECT o.id,o.status,o.encrypted_token,o.nonce,o.auth_tag,o.token_hash,t.used_at '+
      'FROM auth_password_reset_outbox o JOIN auth_password_reset_tokens t '+
      'ON t.token_hash=o.token_hash WHERE t.user_id=$1 ORDER BY o.created_at DESC LIMIT 1',
      [userId],
    );
    assert.equal(result.rowCount,1);
    return result.rows[0]!;
  };
  try {
    await app.ready();
    const created=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'Persona Sintetica',email,password:OLD,confirmPassword:OLD,acceptedTerms:true,
    }});
    assert.equal(created.statusCode,201,created.body);
    const data=created.json<{user:{id:string};tenant:{id:string}}>();
    userId=data.user.id;tenantId=data.tenant.id;
    const logged=await login(OLD);
    assert.equal(logged.statusCode,200);
    const oldJwt=logged.json<{accessToken:string}>().accessToken;
    const cookies=logged.headers['set-cookie'];
    const cookie=(Array.isArray(cookies)?cookies[0]:cookies)?.split(';')[0];
    assert.ok(cookie);

    const a=await forgot(email),b=await forgot(unknown);
    track(email);track(unknown);
    assert.equal(a.statusCode,202);assert.equal(b.statusCode,202);
    assert.deepEqual(a.json(),b.json());
    assert.equal(inbox.length,0,'HTTP does not call sender');
    const persisted=await latest();
    assert.equal(persisted.status,'PENDING');
    assert.ok(persisted.encrypted_token);
    assert.ok(!persisted.encrypted_token!.includes('token='));
    assert.equal((await admin.query(
      "SELECT count(*)::text AS total FROM auth_password_reset_outbox WHERE status='PENDING'"
    )).rows.length,1);

    // Restart API before delivery: durable job survives process restart.
    await app.close();
    app=await buildApp({passwordReset:{enabled:true,tokenKey:KEY,publicUrl:RESET_URL}});
    await app.ready();
    assert.equal(await finish(),'ACCEPTED');
    assert.equal(inbox.length,1);
    const token1=tokenFromLink(inbox[0]!);
    const done=await latest();
    assert.equal(done.status,'ACCEPTED');
    assert.equal(done.encrypted_token,null,'Ciphertext destroyed after provider acceptance');

    const second=await forgot(email);
    assert.equal(second.statusCode,202);
    const oldReset=await reset(token1);
    assert.equal(oldReset.statusCode,400,'Superseded token cannot be redeemed');
    const t2=await latest();
    assert.equal(t2.status,'PENDING');
    // Transient failure and retry; no plaintext in DB.
    const retry=await processPasswordResetOutboxOnce(worker,{
      ...settings,send:async()=>{throw new Error('SIMULATED_SECRET_OR_ADDRESS');},
    });
    assert.equal(retry,'RETRY');
    assert.equal((await latest()).status,'PENDING');
    await admin.query(
      "UPDATE auth_password_reset_outbox SET available_at=clock_timestamp()-interval '1 sec' WHERE id=$1",
      [t2.id],
    );
    assert.equal(await finish(),'ACCEPTED');
    assert.equal(inbox.length,2);
    const token2=tokenFromLink(inbox[1]!);
    assert.equal((await reset(token2)).statusCode,204);
    assert.equal((await reset(token2)).statusCode,400);
    assert.equal((await login(OLD)).statusCode,401);
    assert.equal((await login(NEW)).statusCode,200);
    assert.equal((await app.inject({method:'GET',url:'/auth/me',headers:{
      authorization:'Bearer '+oldJwt,
    }})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/auth/refresh',headers:{
      cookie:cookie!, 'x-csrf-protection':'1',
    }})).statusCode,401);

    // Two replicas attempt same eligible job; exactly one claim/send.
    assert.equal((await forgot(email)).statusCode,202);
    const before=inbox.length;
    const contenders=await Promise.all([
      processPasswordResetOutboxOnce(worker,{...settings,send:sender}),
      processPasswordResetOutboxOnce(worker2,{...settings,send:sender}),
    ]);
    assert.equal(inbox.length,before+1);
    assert.equal(contenders.filter(x=>x==='ACCEPTED').length,1);
    const token3=tokenFromLink(inbox[inbox.length-1]!);
    assert.equal((await reset(token3,NEXT)).statusCode,204);
    assert.equal((await login(NEW)).statusCode,401);
    assert.equal((await login(NEXT)).statusCode,200);

    // Expiration before dispatch must not send.
    assert.equal((await forgot(email)).statusCode,202);
    const expired=await latest();
    await admin.query(
      "UPDATE auth_password_reset_tokens SET created_at=clock_timestamp()-interval '2 hour', "+
      "expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1",
      [expired.token_hash],
    );
    const prev=inbox.length;
    assert.equal(await finish(),'EMPTY');
    assert.equal(inbox.length,prev);
    assert.equal((await latest()).status,'EXPIRED');

    // Three failures => terminal failure, only its token invalidated.
    assert.equal((await forgot(email)).statusCode,202);
    const fatal=await latest();
    for(let i=0;i<3;i++){
      const state=await processPasswordResetOutboxOnce(worker,{
        ...settings,send:async()=>{throw new Error('MOCK_ZOHO_REJECT');},
      });
      assert.equal(state,i===2?'FAILED':'RETRY');
      if(i<2) await admin.query(
        "UPDATE auth_password_reset_outbox SET available_at=clock_timestamp()-interval '1 sec' WHERE id=$1",
        [fatal.id],
      );
    }
    assert.equal((await latest()).status,'FAILED');
    assert.ok((await latest()).used_at);
    assert.equal(inbox.length,prev);

    // B-2: attacker uses six different IPs against a REAL known e-mail.
    // The sixth attempt is silently discarded; victim HTTP stays 202.
    const victimEmail='abused-'+randomUUID()+'@example.test';
    const victimSignup=await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'Vitima Sintetica',email:victimEmail,password:OLD,
      confirmPassword:OLD,acceptedTerms:true,
    }});
    assert.equal(victimSignup.statusCode,201);
    const victimData=victimSignup.json<{user:{id:string};tenant:{id:string}}>();
    victimUserId=victimData.user.id;victimTenantId=victimData.tenant.id;
    track(victimEmail);

    await requestPasswordReset(app.db,{
      email:victimEmail,ip:'192.0.2.20',publicUrl:RESET_URL,tokenKey:KEY,
    });
    // Um worker já reivindicou o primeiro envio; nova solicitação o cancela.
    const staleClaim=await admin.query<{job_id:string;lease_id:string}>(
      'SELECT job_id,lease_id FROM public.auth_password_reset_claim(20)',
    );
    assert.equal(staleClaim.rowCount,1);
    for(const octet of [21,22,23,24,25]){
      await requestPasswordReset(app.db,{
        email:victimEmail,ip:'192.0.2.'+octet,publicUrl:RESET_URL,tokenKey:KEY,
      });
    }
    const queued=await admin.query<{total:string}>(
      'SELECT count(*)::text AS total FROM auth_password_reset_outbox o '+
      'JOIN auth_password_reset_tokens t ON t.token_hash=o.token_hash '+
      'WHERE t.user_id=$1',[victimUserId],
    );
    assert.equal(queued.rows[0]?.total,'5','Sixth IP must not enqueue sixth token');
    const staleFinish=await admin.query<{result:string}>(
      "SELECT public.auth_password_reset_finish($1::uuid,$2::uuid,false,'MOCK',0) AS result",
      [staleClaim.rows[0]?.job_id,staleClaim.rows[0]?.lease_id],
    );
    assert.equal(staleFinish.rows[0]?.result,'IGNORED',
      'Old failure must never invalidate newer token');
    const activeNew=await admin.query<{total:string}>(
      'SELECT count(*)::text AS total FROM auth_password_reset_tokens '+
      'WHERE user_id=$1 AND used_at IS NULL',[victimUserId],
    );
    assert.equal(activeNew.rows[0]?.total,'1');
    const victimResponse=await forgot(victimEmail);
    assert.equal(victimResponse.statusCode,202,
      'Victim cannot be forced to see 429 by third-party e-mail quota');
    for(const octet of [20,21,22,23,24,25]){
      tracked.push(hash('auth-reset-v1:request-ip:192.0.2.'+octet));
    }

    // C-1: falha no INSERT ao duplicar o hash precisa reverter
    // cancelamento de token/outbox anterior na MESMA transacao.
    const activeDigest=await admin.query<{token_hash:string}>(
      'SELECT token_hash FROM auth_password_reset_tokens '+
      'WHERE user_id=$1 AND used_at IS NULL',[victimUserId],
    );
    assert.equal(activeDigest.rowCount,1);
    await assert.rejects(admin.query(
      'SELECT public.auth_password_reset_issue($1,$2,$3,$4,$5,$6)',
      [victimEmail,activeDigest.rows[0]?.token_hash,1800,
        'fakeciphertext-xxxxxxxxxxxxxxxxxxxxxxxx','nonce-synthetic-xx',
        'tag-synthetic-xxxxxxxxxxxxxxx'],
    ));
    const rolledBack=await admin.query<{active:string;pending:string}>(
      "SELECT (SELECT count(*)::text FROM auth_password_reset_tokens "+
      "WHERE user_id=$1 AND used_at IS NULL) AS active, "+
      "(SELECT count(*)::text FROM auth_password_reset_outbox o "+
      "JOIN auth_password_reset_tokens t ON t.token_hash=o.token_hash "+
      "WHERE t.user_id=$1 AND o.status='PENDING') AS pending",
      [victimUserId],
    );
    assert.equal(rolledBack.rows[0]?.active,'1');
    assert.equal(rolledBack.rows[0]?.pending,'1');

    // B-3: sem proxy confiavel declarado, X-Forwarded-For do cliente
    // nunca muda a quota por request.ip.
    const forgedIp='198.51.100.244';
    const spoofed=await app.inject({
      method:'POST',url:'/auth/password/forgot',
      headers:{'x-forwarded-for':forgedIp},
      payload:{email:unknown},
    });
    assert.equal(spoofed.statusCode,202);
    const forgedKey=hash('auth-reset-v1:request-ip:'+forgedIp);
    const spoofRow=await admin.query<{total:string}>(
      'SELECT count(*)::text AS total FROM public_signup_rate_limits WHERE key_hash=$1',
      [forgedKey],
    );
    assert.equal(spoofRow.rows[0]?.total,'0',
      'Untrusted forwarded IP must not bypass raw socket quota');

    // Real role with TEMP must not shadow official app_users in SECURITY DEFINER.
    const client=await runtime.connect();
    try{
      await client.query('CREATE TEMP TABLE app_users(id UUID,email TEXT,status TEXT)');
      await client.query(
        "INSERT INTO app_users VALUES ($1,$2,'ACTIVE')",
        [userId,'shadow-'+unique+'@example.test'],
      );
      const forged=await client.query<{issued:boolean}>(
        'SELECT public.auth_password_reset_issue($1,$2,$3,$4,$5,$6) AS issued',
        ['shadow-'+unique+'@example.test',hash('malicious'),1800,'fakeciphertext-xx-xx-xx-xx-xx-xx','fakefakefakefake','fakefakefakefakefakefake'],
      );
      assert.equal(forged.rows[0]?.issued,false);
      await assert.rejects(client.query('SELECT * FROM public.auth_password_reset_tokens'));
      await assert.rejects(client.query('SELECT * FROM public.auth_password_reset_outbox'));
    } finally {client.release();}
  } finally {
    await app.close();
    await worker.destroy();await worker2.destroy();await runtime.end();
    if(userId)await admin.query('DELETE FROM app_users WHERE id=$1',[userId]);
    if(victimUserId)await admin.query('DELETE FROM app_users WHERE id=$1',[victimUserId]);
    if(tenantId)await admin.query('DELETE FROM tenants WHERE id=$1',[tenantId]);
    if(victimTenantId)await admin.query('DELETE FROM tenants WHERE id=$1',[victimTenantId]);
    const rate=[
      ...tracked,
      hash('auth-reset-v1:request-ip:127.0.0.1'),
      hash('auth-reset-v1:confirm-ip:127.0.0.1'),
      ...Array.from({length:6},(_,i)=>hash('auth-reset-v1:request-ip:192.0.2.'+(i+20))),
      hash(email),
    ];
    await admin.query('DELETE FROM public_signup_rate_limits WHERE key_hash=ANY($1::text[])',[rate]);
    await admin.end();
  }
});
