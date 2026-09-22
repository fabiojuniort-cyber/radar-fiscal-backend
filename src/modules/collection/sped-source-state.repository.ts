import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type {
  SpedKnownPage,
  SpedPageKind,
  SpedSourceState,
  SpedStoredFile,
} from './sped.connector.js';
import type { SpedModule } from './sped.parser.js';

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

function knownPage(value: unknown): SpedKnownPage | undefined {
  const item = record(value);
  if (!item) return undefined;

  const kind = item.kind;
  const module = item.module;

  if (
    kind !== 'CONTAINER' &&
    kind !== 'DOCUMENT' &&
    kind !== 'MISSING' &&
    kind !== 'UNKNOWN'
  ) return undefined;
  if (
    module !== 'EFD_ICMS_IPI' &&
    module !== 'EFD_CONTRIBUICOES' &&
    module !== 'EFD_REINF' &&
    module !== 'DERE'
  ) return undefined;
  if (typeof item.canonicalUrl !== 'string') return undefined;

  let canonicalUrl: string;
  try {
    const parsed = new URL(item.canonicalUrl);
    if (parsed.origin.toLowerCase() !== 'https://sped.rfb.gov.br') return undefined;
    parsed.hash = '';
    canonicalUrl = parsed.toString();
  } catch {
    return undefined;
  }

  if (typeof item.checkedAt !== 'string' || !Number.isFinite(Date.parse(item.checkedAt))) return undefined;

  return {
    canonicalUrl,
    kind: kind as SpedPageKind,
    module: module as SpedModule,
    checkedAt: item.checkedAt,
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
      if (!/^(?:EFD_ICMS_IPI|EFD_CONTRIBUICOES|EFD_REINF|DERE):(?:item|arquivo|pagina):\d+:/.test(key)) continue;
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }

  const rawPages = record(state?.pages);
  const pages: Record<string, SpedKnownPage> = {};
  if (rawPages) {
    for (const [key, value] of Object.entries(rawPages)) {
      let safeKey: string;
      try {
        const parsedKey = new URL(key);
        if (parsedKey.origin.toLowerCase() !== 'https://sped.rfb.gov.br') continue;
        parsedKey.hash = '';
        safeKey = parsedKey.toString();
      } catch {
        continue;
      }

      const parsed = knownPage(value);
      if (parsed) pages[safeKey] = parsed;
    }
  }

  return { items, pages };
}
