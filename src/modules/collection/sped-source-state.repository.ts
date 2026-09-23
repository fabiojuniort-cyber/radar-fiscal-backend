import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  SPED_CONNECTOR_KEY,
  SPED_MAX_FRONTIER,
  SPED_STATE_VERSION,
  type SpedCrawlCycle,
  type SpedFrontierPage,
  type SpedIdentityRecord,
  type SpedKnownPage,
  type SpedPageKind,
  type SpedSourceState,
  type SpedStoredFile,
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

function allowedSpedUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const legacy = parsed.origin.toLowerCase() === 'https://sped.rfb.gov.br';
    const govbr =
      parsed.origin.toLowerCase() === 'https://www.gov.br' &&
      (parsed.pathname === '/sped/pt-br' || parsed.pathname.startsWith('/sped/pt-br/'));
    if (!legacy && !govbr) return undefined;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
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

  const canonicalUrl = allowedSpedUrl(item.canonicalUrl);
  if (!canonicalUrl) return undefined;

  if (typeof item.checkedAt !== 'string' || !Number.isFinite(Date.parse(item.checkedAt))) return undefined;

  return {
    canonicalUrl,
    kind: kind as SpedPageKind,
    module: module as SpedModule,
    checkedAt: item.checkedAt,
  };
}

function identityRecord(value: unknown): SpedIdentityRecord | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.key !== 'string' || !item.key.startsWith('SPED|') || item.key.length > 4096) return undefined;
  if (typeof item.baseKey !== 'string' || !item.baseKey.startsWith('SPED|') || item.baseKey.length > 4096) return undefined;
  if (typeof item.officialUrl !== 'string' || !allowedSpedUrl(item.officialUrl)) return undefined;
  if (typeof item.title !== 'string') return undefined;
  if (!Array.isArray(item.fileSha256s) || !item.fileSha256s.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    return undefined;
  }
  return {
    key: item.key,
    baseKey: item.baseKey,
    officialUrl: item.officialUrl,
    title: item.title,
    ...(typeof item.content === 'string' ? { content: item.content } : {}),
    fileSha256s: [...item.fileSha256s as string[]].sort(),
  };
}

const SPED_MODULES_SET = new Set(['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE']);
const SEED_KINDS = new Set(['MODULE', 'CATEGORY', 'MODULE_HIGHLIGHTS', 'GLOBAL_HIGHLIGHTS']);

function crawlCycle(value: unknown): SpedCrawlCycle | undefined {
  const cycle = record(value);
  if (!cycle || !Array.isArray(cycle.completedModules) || !Array.isArray(cycle.frontier)) return undefined;
  const completedModules = [...new Set(
    cycle.completedModules.filter((module): module is SpedModule =>
      typeof module === 'string' && SPED_MODULES_SET.has(module)),
  )];
  const frontier: SpedFrontierPage[] = [];
  for (const raw of cycle.frontier.slice(0, SPED_MAX_FRONTIER)) {
    const page = record(raw);
    if (!page) continue;
    if (typeof page.module !== 'string' || !SPED_MODULES_SET.has(page.module)) continue;
    if (typeof page.url !== 'string') continue;
    const url = allowedSpedUrl(page.url);
    if (!url) continue;
    if (typeof page.depth !== 'number' || !Number.isSafeInteger(page.depth) || page.depth < 0 || page.depth > 100) continue;
    if (typeof page.seedKind !== 'string' || !SEED_KINDS.has(page.seedKind)) continue;
    frontier.push({
      module: page.module as SpedModule,
      url,
      depth: page.depth,
      seedKind: page.seedKind as SpedFrontierPage['seedKind'],
      ...(page.forceFetch === true ? { forceFetch: true } : {}),
    });
  }
  return { completedModules, frontier };
}

/**
 * Loads the SPED incremental checkpoint.
 *
 * Only checkpoints written with SPED_STATE_VERSION semantics are trusted: in
 * those, a page is marked as a known DOCUMENT only after its publication was
 * emitted with every file resolved; deferred documents stay re-fetchable.
 * That makes PARTIAL_SUCCESS checkpoints safe to reuse. Items whose
 * persistence failed in that run (collection_items FAILED) are additionally
 * removed from the checkpoint so they are retried immediately.
 */
export async function readSpedSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<SpedSourceState> {
  const accepted = ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'];
  // Primary store: collection_checkpoints (current generation, falling back
  // to the retained previous ones when the newest is not acceptable).
  const stored = await readCurrentCheckpoint(db, sourceId, SPED_CONNECTOR_KEY, {
    stateVersion: SPED_STATE_VERSION,
    acceptedRunStatuses: accepted,
  });
  // Transition fallback: legacy checkpoint embedded in attempt metadata.
  const legacy = stored
    ? undefined
    : await db
        .selectFrom('collection_attempts as ca')
        .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
        .select(['ca.metadata', 'ca.finished_at', 'cr.id as run_id', 'cr.status as run_status'])
        .where('cr.source_id', '=', sourceId)
        .where('cr.status', 'in', accepted)
        .where('ca.status', '=', 'SUCCESS')
        .where(sql<boolean>`(ca.metadata -> 'spedState' ->> 'version') = ${String(SPED_STATE_VERSION)}`)
        .orderBy('ca.finished_at', 'desc')
        .orderBy('ca.attempt_no', 'desc')
        .executeTakeFirst();

  const last = stored
    ? { run_id: stored.producedByRunId, run_status: stored.producedByRunStatus }
    : legacy
      ? { run_id: legacy.run_id, run_status: legacy.run_status }
      : undefined;
  if (!last) return { version: SPED_STATE_VERSION, items: {}, pages: {}, identities: {} };

  const state = stored ? stored.state : record(record(legacy?.metadata)?.spedState);

  const failedItems = last.run_status === 'PARTIAL_SUCCESS' && last.run_id
    ? await db
        .selectFrom('collection_items')
        .select(['external_id', 'source_url'])
        .where('collection_run_id', '=', last.run_id!)
        .where('status', '=', 'FAILED')
        .execute()
    : [];
  // Consistency with persisted domain data: a document can only be skipped as
  // "known" if its origin really exists. This self-heals checkpoints after
  // item persistence failures or a controlled domain clean-up.
  const origins = await db
    .selectFrom('publication_origins')
    .select(['external_id', 'official_url'])
    .where('source_id', '=', sourceId)
    .execute();
  const persistedExternalIds = new Set(origins.map((origin) => origin.external_id).filter((value): value is string => !!value));
  const persistedUrls = new Set(
    origins
      .map((origin) => allowedSpedUrl(origin.official_url))
      .filter((value): value is string => !!value),
  );

  const failedExternalIds = new Set(failedItems.map((item) => item.external_id).filter((value): value is string => !!value));
  const failedUrls = new Set(
    failedItems
      .map((item) => (item.source_url ? allowedSpedUrl(item.source_url) : undefined))
      .filter((value): value is string => !!value),
  );

  const rawItems = record(state?.items);
  const items: Record<string, SpedStoredFile> = {};
  if (rawItems) {
    for (const [key, value] of Object.entries(rawItems)) {
      if (!/^(?:EFD_ICMS_IPI|EFD_CONTRIBUICOES|EFD_REINF|DERE):/.test(key) || key.length > 4096) continue;
      if ([...failedExternalIds].some((externalId) => key.includes(':' + externalId + ':'))) continue;
      const parsed = storedFile(value);
      if (parsed) items[key] = parsed;
    }
  }

  const rawPages = record(state?.pages);
  const pages: Record<string, SpedKnownPage> = {};
  if (rawPages) {
    for (const [key, value] of Object.entries(rawPages)) {
      const safeKey = allowedSpedUrl(key);
      if (!safeKey) continue;

      const parsed = knownPage(value);
      if (!parsed) continue;
      if (
        failedUrls.has(parsed.canonicalUrl) ||
        failedUrls.has(safeKey) ||
        (parsed.kind === 'DOCUMENT' && !persistedUrls.has(parsed.canonicalUrl))
      ) {
        // Persistence failed or the publication no longer exists: keep it re-fetchable.
        pages[safeKey] = { ...parsed, kind: 'UNKNOWN' };
        continue;
      }
      pages[safeKey] = parsed;
    }
  }

  const rawIdentities = record(state?.identities);
  const identities: Record<string, SpedIdentityRecord> = {};
  if (rawIdentities) {
    for (const [externalId, value] of Object.entries(rawIdentities)) {
      if (externalId.length > 4096 || failedExternalIds.has(externalId) || !persistedExternalIds.has(externalId)) continue;
      const parsed = identityRecord(value);
      if (parsed) identities[externalId] = parsed;
    }
  }

  // An interrupted discovery cycle is resumed only from the newest checkpoint
  // of the table store (never from legacy metadata).
  const cycle = stored ? crawlCycle(state?.cycle) : undefined;

  return { version: SPED_STATE_VERSION, items, pages, identities, ...(cycle ? { cycle } : {}) };
}
