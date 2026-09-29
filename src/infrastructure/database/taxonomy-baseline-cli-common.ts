import 'dotenv/config';

import { Pool } from 'pg';

export function createBaselinePool(options?: {
  requireAdmin?: boolean;
}): Pool {
  const requireAdmin = options?.requireAdmin ?? false;
  const connectionString = requireAdmin
    ? process.env.DATABASE_ADMIN_URL
    : (
        process.env.DATABASE_ADMIN_URL ??
        process.env.DATABASE_URL
      );

  if (!connectionString) {
    throw new Error(
      requireAdmin
        ? 'DATABASE_ADMIN_URL is required for taxonomy baseline import.'
        : 'DATABASE_ADMIN_URL or DATABASE_URL is required.',
    );
  }

  return new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function requiredArg(
  prefix: string,
): string {
  const arg = process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix));

  if (!arg) {
    throw new Error(
      'Missing required argument ' + prefix + '<value>',
    );
  }

  return arg.slice(prefix.length);
}
