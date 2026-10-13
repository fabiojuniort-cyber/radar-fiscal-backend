import type { FastifyBaseLogger } from 'fastify';
import { Pool } from 'pg';

import { env } from '../../config/env.js';
import { resolveCuratorDatabaseUrl as resolveFromSource } from './curator-url.js';

export { CURATOR_RUNTIME_ROLE } from './curator-url.js';

export function resolveCuratorDatabaseUrl(
  source: Parameters<typeof resolveFromSource>[0] = env,
): string | null {
  return resolveFromSource(source);
}

export function createCuratorPool(
  logger: FastifyBaseLogger,
): Pool | null {
  const connectionString = resolveCuratorDatabaseUrl();
  if (!connectionString) return null;

  const pool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  pool.on('error', (error) => {
    logger.error(
      { err: error },
      'Unexpected PostgreSQL curator pool error',
    );
  });

  return pool;
}
