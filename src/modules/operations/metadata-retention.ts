import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';

/**
 * Retention of heavy diagnostic data in collection_attempts.metadata.
 *
 * collection_attempts is the execution history and is never deleted here.
 * Only known heavy keys are removed from attempts finished more than
 * `olderThanDays` ago. Everything needed to understand an execution stays:
 * status, timestamps, duration, attempt number, error/summary, counters
 * (publicationCount, partialFailureCount, *Count fields, moduleResults),
 * completion and checkpointRef.
 */
export const METADATA_RETENTION_DAYS = 30;
export const DEFAULT_PRUNE_BATCH_SIZE = 100;

export type PrunedKey =
  | 'spedState'
  | 'nfeEncatState'
  | 'sped.identityAudit'
  | 'sped.deferredDocuments';

export interface PruneContext {
  /**
   * Legacy checkpoints embedded in metadata are only removed once the source
   * already has a row in collection_checkpoints for that connector, so the
   * transition fallback is never taken away before the new store is in use.
   */
  hasSpedCheckpoint: boolean;
  hasNfeEncatCheckpoint: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pure transformation. Returns the pruned metadata and the removed keys
 * (empty when nothing applies). Never touches unknown keys.
 */
export function pruneAttemptMetadata(
  metadata: unknown,
  context: PruneContext,
  prunedAt: Date,
): { metadata: Record<string, unknown>; removed: PrunedKey[] } | undefined {
  if (!isRecord(metadata)) return undefined;

  const next: Record<string, unknown> = { ...metadata };
  const removed: PrunedKey[] = [];

  if ('spedState' in next && context.hasSpedCheckpoint) {
    delete next.spedState;
    removed.push('spedState');
  }
  if ('nfeEncatState' in next && context.hasNfeEncatCheckpoint) {
    delete next.nfeEncatState;
    removed.push('nfeEncatState');
  }

  if (isRecord(next.sped)) {
    const sped: Record<string, unknown> = { ...next.sped };
    if ('identityAudit' in sped) {
      const audit = isRecord(sped.identityAudit) ? sped.identityAudit : {};
      // Keep the counts; drop the per-document lists.
      sped.identityAuditCounts = {
        identityVersion: typeof audit.identityVersion === 'string' ? audit.identityVersion : null,
        emittedPublicationCount: numberOrNull(audit.emittedPublicationCount),
        distinctIdentityKeyCount: numberOrNull(audit.distinctIdentityKeyCount),
        mirrorGroups: arrayLength(audit.mirrorGroups),
        collisionsResolved: arrayLength(audit.collisionsResolved),
        unresolvedCollisions: numberOrNull(audit.unresolvedCollisions),
      };
      delete sped.identityAudit;
      removed.push('sped.identityAudit');
    }
    if ('deferredDocuments' in sped) {
      // deferredDocumentCount is kept as is.
      delete sped.deferredDocuments;
      removed.push('sped.deferredDocuments');
    }
    next.sped = sped;
  }

  if (removed.length === 0) return { metadata, removed };

  const previous = isRecord(next.metadataPruned) && Array.isArray(next.metadataPruned.keys)
    ? next.metadataPruned.keys.filter((key): key is string => typeof key === 'string')
    : [];
  next.metadataPruned = {
    at: prunedAt.toISOString(),
    keys: [...new Set([...previous, ...removed])].sort(),
  };
  return { metadata: next, removed };
}

export interface PruneOptions {
  apply: boolean;
  now?: Date;
  olderThanDays?: number;
  batchSize?: number;
  /** Safety valve for manual runs; unset = until done. */
  maxBatches?: number;
}

export interface PruneReport {
  mode: 'DRY_RUN' | 'APPLY';
  cutoff: string;
  olderThanDays: number;
  batchSize: number;
  scannedAttempts: number;
  affectedAttempts: number;
  updatedAttempts: number;
  batches: number;
  removedKeyCounts: Record<PrunedKey, number>;
  /** Uncompressed JSON size of the affected metadata, before/after. */
  jsonBytesBefore: number;
  jsonBytesAfter: number;
  /** Stored (possibly TOAST-compressed) size of the affected metadata before. */
  storedBytesBefore: number;
  byConnector: Record<string, { affectedAttempts: number; jsonBytesBefore: number; jsonBytesAfter: number }>;
  /** Legacy checkpoints kept because the source has no collection_checkpoints row yet. */
  legacyStateKeptWithoutCheckpoint: number;
  sample: Array<{ attemptId: string; connectorKey: string; finishedAt: string; removed: PrunedKey[] }>;
  stoppedByMaxBatches: boolean;
}

const SAMPLE_SIZE = 20;

/**
 * Scans finished attempts older than the cutoff in keyset-paginated batches.
 * Dry-run (default) changes nothing and reports exactly what would be removed.
 * Apply updates each batch in its own short transaction (attempt rows only;
 * no attempt is ever deleted).
 */
export async function pruneCollectionMetadata(
  db: Kysely<DB>,
  options: PruneOptions,
): Promise<PruneReport> {
  const now = options.now ?? new Date();
  const olderThanDays = options.olderThanDays ?? METADATA_RETENTION_DAYS;
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1) {
    throw new RangeError('olderThanDays must be an integer >= 1');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('batchSize must be an integer between 1 and 1000');
  }
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);

  const report: PruneReport = {
    mode: options.apply ? 'APPLY' : 'DRY_RUN',
    cutoff: cutoff.toISOString(),
    olderThanDays,
    batchSize,
    scannedAttempts: 0,
    affectedAttempts: 0,
    updatedAttempts: 0,
    batches: 0,
    removedKeyCounts: {
      spedState: 0,
      nfeEncatState: 0,
      'sped.identityAudit': 0,
      'sped.deferredDocuments': 0,
    },
    jsonBytesBefore: 0,
    jsonBytesAfter: 0,
    storedBytesBefore: 0,
    byConnector: {},
    legacyStateKeptWithoutCheckpoint: 0,
    sample: [],
    stoppedByMaxBatches: false,
  };

  let lastId: string | undefined;
  for (;;) {
    if (options.maxBatches !== undefined && report.batches >= options.maxBatches) {
      report.stoppedByMaxBatches = true;
      break;
    }

    let query = db
      .selectFrom('collection_attempts as ca')
      .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
      .innerJoin('sources as s', 's.id', 'cr.source_id')
      .select([
        'ca.id',
        'ca.metadata',
        'ca.finished_at',
        's.connector_key',
        sql<number>`pg_column_size(ca.metadata)`.as('stored_bytes'),
        sql<boolean>`EXISTS (
          SELECT 1 FROM collection_checkpoints cc
          WHERE cc.source_id = s.id AND cc.connector_key = 'sped'
        )`.as('has_sped_checkpoint'),
        sql<boolean>`EXISTS (
          SELECT 1 FROM collection_checkpoints cc
          WHERE cc.source_id = s.id AND cc.connector_key = 'nfe-encat'
        )`.as('has_nfe_checkpoint'),
      ])
      .where('ca.finished_at', 'is not', null)
      .where('ca.finished_at', '<', cutoff)
      .where(sql<boolean>`(
        ca.metadata ? 'spedState'
        OR ca.metadata ? 'nfeEncatState'
        OR (jsonb_typeof(ca.metadata -> 'sped') = 'object'
            AND (ca.metadata -> 'sped' ? 'identityAudit' OR ca.metadata -> 'sped' ? 'deferredDocuments'))
      )`)
      .orderBy('ca.id')
      .limit(batchSize);
    if (lastId) query = query.where('ca.id', '>', lastId);

    const rows = await query.execute();
    if (rows.length === 0) break;
    report.batches += 1;
    lastId = rows[rows.length - 1]!.id;

    const updates: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    for (const row of rows) {
      report.scannedAttempts += 1;
      const context: PruneContext = {
        hasSpedCheckpoint: row.connector_key === 'sped' && row.has_sped_checkpoint,
        hasNfeEncatCheckpoint: row.connector_key === 'nfe-encat' && row.has_nfe_checkpoint,
      };
      const metadata = row.metadata as Record<string, unknown>;
      if (
        ('spedState' in metadata && !context.hasSpedCheckpoint) ||
        ('nfeEncatState' in metadata && !context.hasNfeEncatCheckpoint)
      ) {
        report.legacyStateKeptWithoutCheckpoint += 1;
      }
      const result = pruneAttemptMetadata(metadata, context, now);
      if (!result || result.removed.length === 0) continue;

      const before = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
      const after = Buffer.byteLength(JSON.stringify(result.metadata), 'utf8');
      report.affectedAttempts += 1;
      report.jsonBytesBefore += before;
      report.jsonBytesAfter += after;
      report.storedBytesBefore += Number(row.stored_bytes);
      for (const key of result.removed) report.removedKeyCounts[key] += 1;
      const connector = report.byConnector[row.connector_key] ??= {
        affectedAttempts: 0,
        jsonBytesBefore: 0,
        jsonBytesAfter: 0,
      };
      connector.affectedAttempts += 1;
      connector.jsonBytesBefore += before;
      connector.jsonBytesAfter += after;
      if (report.sample.length < SAMPLE_SIZE) {
        report.sample.push({
          attemptId: row.id,
          connectorKey: row.connector_key,
          finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : '',
          removed: result.removed,
        });
      }
      updates.push({ id: row.id, metadata: result.metadata });
    }

    if (options.apply && updates.length > 0) {
      await db.transaction().execute(async (trx) => {
        for (const update of updates) {
          const updated = await trx
            .updateTable('collection_attempts')
            .set({ metadata: JSON.stringify(update.metadata) })
            .where('id', '=', update.id)
            .where('finished_at', 'is not', null)
            .executeTakeFirst();
          report.updatedAttempts += Number(updated.numUpdatedRows);
        }
      });
    }
  }

  return report;
}
