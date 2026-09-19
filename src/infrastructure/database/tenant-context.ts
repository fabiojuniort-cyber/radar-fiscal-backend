import {
  sql,
  type Kysely,
  type Transaction,
} from 'kysely';

import type { DB } from './database.types.js';

export class TenantAccessDeniedError extends Error {
  constructor() {
    super('Tenant access denied.');
    this.name = 'TenantAccessDeniedError';
  }
}

async function setUserContext(
  trx: Transaction<DB>,
  userId: string,
): Promise<void> {
  await sql`
    select set_config(
      'app.user_id',
      ${userId},
      true
    )
  `.execute(trx);
}

export async function withUserContext<T>(
  db: Kysely<DB>,
  userId: string,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setUserContext(trx, userId);
    return callback(trx);
  });
}

export async function withTenantContext<T>(
  db: Kysely<DB>,
  userId: string,
  tenantId: string,
  callback: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await setUserContext(trx, userId);

    const membership = await trx
      .selectFrom('tenant_memberships')
      .innerJoin(
        'tenants',
        'tenants.id',
        'tenant_memberships.tenant_id',
      )
      .select('tenant_memberships.role')
      .where('tenant_memberships.user_id', '=', userId)
      .where('tenant_memberships.tenant_id', '=', tenantId)
      .where('tenants.status', '=', 'ACTIVE')
      .executeTakeFirst();

    if (!membership) {
      throw new TenantAccessDeniedError();
    }

    await sql`
      select set_config(
        'app.tenant_id',
        ${tenantId},
        true
      )
    `.execute(trx);

    return callback(trx);
  });
}
