import 'dotenv/config';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import {
  DEFAULT_PRUNE_BATCH_SIZE,
  METADATA_RETENTION_DAYS,
  pruneCollectionMetadata,
} from '../../modules/operations/metadata-retention.js';
import type { DB } from './database.types.js';

/**
 * Usage: npm run db:prune-collection-metadata -- [--apply] [--older-than-days=30]
 *        [--batch-size=100] [--max-batches=N]
 *
 * DRY-RUN BY DEFAULT: without --apply nothing is written; the report shows
 * exactly which keys would be removed from how many attempts. Attempts are
 * never deleted. Runs with the least-privileged URL available (DATABASE_URL,
 * i.e. the worker runtime role, before DATABASE_ADMIN_URL).
 */
function intArg(name: string, fallback?: number): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith('--' + name + '='));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error('--' + name + ' must be a positive integer');
    process.exit(1);
  }
  return value;
}

const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const olderThanDays = intArg('older-than-days', METADATA_RETENTION_DAYS)!;
const batchSize = intArg('batch-size', DEFAULT_PRUNE_BATCH_SIZE)!;
const maxBatches = intArg('max-batches');

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
});

try {
  const who = await sql<{ current_user: string }>`SELECT current_user`.execute(db);
  const report = await pruneCollectionMetadata(db, {
    apply,
    olderThanDays,
    batchSize,
    ...(maxBatches !== undefined ? { maxBatches } : {}),
  });
  console.log('COLLECTION_METADATA_PRUNE=' + JSON.stringify({
    databaseUser: who.rows[0]?.current_user,
    ...report,
  }));
} finally {
  await db.destroy();
}
