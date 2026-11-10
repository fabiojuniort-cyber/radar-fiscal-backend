import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { buildApp } from '../src/app.js';
import type { PasswordResetMessage } from '../src/modules/auth/password-reset.service.js';

const OLD_PASSWORD = 'Senha-Antiga-2026!';
const NEW_PASSWORD = 'Senha-Nova-2026!';
const THIRD_PASSWORD = 'Senha-Final-2026!';

function hash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function tokenFromSimulatedInbox(message: PasswordResetMessage): string {
  const url = new URL(message.link);
  assert.equal(url.origin, 'https://trifaros.com.br');
  assert.equal(url.pathname, '/nova-senha');
  assert.equal(url.search, '');
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  return token!;
}

test('AUTH-RESET isolated complete contract: request, inbox, link, password, revoke, replay, limits', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(adminUrl, 'DATABASE_ADMIN_URL required (disposable PostgreSQL only).');
  assert.equal(process.env.NODE_ENV, 'test', 'Do not run against production.');
  assert.ok(/radar_fiscal_test/.test(adminUrl), 'Isolated test database required.');

  const inbox: PasswordResetMessage[] = [];
  const app = await buildApp({
    passwordReset: {
      enabled: true,
      publicUrl: 'https://trifaros.com.br/nova-senha',
      send: async (message) => { inbox.push(message); },
    },
  });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });

  const unique = randomUUID();
  const email = 'reset-' + unique + '@example.test';
  const absentEmail = 'absent-' + unique + '@example.test';
  const limitedEmail = 'limited-' + unique + '@example.test';
  let userId = '';
  let tenantId = '';

  const request = async (address: string) => app.inject({
    method: 'POST',
    url: '/auth/password/forgot',
    payload: { email: address },
  });
  const reset = async (token: string, password = NEW_PASSWORD) => app.inject({
    method: 'POST',
    url: '/auth/password/reset',
    payload: { token, password, confirmPassword: password },
  });
  const login = async (password: string) => app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });

  try {
    await app.ready();

    const created = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Usuário de Teste Reset',
        email,
        password: OLD_PASSWORD,
        confirmPassword: OLD_PASSWORD,
        acceptedTerms: true,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const registration = created.json<{
      user: { id: string };
      tenant: { id: string };
    }>();
    userId = registration.user.id;
    tenantId = registration.tenant.id;

    const oldSession = await login(OLD_PASSWORD);
    assert.equal(oldSession.statusCode, 200, oldSession.body);
    const oldJwt = oldSession.json<{ accessToken: string }>().accessToken;
    const refreshHeader = oldSession.headers['set-cookie'];
    assert.ok(refreshHeader);
    const cookiePair = (Array.isArray(refreshHeader) ?
      refreshHeader[0] : refreshHeader).split(';')[0];
    assert.equal((await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: 'Bearer ' + oldJwt },
    })).statusCode, 200);

    const known = await request(email);
    const unknown = await request(absentEmail);
    assert.equal(known.statusCode, 202);
    assert.equal(unknown.statusCode, 202);
    assert.deepEqual(known.json(), unknown.json());
    assert.equal(inbox.length, 1, 'Unknown email must not send any message.');
    assert.equal(inbox[0]?.to, email);
    const token1 = tokenFromSimulatedInbox(inbox[0]!);

    const second = await request(email);
    assert.equal(second.statusCode, 202);
    assert.equal(inbox.length, 2);
    assert.equal((await reset(token1)).statusCode, 400,
      'New request must invalidate older link.');

    const token2 = tokenFromSimulatedInbox(inbox[1]!);
    const tokenHash2 = hash(token2);
    await admin.query(
      "UPDATE auth_password_reset_tokens " +
      "SET created_at = clock_timestamp() - interval '2 hours', " +
      "expires_at = clock_timestamp() - interval '1 hour' " +
      "WHERE token_hash = $1",
      [tokenHash2],
    );
    assert.equal((await reset(token2)).statusCode, 400,
      'Expired link must fail.');
    assert.equal((await login(OLD_PASSWORD)).statusCode, 200,
      'Invalid link must not change password.');

    const third = await request(email);
    assert.equal(third.statusCode, 202);
    const token3 = tokenFromSimulatedInbox(inbox[2]!);

    const applied = await reset(token3);
    assert.equal(applied.statusCode, 204, applied.body);
    assert.equal((await reset(token3)).statusCode, 400,
      'Token must be single use.');
    assert.equal((await login(OLD_PASSWORD)).statusCode, 401);
    assert.equal((await login(NEW_PASSWORD)).statusCode, 200);

    const after = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: 'Bearer ' + oldJwt },
    });
    assert.equal(after.statusCode, 401, 'Old access token must fail.');

    const refresh = await app.inject({
      method: 'POST', url: '/auth/refresh',
      headers: { cookie: cookiePair, 'x-csrf-protection': '1' },
    });
    assert.equal(refresh.statusCode, 401, 'Old refresh cookie must fail.');

    const revoked = await admin.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM auth_sessions " +
      "WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
    assert.equal(revoked.rows[0]?.total, '1',
      'Only new login session should remain valid.');

    const fourth = await request(email);
    assert.equal(fourth.statusCode, 202);
    const token4 = tokenFromSimulatedInbox(inbox[3]!);
    const race = await Promise.all([
      reset(token4, THIRD_PASSWORD),
      reset(token4, THIRD_PASSWORD),
    ]);
    assert.deepEqual(race.map((x) => x.statusCode).sort(), [204, 400],
      'Only one concurrent redeemer may succeed.');
    assert.equal((await login(NEW_PASSWORD)).statusCode, 401);
    assert.equal((await login(THIRD_PASSWORD)).statusCode, 200);

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await request(limitedEmail)).statusCode, 202);
    }
    const limited = await request(limitedEmail);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: 'too_many_requests' });
    assert.ok(Number(limited.headers['retry-after']) >= 1);
  } finally {
    await app.close();
    if (userId) await admin.query('DELETE FROM app_users WHERE id = $1', [userId]);
    if (tenantId) await admin.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    const rateKeys = [email, absentEmail, limitedEmail].map((address) =>
      hash('auth-reset-v1:request-email:' + address),
    );
    rateKeys.push(hash('auth-reset-v1:request-ip:127.0.0.1'));
    rateKeys.push(hash('auth-reset-v1:confirm-ip:127.0.0.1'));
    rateKeys.push(hash(email));
    await admin.query(
      'DELETE FROM public_signup_rate_limits WHERE key_hash = ANY($1::text[])',
      [rateKeys],
    );
    await admin.end();
  }
});
