import { Pool } from 'pg';
import { z } from 'zod';

/**
 * TAX-11 operational command: grants (or revokes) the platform role
 * TAXONOMY_CURATOR to exactly one active user, identified by e-mail.
 *
 *   node dist/infrastructure/database/grant-taxonomy-curator.js --email=<e-mail> [--dry-run] [--revoke]
 *
 * Requires DATABASE_ADMIN_URL. Prints only sanitized identifiers.
 */

const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().min(1),
    TAXONOMY_CURATOR_EMAIL: z.string().email().optional(),
  })
  .parse(process.env);

const arg = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const email = (arg('email') ?? env.TAXONOMY_CURATOR_EMAIL ?? '').trim().toLowerCase();
const dryRun = process.argv.includes('--dry-run');
const revoke = process.argv.includes('--revoke');

if (!email) {
  console.error('Usage: grant-taxonomy-curator --email=<e-mail> [--dry-run] [--revoke]');
  process.exit(1);
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

const pool = new Pool({ connectionString: env.DATABASE_ADMIN_URL, max: 1 });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM app_users WHERE lower(email) = $1`,
      [email],
    );
    const active = users.rows.filter((row) => row.status === 'ACTIVE');
    if (active.length !== 1) {
      throw new Error(
        `TAXONOMY_CURATOR_USER_NOT_UNIQUE: matched=${users.rowCount} active=${active.length}`,
      );
    }
    const userId = active[0]!.id;

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM platform_user_roles
       WHERE user_id = $1 AND role = 'TAXONOMY_CURATOR' AND revoked_at IS NULL`,
      [userId],
    );

    let action: string;
    if (revoke) {
      action = existing.rowCount ? 'REVOKED' : 'NOT_GRANTED';
      if (existing.rowCount && !dryRun) {
        await client.query(
          `UPDATE platform_user_roles
           SET revoked_at = now(), revoked_by = 'system:grant-taxonomy-curator'
           WHERE id = $1`,
          [existing.rows[0]!.id],
        );
      }
    } else {
      action = existing.rowCount ? 'ALREADY_GRANTED' : 'GRANTED';
      if (!existing.rowCount && !dryRun) {
        await client.query(
          `INSERT INTO platform_user_roles (user_id, role, granted_by)
           VALUES ($1, 'TAXONOMY_CURATOR', 'system:grant-taxonomy-curator')`,
          [userId],
        );
      }
    }

    if (!dryRun && action !== 'ALREADY_GRANTED' && action !== 'NOT_GRANTED') {
      await client.query(
        `INSERT INTO audit_log (
           tenant_id, actor_type, actor_id, action, entity_type, entity_id,
           after_data, correlation_id
         ) VALUES (
           NULL, 'SYSTEM', 'system:grant-taxonomy-curator',
           $1, 'app_user', $2::uuid, $3::jsonb, gen_random_uuid()
         )`,
        [
          revoke ? 'PLATFORM_ROLE_REVOKED' : 'PLATFORM_ROLE_GRANTED',
          userId,
          JSON.stringify({ role: 'TAXONOMY_CURATOR' }),
        ],
      );
    }

    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    console.log(
      'TAXONOMY_CURATOR_GRANT=' +
        JSON.stringify({
          ok: true,
          dryRun,
          action,
          user: maskEmail(email),
          userIdPrefix: userId.slice(0, 8),
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
