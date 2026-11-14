import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

test('AUTH-RESET-02: baseline temporal B1 and blocking B2 before fix', async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  const url = process.env.DATABASE_ADMIN_URL ?? '';
  assert.match(url, /radar_fiscal_test/);
  const pool = new Pool({ connectionString: url, max: 1 });
  let delay = 0, fail = false;
  const app = await buildApp({ passwordReset: {
    enabled: true, publicUrl: 'https://trifaros.com.br/nova-senha',
    send: async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (fail) throw new Error('SIMULATED_ZOHO_FAILURE');
    },
  } });
  const created: Array<{user: string; tenant: string}> = [];
  const keys: string[] = [];
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const scenarios = [
    {ms:0, fail:false},{ms:800, fail:false},
    {ms:2500, fail:false},{ms:4900, fail:false},
    {ms:2500, fail:true},
  ];
  try {
    await app.ready();
    for (const [idx, scenario] of scenarios.entries()) {
      const email='baseline-'+randomUUID()+'@example.test';
      const absent='absent-'+randomUUID()+'@example.test';
      const response=await app.inject({method:'POST',url:'/auth/register',payload:{
        name:'Conta de Teste',email,password:'Teste-Seguro-2026!',
        confirmPassword:'Teste-Seguro-2026!',acceptedTerms:true,
      }});
      assert.equal(response.statusCode,201,response.body);
      const body=response.json<{user:{id:string};tenant:{id:string}}>();
      created.push({user:body.user.id,tenant:body.tenant.id});
      delay=scenario.ms; fail=scenario.fail;
      const measure=async (target:string) => {
        const previous=process.env.NODE_ENV;
        process.env.NODE_ENV='production';
        const started=performance.now();
        try {
          const result=await app.inject({method:'POST',url:'/auth/password/forgot',payload:{email:target}});
          return {status:result.statusCode,ms:Math.round(performance.now()-started)};
        } finally {process.env.NODE_ENV=previous;}
      };
      const known=await measure(email);
      const unknown=await measure(absent);
      assert.equal(known.status,202);
      assert.equal(unknown.status,202);
      console.log('AUTH_RESET_B1_BEFORE '+JSON.stringify({
        case:idx+1,zohoDelayMs:scenario.ms,zohoFailure:scenario.fail,
        knownMs:known.ms,unknownMs:unknown.ms,deltaMs:known.ms-unknown.ms,
        temporalFloorEnabled:true,
      }));
      for(const address of [email,absent]){
        keys.push(hash('auth-reset-v1:request-email:'+address));
      }
      keys.push(hash(email));
    }
    delay=0;fail=false;
    const victim='victim-'+randomUUID()+'@example.test';
    keys.push(hash('auth-reset-v1:request-email:'+victim));
    const statuses:number[]=[];
    for(let i=0;i<6;i++){
      const result=await app.inject({method:'POST',url:'/auth/password/forgot',
        headers:{'x-forwarded-for':'198.51.100.'+(i+10)},payload:{email:victim}});
      statuses.push(result.statusCode);
    }
    console.log('AUTH_RESET_B2_BEFORE '+JSON.stringify({statuses,simulatedForwardedIps:6}));
    assert.deepEqual(statuses,[202,202,202,202,202,429]);
  } finally {
    await app.close();
    for(const row of created){
      await pool.query('DELETE FROM app_users WHERE id=$1',[row.user]);
      await pool.query('DELETE FROM tenants WHERE id=$1',[row.tenant]);
    }
    keys.push(hash('auth-reset-v1:request-ip:127.0.0.1'));
    await pool.query('DELETE FROM public_signup_rate_limits WHERE key_hash=ANY($1::text[])',[keys]);
    await pool.end();
  }
});
