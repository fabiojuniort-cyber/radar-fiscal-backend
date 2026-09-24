import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  RFB_NORMAS_CONNECTOR_KEY,
  RFB_NORMAS_STATE_VERSION,
  type RfbNormasSourceState,
  type RfbStoredFile,
} from './rfb-normas.connector.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedFile(value: unknown): RfbStoredFile | undefined {
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
    ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
    ...(typeof item.sourceEtag === 'string' && item.sourceEtag ? { sourceEtag: item.sourceEtag } : {}),
    ...(typeof item.sourceLastModified === 'string' && item.sourceLastModified ? { sourceLastModified: item.sourceLastModified } : {}),
  };
}

export async function readRfbNormasSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<RfbNormasSourceState> {
  const stored = await readCurrentCheckpoint(db, sourceId, RFB_NORMAS_CONNECTOR_KEY, {
    stateVersion: RFB_NORMAS_STATE_VERSION,
    acceptedRunStatuses: ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'],
  });

  const state = stored?.state;
  const files: Record<string, RfbStoredFile> = {};
  const rawFiles = record(state?.files);
  if (rawFiles) {
    for (const [key, value] of Object.entries(rawFiles)) {
      const parsed = storedFile(value);
      if (parsed) files[key] = parsed;
    }
  }

  const bootstrapRecord = record(state?.bootstrap);
  const complete = bootstrapRecord?.complete === true;
  const month = typeof bootstrapRecord?.month === 'string' && /^\d{4}-\d{2}$/.test(bootstrapRecord.month)
    ? bootstrapRecord.month
    : '2025-01';
  const page = typeof bootstrapRecord?.page === 'number' && Number.isSafeInteger(bootstrapRecord.page) && bootstrapRecord.page >= 1
    ? bootstrapRecord.page
    : 1;

  return {
    bootstrap: { complete, month, page },
    files,
    ...(typeof state?.lastSuccessAt === 'string' && Number.isFinite(Date.parse(state.lastSuccessAt))
      ? { lastSuccessAt: state.lastSuccessAt }
      : {}),
  };
}
