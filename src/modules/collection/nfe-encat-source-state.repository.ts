import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  NFE_ENCAT_CONNECTOR_KEY,
  NFE_ENCAT_STATE_VERSION,
  type NfeEncatSourceState,
  type NfeEncatStoredFile,
} from './nfe-encat.connector.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedFile(value: unknown): NfeEncatStoredFile | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.rawSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.rawSha256)) return undefined;
  if (typeof item.sizeBytes !== 'number' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return undefined;
  if (typeof item.mimeType !== 'string' || !item.mimeType.trim()) return undefined;
  if (typeof item.checkedAt !== 'string' || !Number.isFinite(Date.parse(item.checkedAt))) return undefined;
  return {
    rawSha256: item.rawSha256,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
    checkedAt: item.checkedAt,
    ...(typeof item.filename === 'string' && item.filename ? { filename: item.filename } : {}),
    ...(typeof item.sourceEtag === 'string' && item.sourceEtag ? { sourceEtag: item.sourceEtag } : {}),
    ...(typeof item.sourceLastModified === 'string' && item.sourceLastModified ? { sourceLastModified: item.sourceLastModified } : {}),
  };
}

/**
 * Loads the NF-e incremental checkpoint: primarily from collection_checkpoints,
 * falling back (transition only) to the legacy nfeEncatState embedded in the
 * metadata of the last successful attempt. Accepted run statuses are unchanged.
 */
export async function readNfeEncatSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<NfeEncatSourceState> {
  const accepted = ['SUCCESS', 'SUCCESS_NO_RESULTS'];
  const stored = await readCurrentCheckpoint(db, sourceId, NFE_ENCAT_CONNECTOR_KEY, {
    stateVersion: NFE_ENCAT_STATE_VERSION,
    acceptedRunStatuses: accepted,
  });

  let state: Record<string, unknown> | undefined;
  if (stored) {
    state = stored.state;
  } else {
    const last = await db
      .selectFrom('collection_attempts as ca')
      .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
      .select(['ca.metadata', 'ca.finished_at'])
      .where('cr.source_id', '=', sourceId)
      .where('cr.status', 'in', accepted)
      .where('ca.status', '=', 'SUCCESS')
      .where(sql<boolean>`ca.metadata ? 'nfeEncatState'`)
      .orderBy('ca.finished_at', 'desc')
      .orderBy('ca.attempt_no', 'desc')
      .executeTakeFirst();
    state = record(record(last?.metadata)?.nfeEncatState);
  }
  const rawItems = record(state?.items);
  const items: Record<string, NfeEncatStoredFile> = {};
  if (rawItems) {
    for (const [key, value] of Object.entries(rawItems)) {
      if (!/^(?:TECHNICAL_NOTES|TECHNICAL_REPORTS|SCHEMAS|MANUALS):/.test(key)) continue;
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }
  return { items };
}
