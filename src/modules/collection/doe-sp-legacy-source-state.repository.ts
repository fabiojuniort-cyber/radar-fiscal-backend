import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import {
  DOE_SP_LEGACY_CONNECTOR_KEY,
  DOE_SP_LEGACY_DEFAULT_START,
  DOE_SP_LEGACY_END,
  DOE_SP_LEGACY_STATE_VERSION,
  emptyDoeSpLegacyState,
  type DoeSpLegacyPendingPage,
  type DoeSpLegacySourceState,
} from './doe-sp-legacy.connector.js';
import { isIsoDate, type DoeSpLegacyPageRef } from './doe-sp-legacy.parser.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function pageRef(value: unknown): DoeSpLegacyPageRef | undefined {
  const row = record(value);
  const link = text(row?.link);
  const pagina = text(row?.pagina);
  const date = text(row?.date);
  const caderno = text(row?.caderno);
  const paginaOrdenacao = text(row?.paginaOrdenacao);
  if (!link || !/^\/\d{4}\/[^?#]+\.pdf$/i.test(link) || link.includes('..')) return undefined;
  if (!pagina || !date || !isIsoDate(date) || !caderno || !paginaOrdenacao) return undefined;
  return { link, pagina, date, caderno, paginaOrdenacao };
}

function pendingPages(value: unknown): DoeSpLegacyPendingPage[] {
  if (!Array.isArray(value)) return [];
  const out: DoeSpLegacyPendingPage[] = [];
  for (const raw of value) {
    const ref = pageRef(raw);
    if (!ref) continue;
    const row = record(raw)!;
    const discovery = row.discovery === 'KEYWORD_SEARCH' ? 'KEYWORD_SEARCH' : 'EDITION_BROWSE';
    const attempts = count(row.attempts);
    out.push({ ...ref, discovery, ...(attempts ? { attempts } : {}) });
  }
  return out;
}

/** Structurally invalid entries are dropped (same policy as the doe-sp state). */
export function parseDoeSpLegacySourceState(raw: Record<string, unknown> | undefined): DoeSpLegacySourceState {
  if (!raw) return emptyDoeSpLegacyState();
  const coverageFrom = text(raw.coverageFrom) && isIsoDate(raw.coverageFrom as string) ? raw.coverageFrom as string : DOE_SP_LEGACY_DEFAULT_START;
  const cursor = raw.cursor === null
    ? null
    : text(raw.cursor) && isIsoDate(raw.cursor as string) ? raw.cursor as string : coverageFrom;
  const totals = record(raw.totals);
  return {
    coverageFrom,
    coverageTo: DOE_SP_LEGACY_END,
    cursor,
    pending: pendingPages(raw.pending),
    retry: pendingPages(raw.retry),
    needsOcr: Array.isArray(raw.needsOcr) ? raw.needsOcr.map(pageRef).filter((ref): ref is DoeSpLegacyPageRef => ref !== undefined) : [],
    needsOcrTruncated: count(raw.needsOcrTruncated),
    totals: {
      pagesRead: count(totals?.pagesRead),
      pagesKept: count(totals?.pagesKept),
      pagesWithoutTaxTerms: count(totals?.pagesWithoutTaxTerms),
      newsPagesSkipped: count(totals?.newsPagesSkipped),
    },
    ...(typeof raw.lastSuccessAt === 'string' ? { lastSuccessAt: raw.lastSuccessAt } : {}),
  };
}

/**
 * Pages the connector returned but the engine failed to persist are marked
 * FAILED in collection_items of the run that produced the checkpoint. They
 * are read again (queued in `retry`), never assumed as captured.
 */
export function reopenFailedLegacyPages(
  state: DoeSpLegacySourceState,
  failed: Array<{ externalId: string; metadata: Record<string, unknown> | undefined }>,
): DoeSpLegacySourceState {
  if (!failed.length) return state;
  const known = new Set([...state.retry, ...state.pending].map((page) => page.link));
  const retry = [...state.retry];
  for (const item of failed) {
    const ref = pageRef({
      link: item.externalId,
      pagina: item.metadata?.pagina,
      date: item.metadata?.doeDate,
      caderno: item.metadata?.caderno,
      paginaOrdenacao: item.metadata?.paginaOrdenacao,
    });
    if (!ref || known.has(ref.link)) continue;
    known.add(ref.link);
    retry.push({ ...ref, discovery: item.metadata?.discovery === 'KEYWORD_SEARCH' ? 'KEYWORD_SEARCH' : 'EDITION_BROWSE' });
  }
  return { ...state, retry };
}

export async function readDoeSpLegacySourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<DoeSpLegacySourceState> {
  const stored = await readCurrentCheckpoint(db, sourceId, DOE_SP_LEGACY_CONNECTOR_KEY, {
    stateVersion: DOE_SP_LEGACY_STATE_VERSION,
    acceptedRunStatuses: ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'],
  });
  const state = parseDoeSpLegacySourceState(stored?.state);
  if (!stored?.producedByRunId) return state;

  const failed = await db
    .selectFrom('collection_items')
    .select(['external_id', 'raw_metadata'])
    .where('collection_run_id', '=', stored.producedByRunId)
    .where('status', '=', 'FAILED')
    .execute();
  return reopenFailedLegacyPages(
    state,
    failed
      .filter((row): row is typeof row & { external_id: string } => typeof row.external_id === 'string')
      .map((row) => ({ externalId: row.external_id, metadata: record(row.raw_metadata) })),
  );
}
