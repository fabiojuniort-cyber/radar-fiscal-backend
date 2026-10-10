import { sql, type Kysely } from 'kysely';
import type { DB } from '../../infrastructure/database/database.types.js';

export const COLLECTION_ITEM_RETENTION_DAYS = 30;
export const COLLECTION_ITEM_PRUNE_BATCH_SIZE = 100;
export const COLLECTION_ITEM_PRUNE_MAX_BATCHES = 10;

export interface CollectionItemsRetentionOptions {
  apply?: boolean;
  now?: Date;
  olderThanDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface CollectionItemsRetentionReport {
  mode: 'DRY_RUN' | 'APPLY';
  cutoff: string;
  olderThanDays: number;
  batchSize: number;
  maxBatches: number;
  batches: number;
  candidateItems: number;
  deletedItems: number;
  remainingEligible: number;
  sampleIds: string[];
  stoppedByMaxBatches: boolean;
}

function boundedInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(name + ' must be an integer between ' + min + ' and ' + max);
  }
}

/**
 * L-10: prune ONLY old collection_items. Never delete collection_runs,
 * collection_attempts, collection_checkpoints or publication data.
 * Dry-run is read-only, keyset paginated. Apply uses bounded delete batches.
 * Retention is strict (< cutoff); boundary day is preserved.
 */
export async function pruneCollectionItems(
  db: Kysely<DB>,
  options: CollectionItemsRetentionOptions = {},
): Promise<CollectionItemsRetentionReport> {
  const olderThanDays = options.olderThanDays ?? COLLECTION_ITEM_RETENTION_DAYS;
  const batchSize = options.batchSize ?? COLLECTION_ITEM_PRUNE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? COLLECTION_ITEM_PRUNE_MAX_BATCHES;
  boundedInteger('olderThanDays', olderThanDays, 1, 3650);
  boundedInteger('batchSize', batchSize, 1, 1000);
  boundedInteger('maxBatches', maxBatches, 1, 10000);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid now');
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  const report: CollectionItemsRetentionReport = {
    mode: options.apply ? 'APPLY' : 'DRY_RUN',
    cutoff: cutoff.toISOString(), olderThanDays, batchSize,maxBatches,
    batches:0,candidateItems:0,deletedItems:0,remainingEligible:0,
    sampleIds:[],stoppedByMaxBatches:false,
  };
  if (!options.apply) {
    let cursorAt: Date | null = null;
    let cursorId: string | null = null;
    for (let i=0;i<maxBatches;i++) {
      const rows: {rows:Array<{id:string;created_at:Date}>}=await sql<{id:string;created_at:Date}>`
        SELECT id,created_at FROM collection_items
        WHERE created_at < ${cutoff}
          AND (${cursorAt}::timestamptz IS NULL
            OR (created_at,id) > (${cursorAt}::timestamptz,${cursorId}::uuid))
        ORDER BY created_at,id
        LIMIT ${batchSize}
      `.execute(db);
      if (!rows.rows.length) break;
      report.batches++;
      report.candidateItems += rows.rows.length;
      report.sampleIds.push(...rows.rows.slice(0,Math.max(0,20-report.sampleIds.length)).map(row=>row.id));
      const last=rows.rows[rows.rows.length-1]!;
      cursorAt=last.created_at;cursorId=last.id;
      if (rows.rows.length<batchSize) break;
    }
  } else {
    for (let i=0;i<maxBatches;i++) {
      const rows=await db.transaction().execute(async trx=>sql<{id:string}>`
        WITH eligible AS (
          SELECT id FROM collection_items
          WHERE created_at < ${cutoff}
          ORDER BY created_at,id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM collection_items ci USING eligible
        WHERE ci.id=eligible.id AND ci.created_at < ${cutoff}
        RETURNING ci.id
      `.execute(trx));
      if (!rows.rows.length) break;
      report.batches++;
      report.candidateItems+=rows.rows.length;
      report.deletedItems+=rows.rows.length;
      report.sampleIds.push(...rows.rows.slice(0,Math.max(0,20-report.sampleIds.length)).map(row=>row.id));
      if (rows.rows.length<batchSize) break;
    }
  }
  const remain=await sql<{count:string}>`
    SELECT count(*)::text AS count FROM collection_items WHERE created_at < ${cutoff}
  `.execute(db);
  report.remainingEligible=Number(remain.rows[0]?.count??0);
  report.stoppedByMaxBatches=report.batches===maxBatches&&report.remainingEligible>0;
  return report;
}
