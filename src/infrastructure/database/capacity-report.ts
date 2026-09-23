import 'dotenv/config';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import {
  insertCapacitySnapshot,
  measureCapacity,
} from '../../modules/operations/db-capacity.js';
import type { DB } from './database.types.js';

/**
 * Usage: npm run db:capacity-report -- [--no-insert]
 *
 * Measures PostgreSQL storage (database, WAL when a dedicated monitoring
 * connection is configured, heaviest tables) and stores one snapshot in
 * db_capacity_snapshots unless --no-insert is given.
 *
 * Env: DATABASE_URL (runtime role), optional DB_VOLUME_CAPACITY_BYTES and
 * DATABASE_MONITOR_URL (dedicated pg_monitor role; never the runtime role).
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const capacityRaw = process.env.DB_VOLUME_CAPACITY_BYTES;
const capacityBytes = capacityRaw ? Number(capacityRaw) : undefined;
if (capacityBytes !== undefined && (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0)) {
  console.error('DB_VOLUME_CAPACITY_BYTES must be a positive integer.');
  process.exit(1);
}

const insert = !process.argv.includes('--no-insert');
const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
});
const monitor = process.env.DATABASE_MONITOR_URL
  ? new Pool({ connectionString: process.env.DATABASE_MONITOR_URL, max: 1 })
  : undefined;

try {
  const who = await sql<{ current_user: string }>`SELECT current_user`.execute(db);
  const measurement = await measureCapacity(db, {
    ...(capacityBytes !== undefined ? { capacityBytes } : {}),
    ...(monitor ? { monitor } : {}),
  });
  const snapshotId = insert ? await insertCapacitySnapshot(db, measurement) : undefined;
  console.log('DB_CAPACITY_REPORT=' + JSON.stringify({
    databaseUser: who.rows[0]?.current_user,
    snapshotId: snapshotId ?? null,
    ...measurement,
  }));
} finally {
  await monitor?.end();
  await db.destroy();
}
