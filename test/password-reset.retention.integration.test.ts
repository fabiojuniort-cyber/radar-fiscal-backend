import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

const hour = 3600000;
const day = 24 * hour;

test('retention keeps live reset work and reports only aggregates', async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!);
  assert.equal(adminUrl.pathname, '/radar_fiscal_test');
  assert.ok(['localhost', '127.0.0.1'].includes(adminUrl.hostname));
  const pool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  const app = await buildApp();
  const client = await pool.connect();
  let userId = '';
  let tenantId = '';
  try {
    const register = await app.inject({
      method: 'POST', url: '/auth/register', payload: {
        name: 'Retention Synthetic', email: randomUUID() + '@example.test',
        password: 'Senha-Exemplo-2026!', confirmPassword: 'Senha-Exemplo-2026!',
        acceptedTerms: true,
      },
    });
    assert.equal(register.statusCode, 201);
    const identity = register.json<{user: {id: string}; tenant: {id: string}}>();
    userId = identity.user.id;
    tenantId = identity.tenant.id;
    assert.equal((await client.query(`
      SELECT has_function_privilege('radar_app_runtime',
        'public.auth_password_reset_retention(integer,integer,integer,integer,boolean)', 'EXECUTE')
        OR has_function_privilege('radar_worker_runtime',
        'public.auth_password_reset_retention(integer,integer,integer,integer,boolean)', 'EXECUTE') AS allowed
    `)).rows[0].allowed, false);
    const now = Date.now();
    const date = (offset: number) => new Date(now + offset);
    const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
    const token = async (expiry: number, used: number | null = null) => {
      const id = hash();
      await client.query(`
        INSERT INTO public.auth_password_reset_tokens(token_hash,user_id,created_at,expires_at,used_at)
        VALUES ($1,$2,$3,$4,$5)
      `, [id, userId, date(-9 * day), date(expiry), used === null ? null : date(used)]);
      return id;
    };
    const delivery = async (id: string, status: string, age: number) => {
      const active = ['PENDING', 'CLAIMED'].includes(status);
      await client.query(`
        INSERT INTO public.auth_password_reset_outbox
          (token_hash,status,encrypted_token,nonce,auth_tag,created_at,updated_at,available_at,claim_id,claimed_until)
        VALUES ($1,$2,$3,$3,$3,$4,$4,$5,$6,$7)
      `, [id, status, active ? 'synthetic' : null, date(-age), date(hour),
        status === 'CLAIMED' ? randomUUID() : null, status === 'CLAIMED' ? date(hour) : null]);
    };
    const request = async (age: number) => {
      const id = randomUUID();
      await client.query(`
        INSERT INTO public.auth_password_reset_requests(id,email_digest,status,created_at,updated_at,expires_at)
        VALUES ($1,$2,'UNKNOWN',$3,$3,$4)
      `, [id, hash(), date(-age), date(hour)]);
      return id;
    };
    const oldRequest = await request(7 * day + hour);
    const newRequest = await request(7 * day - hour);
    const old = await token(-25 * hour);
    const used = await token(hour, -25 * hour);
    const recent = await token(-23 * hour);
    const valid = await token(hour);
    const recentOutbox = await token(-25 * hour);
    const retry = await token(-25 * hour);
    const claimed = await token(-25 * hour);
    await delivery(old, 'ACCEPTED', 7 * day + hour);
    await delivery(recentOutbox, 'FAILED', 7 * day - hour);
    await delivery(retry, 'PENDING', 8 * day);
    await delivery(claimed, 'CLAIMED', 8 * day);

    const sweep = async (dryRun: boolean) => (await client.query(`
      SELECT * FROM public.auth_password_reset_retention(7, 7, 24, 1, $1)
    `, [dryRun])).rows[0];
    const hasToken = async (id: string) => (await client.query(
      'SELECT 1 FROM public.auth_password_reset_tokens WHERE token_hash=$1', [id],
    )).rowCount === 1;
    const hasOutbox = async (id: string) => (await client.query(
      'SELECT 1 FROM public.auth_password_reset_outbox WHERE token_hash=$1', [id],
    )).rowCount === 1;
    const dry = await sweep(true);
    assert.deepEqual([dry.requests, dry.outbox, dry.tokens, dry.tokens_deferred,
      dry.tokens_waiting_active_outbox], ['1', '1', '2', '3', '2']);
    assert.ok(Number(dry.oldest_waiting_active_seconds) >= 8 * 86400);
    assert.ok(await hasToken(old) && await hasOutbox(old));
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM public.auth_password_reset_outbox WHERE token_hash=$1 FOR UPDATE', [old]);
      const locked = await sweep(false);
      assert.equal(locked.outbox, '0');
      assert.equal(locked.tokens, '1');
      assert.ok(await hasToken(old) && await hasOutbox(old));
      assert.equal(await hasToken(used), false);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    const final = await sweep(false);
    assert.deepEqual([final.outbox, final.tokens], ['1', '1']);
    assert.equal(await hasOutbox(old), false);
    assert.equal(await hasToken(old), false);
    for (const id of [recent, valid, recentOutbox, retry, claimed]) assert.ok(await hasToken(id));
    for (const id of [recentOutbox, retry, claimed]) assert.ok(await hasOutbox(id));
    const requests = await client.query(
      'SELECT id FROM public.auth_password_reset_requests WHERE id=ANY($1::uuid[])',
      [[oldRequest, newRequest]],
    );
    assert.deepEqual(requests.rows.map(row => row.id), [newRequest]);
    const repeat = await sweep(false);
    assert.deepEqual([repeat.requests, repeat.outbox, repeat.tokens, repeat.tokens_deferred],
      ['0', '0', '0', '3']);
    console.log('AUTH_RESET_RETENTION aggregate=' + JSON.stringify(repeat));
    await client.query('DELETE FROM public.auth_password_reset_requests WHERE id=$1', [newRequest]);
  } finally {
    if (userId) await client.query('DELETE FROM public.app_users WHERE id=$1', [userId]);
    if (tenantId) await client.query('DELETE FROM public.tenants WHERE id=$1', [tenantId]);
    client.release();
    await app.close();
    await pool.end();
  }
});
