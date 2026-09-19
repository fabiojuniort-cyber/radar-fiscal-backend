import {
  Kysely,
  PostgresDialect,
  sql,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from './database.types.js';

export interface StandaloneDatabaseOptions {
  connectionString: string;
  poolMax: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  onPoolError?: (error: Error) => void;
}

export function createStandaloneDatabase(
  options: StandaloneDatabaseOptions,
): Kysely<DB> {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    idleTimeoutMillis: options.idleTimeoutMs,
    connectionTimeoutMillis:
      options.connectionTimeoutMs,
  });

  if (options.onPoolError) {
    pool.on('error', options.onPoolError);
  }

  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function assertStandaloneDatabaseConnection(
  db: Kysely<DB>,
): Promise<void> {
  await sql<{ ok: number }>`
    select 1 as ok
  `.execute(db);
}
