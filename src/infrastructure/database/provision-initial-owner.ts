import { readFileSync } from 'node:fs';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';

import {
  hashPassword,
  normalizeEmail,
} from '../../modules/auth/auth.service.js';

const inputSchema = z.object({
  email: z.string().trim().pipe(z.email().max(320)),
  password: z.string().min(8).max(1024)
    .regex(/[a-z]/)
    .regex(/[A-Z]/)
    .regex(/[0-9]/)
    .regex(/[^a-zA-Z0-9]/),
});

const INITIAL_TENANT_NAME = 'TriBusca Internal';
const INITIAL_TENANT_SLUG = 'tribusca-internal';

export interface BootstrapCounts {
  tenants: number;
  users: number;
  credentials: number;
  memberships: number;
}

export async function getBootstrapCounts(
  client: Pick<PoolClient, 'query'>,
): Promise<BootstrapCounts> {
  const result = await client.query<{
    tenants: string;
    users: string;
    credentials: string;
    memberships: string;
  }>(`
    SELECT
      (SELECT count(*) FROM tenants)::text AS tenants,
      (SELECT count(*) FROM app_users)::text AS users,
      (SELECT count(*) FROM user_credentials)::text AS credentials,
      (SELECT count(*) FROM tenant_memberships)::text AS memberships
  `);
  const row = result.rows[0];
  if (!row) throw new Error('preflight_unavailable');
  return {
    tenants: Number(row.tenants),
    users: Number(row.users),
    credentials: Number(row.credentials),
    memberships: Number(row.memberships),
  };
}

export async function provisionInitialOwner(
  client: PoolClient,
  input: { email: string; password: string },
): Promise<void> {
  const parsed = inputSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const passwordHash = await hashPassword(parsed.password);

  await client.query('BEGIN');
  try {
    // No HTTP path calls this function. An admin DB role and an empty
    // identity store are both required before the one-time bootstrap.
    await client.query(`
      LOCK TABLE tenants, app_users, user_credentials,
        tenant_memberships IN SHARE ROW EXCLUSIVE MODE
    `);
    const counts = await getBootstrapCounts(client);
    if (Object.values(counts).some((count) => count !== 0)) {
      throw new Error('bootstrap_already_initialized');
    }

    const tenant = await client.query<{ id: string }>(`
      INSERT INTO tenants (name, slug, status)
      VALUES ($1, $2, 'ACTIVE')
      RETURNING id
    `, [INITIAL_TENANT_NAME, INITIAL_TENANT_SLUG]);
    const user = await client.query<{ id: string }>(`
      INSERT INTO app_users (email, status)
      VALUES ($1, 'ACTIVE')
      RETURNING id
    `, [email]);
    if (!tenant.rows[0] || !user.rows[0]) {
      throw new Error('bootstrap_insert_failed');
    }
    await client.query(`
      INSERT INTO user_credentials
        (user_id, password_hash, password_algorithm)
      VALUES ($1, $2, 'argon2id')
    `, [user.rows[0].id, passwordHash]);
    await client.query(`
      INSERT INTO tenant_memberships (tenant_id, user_id, role)
      VALUES ($1, $2, 'OWNER')
    `, [tenant.rows[0].id, user.rows[0].id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--preflight' && mode !== '--provision') {
    throw new Error('usage: --preflight | --provision');
  }
  const connectionString = process.env.DATABASE_ADMIN_URL;
  if (!connectionString) throw new Error('DATABASE_ADMIN_URL_required');
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    if (mode === '--preflight') {
      process.stdout.write(`${JSON.stringify(await getBootstrapCounts(client))}\n`);
      return;
    }

    // Credentials arrive only over stdin, never argv, source or logs.
    const input = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    await provisionInitialOwner(client, inputSchema.parse(input));
    process.stdout.write('initial_owner_provisioned\n');
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('provision-initial-owner.js')) {
  main().catch(() => {
    // PostgreSQL errors may contain query parameters. Never echo them.
    process.stderr.write('initial_owner_operation_failed\n');
    process.exitCode = 1;
  });
}
