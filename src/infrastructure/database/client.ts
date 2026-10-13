import type { FastifyBaseLogger } from 'fastify';
import {
  Kysely,
  PostgresDialect,
  sql,
} from 'kysely';
import { Pool } from 'pg';

import { env } from '../../config/env.js';
import type { DB } from './database.types.js';

export function createDatabase(
  logger: FastifyBaseLogger,
): Kysely<DB> {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  });

  pool.on('error', (error) => {
    logger.error(
      { err: error },
      'Unexpected PostgreSQL pool error',
    );
  });

  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

export async function assertDatabaseConnection(
  db: Kysely<DB>,
): Promise<void> {
  await sql<{ ok: number }>`
    select 1 as ok
  `.execute(db);
}