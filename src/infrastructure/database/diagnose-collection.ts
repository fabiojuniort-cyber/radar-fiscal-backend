import 'dotenv/config';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { readCollectionDiagnostics } from '../../modules/operations/collection-diagnostics.js';
import type { DB } from './database.types.js';

/**
 * Usage: npm run db:diagnose-collection -- [hours]
 *
 * Read-only: item failures per source, origin/identity conflicts and the
 * latest DOU partial failures. Prints one COLLECTION_DIAGNOSTICS= JSON line.
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const hoursArg = Number(process.argv[2] ?? '48');
const hours = Number.isFinite(hoursArg) && hoursArg > 0 && hoursArg <= 24 * 30 ? hoursArg : 48;

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
});

try {
  console.log('COLLECTION_DIAGNOSTICS=' + JSON.stringify(await readCollectionDiagnostics(db, hours)));
} finally {
  await db.destroy();
}
