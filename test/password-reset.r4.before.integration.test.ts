import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createStandaloneDatabase } from '../src/infrastructure/database/standalone-client.js';
import { readPasswordResetQueueHealth } from '../src/modules/auth/password-reset.worker.js';

test('R4 W4 BEFORE: neutral backlog is invisible to R3 health', async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  const adminUrl=process.env.DATABASE_ADMIN_URL??'';
  assert.match(adminUrl,/radar_fiscal_test/);
  const u=new URL(process.env.DATABASE_URL!);
  u.username='radar_worker_runtime';
  const admin=new Pool({connectionString:adminUrl,max:1});
  const db=createStandaloneDatabase({
    connectionString:u.toString(),poolMax:1,
    idleTimeoutMs:10_000,connectionTimeoutMs:5_000,
  });
  const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  try {
    for(let i=0;i<4;i++){
      const isFailed=i===3;
      await admin.query(
        "INSERT INTO public.auth_password_reset_requests "+
        "(id,email_digest,encrypted_email,nonce,auth_tag,status,created_at,expires_at,updated_at) "+
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)",
        [ids[i],i.toString(16).padStart(64,'0'),
          isFailed?null:'synthetic-ciphertext-no-email',
          isFailed?null:'synthetic-nonce',
          isFailed?null:'synthetic-tag',
          isFailed?'FAILED':'PENDING',
          new Date(Date.now()-(i===0?10*60_000:60_000)),
          new Date(Date.now()+15*60_000)],
      );
    }
    const actual=(await admin.query<{
      pending:string;failed:string;oldest:string;
    }>(
      "SELECT count(*) FILTER(WHERE status='PENDING')::text AS pending,"+
      "count(*) FILTER(WHERE status='FAILED')::text AS failed,"+
      "COALESCE(EXTRACT(EPOCH FROM "+
      "(clock_timestamp()-min(created_at) FILTER(WHERE status='PENDING')))::bigint,0)::text AS oldest "+
      "FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])",
      [ids],
    )).rows[0]!;
    const oldHealth=await readPasswordResetQueueHealth(db);
    console.log('R4_W4_BEFORE '+JSON.stringify({
      neutral:{pending:Number(actual.pending),failed:Number(actual.failed),
        oldestPendingSeconds:Number(actual.oldest)},
      exposedByR3Health:oldHealth,
      fixture:'four synthetic requests; one pending aged ten minutes',
    }));
    assert.equal(Number(actual.pending),3);
    assert.equal(Number(actual.failed),1);
    assert.ok(Number(actual.oldest)>=590);
    assert.equal(oldHealth.pending,0);
    assert.equal(oldHealth.failed,0);
    assert.equal(oldHealth.oldestPendingSeconds,0);
  } finally {
    await admin.query('DELETE FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])',[ids]);
    await db.destroy();
    await admin.end();
  }
});
