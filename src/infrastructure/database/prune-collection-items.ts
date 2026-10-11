import 'dotenv/config';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './database.types.js';
import {
  COLLECTION_ITEM_RETENTION_DAYS,
  COLLECTION_ITEM_PRUNE_BATCH_SIZE,
  COLLECTION_ITEM_PRUNE_MAX_BATCHES,
  pruneCollectionItems,
} from '../../modules/operations/collection-items-retention.js';

/**
 * L-10: npm run db:prune-collection-items -- [--apply]
 *   [--older-than-days=7] [--batch-size=100] [--max-batches=10]
 * Default DRY_RUN: SELECT only; does not delete any database row.
 * APPLY is explicit; requires DATABASE_ADMIN_URL and must be approved
 * independently before running against production. This script never
 * deletes collection_runs, collection_attempts or checkpoints.
 */
function positiveInt(name: string, fallback: number): number {
  const value=process.argv.find(arg=>arg.startsWith('--'+name+'='));
  if (!value) return fallback;
  const n=Number(value.slice(name.length+3));
  if (!Number.isSafeInteger(n)||n<1) throw new Error('--'+name+' must be positive integer');
  return n;
}

const apply=process.argv.includes('--apply');
const url=apply
  ? process.env.DATABASE_ADMIN_URL
  : process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error(apply
  ? 'DATABASE_ADMIN_URL is required for --apply'
  : 'DATABASE_URL (or DATABASE_ADMIN_URL) is required');
const db=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({
  connectionString:url,max:1,
})})});
try {
  const who=await sql<{current_user:string}>`SELECT current_user`.execute(db);
  const report=await pruneCollectionItems(db,{
    apply,
    olderThanDays:positiveInt('older-than-days',COLLECTION_ITEM_RETENTION_DAYS),
    batchSize:positiveInt('batch-size',COLLECTION_ITEM_PRUNE_BATCH_SIZE),
    maxBatches:positiveInt('max-batches',COLLECTION_ITEM_PRUNE_MAX_BATCHES),
  });
  console.log('COLLECTION_ITEMS_PRUNE='+JSON.stringify({
    databaseUser:who.rows[0]?.current_user,...report,
  }));
} finally {
  await db.destroy();
}
