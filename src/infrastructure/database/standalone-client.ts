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


export async function assertWorkerRuntimeConnection(
  db: Kysely<DB>,
): Promise<void> {
  const result = await sql<{
    current_user: string;
    is_superuser: boolean;
    bypass_rls: boolean;
  }>`
    SELECT
      current_user,
      r.rolsuper AS is_superuser,
      r.rolbypassrls AS bypass_rls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `.execute(db);

  const role = result.rows[0];

  if (!role) {
    throw new Error(
      'Worker database role could not be inspected.',
    );
  }

  if (role.current_user !== 'radar_worker_runtime') {
    throw new Error(
      `Unexpected collection runtime database role: ${role.current_user}`,
    );
  }

  if (role.is_superuser || role.bypass_rls) {
    throw new Error(
      'Collection runtime role has forbidden elevated privileges.',
    );
  }
}
