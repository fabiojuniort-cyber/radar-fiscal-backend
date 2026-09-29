import { createHash } from 'node:crypto';

import { Pool } from 'pg';

import { env } from '../../config/env.js';

const SMOKE_EMAIL_PATTERN =
  'auth02-smoke-%@example.invalid';
const SMOKE_COMPANY_NAME =
  'AUTH02 Smoke Test';
const MAX_SMOKE_ACCOUNTS = 10;

function rateKey(email: string): string {
  return createHash('sha256')
    .update(
      email.trim().toLowerCase(),
      'utf8',
    )
    .digest('hex');
}

function applyRequested(): boolean {
  return process.argv.includes('--apply');
}

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString:
      env.DATABASE_ADMIN_URL ??
      env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis:
      env.DB_CONNECTION_TIMEOUT_MS,
  });

  try {
    const candidates =
      await pool.query<{
        user_id: string;
        email: string;
        tenant_id: string;
        company_name: string;
      }>(`
        SELECT
          u.id AS user_id,
          u.email,
          t.id AS tenant_id,
          p.company_name
        FROM app_users u
        JOIN tenant_memberships m
          ON m.user_id = u.id
        JOIN tenants t
          ON t.id = m.tenant_id
        JOIN tenant_onboarding_profiles p
          ON p.tenant_id = t.id
        WHERE lower(u.email)
              LIKE $1
          AND p.company_name = $2
          AND m.role = 'OWNER'
        ORDER BY u.id
      `, [
        SMOKE_EMAIL_PATTERN,
        SMOKE_COMPANY_NAME,
      ]);

    if (
      candidates.rows.length >
      MAX_SMOKE_ACCOUNTS
    ) {
      throw new Error(
        'AUTH-02 smoke cleanup guard exceeded maximum candidate count.',
      );
    }

    console.log(
      `AUTH-02 smoke cleanup preflight: ${candidates.rows.length} candidate account(s).`,
    );

    if (!applyRequested()) {
      console.log(
        'AUTH-02 smoke cleanup not applied because --apply was not provided.',
      );
      return;
    }

    if (candidates.rows.length === 0) {
      console.log(
        'AUTH-02 smoke cleanup: nothing to remove.',
      );
      return;
    }

    const userIds = [
      ...new Set(
        candidates.rows.map(
          (row) => row.user_id,
        ),
      ),
    ];
    const tenantIds = [
      ...new Set(
        candidates.rows.map(
          (row) => row.tenant_id,
        ),
      ),
    ];
    const rateKeys = [
      ...new Set(
        candidates.rows.map(
          (row) => rateKey(row.email),
        ),
      ),
    ];

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `
          DELETE FROM app_users
          WHERE id = ANY($1::uuid[])
        `,
        [userIds],
      );

      await client.query(
        `
          DELETE FROM tenants
          WHERE id = ANY($1::uuid[])
        `,
        [tenantIds],
      );

      await client.query(
        `
          DELETE
          FROM public_signup_rate_limits
          WHERE key_hash = ANY($1::text[])
        `,
        [rateKeys],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(
      `AUTH-02 smoke cleanup completed: ${userIds.length} user(s), ${tenantIds.length} tenant(s).`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'AUTH-02 smoke cleanup failed.',
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
        }
      : {
          name: 'UnknownError',
        },
  );
  process.exit(1);
});
