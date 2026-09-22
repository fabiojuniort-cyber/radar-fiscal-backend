import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { SpedSourceState, SpedStoredFile } from './sped.connector.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedFile(value: unknown): SpedStoredFile | undefined {
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

export async function readSpedSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<SpedSourceState> {
  const last = await db
    .selectFrom('collection_attempts as ca')
    .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
    .select(['ca.metadata', 'ca.finished_at'])
    .where('cr.source_id', '=', sourceId)
    .where('cr.status', 'in', ['SUCCESS', 'SUCCESS_NO_RESULTS'])
    .where('ca.status', '=', 'SUCCESS')
    .orderBy('ca.finished_at', 'desc')
    .orderBy('ca.attempt_no', 'desc')
    .executeTakeFirst();

  const metadata = record(last?.metadata);
  const state = record(metadata?.spedState);
  const rawItems = record(state?.items);
  const items: Record<string, SpedStoredFile> = {};
  if (rawItems) {
    for (const [key, value] of Object.entries(rawItems)) {
      if (!/^(?:EFD_ICMS_IPI|EFD_CONTRIBUICOES|EFD_REINF|DERE):item:\d+:/.test(key)) continue;
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }
  return { items };
}
