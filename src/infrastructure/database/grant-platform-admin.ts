import { Pool } from 'pg';
import { z } from 'zod';

/**
 * D-070 bootstrap/ops command for PLATFORM_ADMIN.
 *
 *   npm run platform:grant-admin -- --email=<e-mail> [--dry-run] [--revoke]
 *
 * This command is intentionally the only way to create the FIRST platform
 * administrator. Later administrators may be managed in the authenticated UI.
 */
const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().min(1),
    PLATFORM_ADMIN_EMAIL: z.string().email().optional(),
  })
  .parse(process.env);

const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const email = (
  arg('email') ??
  env.PLATFORM_ADMIN_EMAIL ??
  ''
)
  .trim()
  .toLowerCase();

const dryRun = process.argv.includes('--dry-run');
const revoke = process.argv.includes('--revoke');

if (!email) {
  console.error(
    'Usage: platform:grant-admin -- --email=<e-mail> [--dry-run] [--revoke]',
  );
  process.exit(1);
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

const pool = new Pool({
  connectionString: env.DATABASE_ADMIN_URL,
  max: 1,
});

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('platform-admin-role', 0))",
    );

    const users = await client.query<{
      id: string;
      status: string;
    }>(
      `SELECT id, status
       FROM app_users
       WHERE lower(email) = $1`,
      [email],
    );

    if (users.rowCount !== 1) {
      throw new Error(
        `PLATFORM_ADMIN_USER_NOT_UNIQUE: matched=${users.rowCount}`,
      );
    }

    const target = users.rows[0]!;
    if (target.status !== 'ACTIVE' && !revoke) {
      throw new Error('PLATFORM_ADMIN_USER_INACTIVE');
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM platform_user_roles
       WHERE user_id = $1
         AND role = 'PLATFORM_ADMIN'
         AND revoked_at IS NULL`,
      [target.id],
    );

    let action: string;
    if (revoke) {
      if (!existing.rowCount) {
        action = 'NOT_GRANTED';
      } else {
        const active = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM platform_user_roles r
           JOIN app_users u ON u.id = r.user_id
           WHERE r.role = 'PLATFORM_ADMIN'
             AND r.revoked_at IS NULL
             AND u.status = 'ACTIVE'`,
        );
        if (
          target.status === 'ACTIVE' &&
          Number(active.rows[0]?.count ?? 0) <= 1
        ) {
          throw new Error('LAST_PLATFORM_ADMIN');
        }
        action = 'REVOKED';
        if (!dryRun) {
          await client.query(
            `UPDATE platform_user_roles
             SET revoked_at = now(),
                 revoked_by = 'system:grant-platform-admin'
             WHERE id = $1`,
            [existing.rows[0]!.id],
          );
        }
      }
    } else if (existing.rowCount) {
      action = 'ALREADY_GRANTED';
    } else {
      action = 'GRANTED';
      if (!dryRun) {
        await client.query(
          `INSERT INTO platform_user_roles (
             user_id, role, granted_by
           ) VALUES (
             $1, 'PLATFORM_ADMIN', 'system:grant-platform-admin'
           )`,
          [target.id],
        );
      }
    }

    if (
      !dryRun &&
      action !== 'ALREADY_GRANTED' &&
      action !== 'NOT_GRANTED'
    ) {
      await client.query(
        `INSERT INTO audit_log (
           tenant_id, actor_type, actor_id, action,
           entity_type, entity_id, before_data, after_data,
           correlation_id
         ) VALUES (
           NULL, 'SYSTEM', 'system:grant-platform-admin', $1,
           'platform_user_role', $2::text, $3::jsonb, $4::jsonb,
           gen_random_uuid()
         )`,
        [
          revoke
            ? 'PLATFORM_ROLE_REVOKED'
            : 'PLATFORM_ROLE_GRANTED',
          target.id,
          revoke
            ? JSON.stringify({ role: 'PLATFORM_ADMIN' })
            : null,
          revoke
            ? null
            : JSON.stringify({ role: 'PLATFORM_ADMIN' }),
        ],
      );
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    console.log(
      'PLATFORM_ADMIN_GRANT=' +
        JSON.stringify({
          ok: true,
          dryRun,
          action,
          user: maskEmail(email),
          userIdPrefix: target.id.slice(0, 8),
        }),
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
