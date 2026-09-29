import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  getBootstrapCounts,
  provisionInitialOwner,
} from '../src/infrastructure/database/provision-initial-owner.js';
import { verifyPassword } from '../src/modules/auth/auth.service.js';

test('initial owner is provisioned exactly once without storing plaintext', async () => {
  const databaseUrl = process.env.DATABASE_ADMIN_URL;
  assert.ok(databaseUrl, 'DATABASE_ADMIN_URL is required');
  const schema = `bootstrap_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const password = 'Only-For-Integration-2026!';
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL, slug text NOT NULL UNIQUE,
        status text NOT NULL
      );
      CREATE TABLE app_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE, status text NOT NULL
      );
      CREATE TABLE user_credentials (
        user_id uuid PRIMARY KEY REFERENCES app_users(id),
        password_hash text NOT NULL,
        password_algorithm text NOT NULL
      );
      CREATE TABLE tenant_memberships (
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        user_id uuid NOT NULL REFERENCES app_users(id),
        role text NOT NULL,
        PRIMARY KEY (tenant_id, user_id)
      );
    `);
    assert.deepEqual(await getBootstrapCounts(client), {
      tenants: 0, users: 0, credentials: 0, memberships: 0,
    });
    await assert.rejects(
      provisionInitialOwner(client, {
        email: 'owner@example.test', password: 'weak',
      }),
    );
    assert.equal((await getBootstrapCounts(client)).users, 0);

    await provisionInitialOwner(client, {
      email: '  OWNER@Example.Test  ', password,
    });
    assert.deepEqual(await getBootstrapCounts(client), {
      tenants: 1, users: 1, credentials: 1, memberships: 1,
    });
    const result = await client.query<{
      email: string; password_hash: string; role: string;
    }>(`
      SELECT u.email, c.password_hash, m.role
      FROM app_users u
      JOIN user_credentials c ON c.user_id = u.id
      JOIN tenant_memberships m ON m.user_id = u.id
    `);
    const account = result.rows[0];
    assert.ok(account);
    assert.equal(account.email, 'owner@example.test');
    assert.equal(account.role, 'OWNER');
    assert.match(account.password_hash, /^\$argon2id\$/);
    assert.ok(!account.password_hash.includes(password));
    assert.equal(await verifyPassword(account.password_hash, password), true);

    await assert.rejects(
      provisionInitialOwner(client, {
        email: 'second@example.test', password,
      }),
      /bootstrap_already_initialized/,
    );
    assert.equal((await getBootstrapCounts(client)).users, 1);
  } finally {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
