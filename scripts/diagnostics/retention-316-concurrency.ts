import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { buildApp } from '../../src/app.js';

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const url = new URL(process.env.DATABASE_ADMIN_URL!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/radar_fiscal_test');
  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const app = await buildApp();
  const cleaner = await pool.connect();
  const writer = await pool.connect();
  const tokenHashes: string[] = [];
  try {
    const signup = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      name: 'Retention CI', email: randomUUID() + '@example.test',
      password: 'Senha-Exemplo-2026!', confirmPassword: 'Senha-Exemplo-2026!',
      acceptedTerms: true,
    } });
    assert.equal(signup.statusCode, 201);
    const user = signup.json<{ user: { id: string } }>().user.id;
    const version = (await cleaner.query('SHOW server_version_num')).rows[0].server_version_num;
    assert.equal(Math.floor(Number(version) / 10000), Number(process.env.DIAG_PG_MAJOR));
    await cleaner.query("SET statement_timeout = '20s'");
    await writer.query("SET statement_timeout = '20s'");
    const cleanerPid = (await cleaner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(cleanerPid, writerPid);

    const insert = (hash: string) => writer.query(`
      INSERT INTO public.auth_password_reset_outbox(token_hash, encrypted_token, nonce, auth_tag)
      VALUES ($1, 'synthetic', 'synthetic', 'synthetic') RETURNING status
    `, [hash]);
    const sweep = async () => (await cleaner.query(`
      SELECT tokens::int AS tokens, outbox::int AS outbox
      FROM public.auth_password_reset_retention(7, 7, 24, 1, false)
    `)).rows[0];
    const state = async (hash: string) => (await cleaner.query(`
      SELECT EXISTS (SELECT 1 FROM public.auth_password_reset_tokens WHERE token_hash=$1) AS token,
             (SELECT status FROM public.auth_password_reset_outbox WHERE token_hash=$1) AS outbox
    `, [hash])).rows[0];
    for (const order of ['insert_first', 'cleanup_first'] as const) {
      for (const resolution of ['COMMIT', 'ROLLBACK'] as const) {
        const hash = randomBytes(32).toString('hex');
        tokenHashes.push(hash);
        await cleaner.query(`
          INSERT INTO public.auth_password_reset_tokens(token_hash, user_id, created_at, expires_at)
          VALUES ($1, $2, now() - interval '3 days', now() - interval '2 days')
        `, [hash, user]);
        assert.deepEqual(await state(hash), { token: true, outbox: null });
        let waited = false;
        let skipped = false;
        let sqlstate = '00000';
        let removed: number;
        if (order === 'insert_first') {
          await writer.query('BEGIN');
          assert.equal((await insert(hash)).rows[0].status, 'PENDING');
          assert.deepEqual(await state(hash), { token: true, outbox: null });
          const result = await sweep();
          assert.deepEqual(result, { tokens: 0, outbox: 0 });
          skipped = true;
          await writer.query(resolution);
          removed = (await sweep()).tokens;
          assert.equal(removed, resolution === 'COMMIT' ? 0 : 1);
        } else {
          await cleaner.query('BEGIN');
          const result = await sweep();
          assert.deepEqual(result, { tokens: 1, outbox: 0 });
          assert.deepEqual(await state(hash), { token: false, outbox: null });
          await writer.query('BEGIN');
          const pending = insert(hash).then(
            value => ({ code: '00000', status: value.rows[0].status }),
            (error: { code: string }) => ({ code: error.code, status: null }),
          );
          try {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              const result = await cleaner.query(
                'SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
                [cleanerPid, writerPid],
              );
              if (result.rows[0].blocked) { waited = true; break; }
              await delay(25);
            }
            assert.equal(waited, true, 'FK SESSION MUST WAIT ON CLEANER');
          } finally {
            await cleaner.query(waited ? resolution : 'ROLLBACK');
            const outcome = await pending;
            sqlstate = outcome.code;
            await writer.query(sqlstate === '00000' ? 'COMMIT' : 'ROLLBACK');
            assert.equal(sqlstate, resolution === 'COMMIT' && waited ? '23503' : '00000');
            assert.equal(outcome.status, sqlstate === '00000' ? 'PENDING' : null);
          }
          removed = resolution === 'COMMIT' ? 1 : 0;
        }
        const final = await state(hash);
        const survives = order === 'insert_first' ? resolution === 'COMMIT' : resolution === 'ROLLBACK';
        assert.deepEqual(final, { token: survives, outbox: survives ? 'PENDING' : null });
        console.log('RETENTION_CONCURRENCY ' + JSON.stringify({
          version, order, resolution, waited, skipped, sqlstate, removed, final,
        }));
        // Remove synthetic fixture so each sweep has one candidate.
        await cleaner.query('DELETE FROM public.auth_password_reset_tokens WHERE token_hash=$1', [hash]);
      }
    }
  } finally {
    await writer.query('ROLLBACK');
    await cleaner.query('ROLLBACK');
    for (const hash of tokenHashes) {
      await cleaner.query('DELETE FROM public.auth_password_reset_tokens WHERE token_hash=$1', [hash]);
    }
    writer.release();
    cleaner.release();
    await app.close();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
