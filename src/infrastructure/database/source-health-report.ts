import 'dotenv/config';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import {
  evaluateSourceHealth,
  readSourceHealthRows,
} from '../../modules/operations/source-health.js';
import type { DB } from './database.types.js';

/**
 * Usage: npm run db:source-health
 *
 * Read-only health report of every active scheduled source (stale sources,
 * stuck runs, persistent partial runs). Prints one SOURCE_HEALTH= JSON line
 * and exits with code 2 when there is at least one alert.
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
});

try {
  const rows = await readSourceHealthRows(db);
  const report = evaluateSourceHealth(rows, new Date());
  console.log('SOURCE_HEALTH=' + JSON.stringify({ ...report, sources: rows }));
  process.exitCode = report.alerts.length > 0 ? 2 : 0;
} finally {
  await db.destroy();
}
