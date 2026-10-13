import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  CGIBS_CONNECTOR_KEY,
  CGIBS_STATE_VERSION,
  type CgibsSourceState,
  type CgibsStoredFile,
} from './cgibs.connector.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedFile(value: unknown): CgibsStoredFile | undefined {
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

export async function readCgibsSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<CgibsSourceState> {
  const stored = await readCurrentCheckpoint(db, sourceId, CGIBS_CONNECTOR_KEY, {
    stateVersion: CGIBS_STATE_VERSION,
    acceptedRunStatuses: ['SUCCESS', 'SUCCESS_NO_RESULTS'],
  });

  const rawItems = record(stored?.state.items);
  const items: Record<string, CgibsStoredFile> = {};

  if (rawItems) {
    for (const [key, value] of Object.entries(rawItems)) {
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }

  return { items };
}
