import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { withUserContext } from '../../infrastructure/database/tenant-context.js';

export const PLATFORM_ADMIN_ROLE = 'PLATFORM_ADMIN' as const;
export const TAXONOMY_CURATOR_ROLE = 'TAXONOMY_CURATOR' as const;

export interface PlatformAccess {
  platformAdmin: boolean;
  taxonomyCurator: boolean;
  /** D-070: platform administrators are never blocked by commercial plan gates. */
  licenseBypass: boolean;
}

async function readAccessInContext(
  trx: Transaction<DB>,
  userId: string,
): Promise<PlatformAccess> {
  const result = await sql<{ role: string }>`
    SELECT role
    FROM platform_user_roles
    WHERE user_id = ${userId}::uuid
      AND revoked_at IS NULL
  `.execute(trx);

  const roles = new Set(result.rows.map((row) => row.role));
  const platformAdmin = roles.has(PLATFORM_ADMIN_ROLE);
  return {
    platformAdmin,
    taxonomyCurator: roles.has(TAXONOMY_CURATOR_ROLE),
    licenseBypass: platformAdmin,
  };
}

export async function readPlatformAccess(
  db: Kysely<DB>,
  userId: string,
): Promise<PlatformAccess> {
  return withUserContext(db, userId, (trx) =>
    readAccessInContext(trx, userId),
  );
}

export async function readPlatformAccessInContext(
  trx: Transaction<DB>,
  userId: string,
): Promise<PlatformAccess> {
  return readAccessInContext(trx, userId);
}

export async function isPlatformAdmin(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  return (await readPlatformAccess(db, userId)).platformAdmin;
}

export async function listPlatformAdministrators(
  db: Kysely<DB>,
  userId: string,
): Promise<Array<{
  userId: string;
  email: string;
  name: string | null;
  status: string;
  grantedAt: Date;
  grantedBy: string;
}>> {
  return withUserContext(db, userId, async (trx) => {
    const allowed = await sql<{ ok: boolean }>`
      SELECT app_user_is_platform_admin() AS ok
    `.execute(trx);
    if (!allowed.rows[0]?.ok) throw new Error('platform_admin_required');

    const result = await sql<{
      user_id: string;
      email: string;
      name: string | null;
      status: string;
      granted_at: Date;
      granted_by: string;
    }>`
      SELECT
        r.user_id,
        u.email,
        u.name,
        u.status,
        r.granted_at,
        r.granted_by
      FROM platform_user_roles r
      JOIN app_users u
        ON u.id = r.user_id
      WHERE r.role = ${PLATFORM_ADMIN_ROLE}
        AND r.revoked_at IS NULL
      ORDER BY lower(u.email), r.granted_at
    `.execute(trx);

    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      status: row.status,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
    }));
  });
}

export async function changePlatformAdministrator(
  db: Kysely<DB>,
  userId: string,
  email: string,
  action: 'grant' | 'revoke',
): Promise<{
  action: string;
  targetUserId: string;
  targetEmail: string;
}> {
  return withUserContext(db, userId, async (trx) => {
    const result =
      action === 'grant'
        ? await sql<{
            action: string;
            target_user_id: string;
            target_email: string;
          }>`SELECT * FROM platform_admin_grant_by_email(${email})`.execute(trx)
        : await sql<{
            action: string;
            target_user_id: string;
            target_email: string;
          }>`SELECT * FROM platform_admin_revoke_by_email(${email})`.execute(trx);

    const row = result.rows[0];
    if (!row) throw new Error('platform_admin_operation_failed');
    return {
      action: row.action,
      targetUserId: row.target_user_id,
      targetEmail: row.target_email,
    };
  });
}

export function platformAdminErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const known = new Set([
    'platform_admin_required',
    'platform_admin_email_required',
    'platform_admin_user_not_found',
    'platform_admin_user_inactive',
    'last_platform_admin',
  ]);
  return known.has(error.message) ? error.message : null;
}
