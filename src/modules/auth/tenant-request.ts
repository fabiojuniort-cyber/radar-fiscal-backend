import type { FastifyRequest } from 'fastify';
import type {
  Kysely,
  Transaction,
} from 'kysely';
import { z } from 'zod';

import type { DB } from '../../infrastructure/database/database.types.js';
import { withTenantContext } from '../../infrastructure/database/tenant-context.js';

const tenantIdSchema = z.string().uuid();

export class TenantHeaderRequiredError extends Error {
  constructor() {
    super('X-Tenant-Id header is required.');
    this.name = 'TenantHeaderRequiredError';
  }
}

export class TenantHeaderInvalidError extends Error {
  constructor() {
    super('X-Tenant-Id header must be a valid UUID.');
    this.name = 'TenantHeaderInvalidError';
  }
}

export function getTenantIdFromRequest(
  request: FastifyRequest,
): string {
  const rawTenantId = request.headers['x-tenant-id'];

  if (typeof rawTenantId !== 'string') {
    throw new TenantHeaderRequiredError();
  }

  const parsed = tenantIdSchema.safeParse(
    rawTenantId.trim(),
  );

  if (!parsed.success) {
    throw new TenantHeaderInvalidError();
  }

  return parsed.data;
}

export async function withRequestTenantContext<T>(
  db: Kysely<DB>,
  request: FastifyRequest,
  callback: (
    trx: Transaction<DB>,
    tenantId: string,
  ) => Promise<T>,
): Promise<T> {
  if (!request.auth) {
    throw new Error(
      'Authenticated request context is required.',
    );
  }

  const tenantId = getTenantIdFromRequest(request);

  return withTenantContext(
    db,
    request.auth.userId,
    tenantId,
    async (trx) => callback(trx, tenantId),
  );
}
