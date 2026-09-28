import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import { readCurrentCheckpoint } from './checkpoint.repository.js';
import type { DoeSpInclusionCategory } from './doe-sp.rules.js';
import {
  DOE_SP_CONNECTOR_KEY,
  DOE_SP_STATE_VERSION,
  EMPTY_DOE_SP_STATE,
  type DoeSpDateRange,
  type DoeSpDayState,
  type DoeSpDeferredItem,
  type DoeSpSourceState,
} from './doe-sp.connector.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function date(value: unknown): string | null {
  return typeof value === 'string' && DATE.test(value) ? value : null;
}

function day(value: unknown): DoeSpDayState | undefined {
  const row = record(value);
  if (!row) return undefined;
  if (typeof row.idsHash !== 'string' || !/^([a-f0-9]{64})?$/.test(row.idsHash)) return undefined;
  if (typeof row.total !== 'number' || !Number.isSafeInteger(row.total) || row.total < 0) return undefined;
  if (!Array.isArray(row.included)) return undefined;
  const included = row.included.filter((id): id is string => typeof id === 'string' && GUID.test(id));
  return {
    idsHash: row.idsHash,
    total: row.total,
    included,
    checkedAt: typeof row.checkedAt === 'string' ? row.checkedAt : new Date(0).toISOString(),
  };
}

function ranges(value: unknown): DoeSpDateRange[] {
  if (!Array.isArray(value)) return [];
  const out: DoeSpDateRange[] = [];
  for (const item of value) {
    const row = record(item);
    const from = date(row?.from);
    const to = date(row?.to);
    if (from && to && from <= to) out.push({ from, to });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

const CATEGORIES = new Set<string>([
  'LEGISLATION', 'NUMBERED_DECREE', 'DECREES_SECTION', 'GOVERNOR_ACT_TAX_TERMS', 'VETO_TAX_TERMS',
  'SEFAZ_TAX_ADMINISTRATION', 'SEFAZ_CABINET', 'SEFAZ_OTHER_TAX_TERMS', 'PGE_TAX', 'OTHER_ORGAN_TAX_TERMS',
] satisfies DoeSpInclusionCategory[]);

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Structurally invalid entries are ignored (same policy as days/pendingRanges). */
function deferredItems(value: unknown): DoeSpDeferredItem[] {
  if (!Array.isArray(value)) return [];
  const out: DoeSpDeferredItem[] = [];
  for (const raw of value) {
    const row = record(raw);
    const item = record(row?.item);
    const id = text(row?.id);
    const doeDate = date(row?.doeDate);
    const category = text(row?.category) as DoeSpInclusionCategory | undefined;
    if (!row || !item || !id || !GUID.test(id) || !doeDate || !category || !CATEGORIES.has(category) || text(item.id) !== id) continue;
    const hierarchy = Array.isArray(item.hierarchy)
      ? item.hierarchy.filter((part): part is string => typeof part === 'string')
      : [];
    const typeName = text(row.typeName);
    const publicationTypeId = text(item.publicationTypeId);
    out.push({
      id,
      doeDate,
      reason: 'MATERIAL_PDF_NOT_READY',
      item: {
        id,
        ...(publicationTypeId ? { publicationTypeId } : {}),
        date: text(item.date) ?? doeDate,
        title: text(item.title) ?? '',
        slug: text(item.slug) ?? '',
        excerpt: text(item.excerpt) ?? '',
        hierarchy,
        isLegacy: item.isLegacy === true,
      },
      category,
      ...(typeName ? { typeName } : {}),
      firstDeferredAt: text(row.firstDeferredAt) ?? new Date(0).toISOString(),
      lastAttemptAt: text(row.lastAttemptAt) ?? new Date(0).toISOString(),
      attempts: typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) && row.attempts >= 0 ? row.attempts : 0,
    });
  }
  return out.sort((a, b) => a.doeDate.localeCompare(b.doeDate) || a.id.localeCompare(b.id));
}

export function parseDoeSpSourceState(raw: Record<string, unknown> | undefined): DoeSpSourceState {
  if (!raw) return { ...EMPTY_DOE_SP_STATE, pendingRanges: [], days: {} };
  const days: Record<string, DoeSpDayState> = {};
  const rawDays = record(raw.days);
  if (rawDays) {
    for (const [key, value] of Object.entries(rawDays)) {
      const parsed = DATE.test(key) ? day(value) : undefined;
      if (parsed) days[key] = parsed;
    }
  }
  return {
    coverageFrom: date(raw.coverageFrom),
    windowEnd: date(raw.windowEnd),
    pendingRanges: ranges(raw.pendingRanges),
    days,
    ...(deferredItems(raw.deferredItems).length ? { deferredItems: deferredItems(raw.deferredItems) } : {}),
    ...(typeof raw.lastSuccessAt === 'string' ? { lastSuccessAt: raw.lastSuccessAt } : {}),
  };
}

/**
 * Items the connector returned but the engine failed to persist are marked
 * FAILED in collection_items of the run that produced the checkpoint. They
 * must not be treated as known: window days forget them (and their
 * fingerprint), backfill days are queued again.
 */
export function reopenFailedItems(
  state: DoeSpSourceState,
  failed: Array<{ externalId: string; doeDate: string | null }>,
): DoeSpSourceState {
  if (!failed.length) return state;
  const next: DoeSpSourceState = {
    ...state,
    pendingRanges: state.pendingRanges.map((range) => ({ ...range })),
    days: { ...state.days },
  };
  for (const item of failed) {
    const windowDay = item.doeDate ? next.days[item.doeDate] : undefined;
    if (item.doeDate && windowDay) {
      next.days[item.doeDate] = {
        ...windowDay,
        idsHash: '',
        included: windowDay.included.filter((id) => id !== item.externalId),
      };
    } else if (item.doeDate) {
      next.pendingRanges.push({ from: item.doeDate, to: item.doeDate });
    } else {
      // Unknown date: forget every window fingerprint so the window is re-listed.
      for (const [key, value] of Object.entries(next.days)) {
        next.days[key] = { ...value, idsHash: '', included: value.included.filter((id) => id !== item.externalId) };
      }
    }
  }
  next.pendingRanges.sort((a, b) => a.from.localeCompare(b.from));
  return next;
}

export async function readDoeSpSourceState(
  db: Kysely<DB>,
  sourceId: string,
): Promise<DoeSpSourceState> {
  const stored = await readCurrentCheckpoint(db, sourceId, DOE_SP_CONNECTOR_KEY, {
    stateVersion: DOE_SP_STATE_VERSION,
    acceptedRunStatuses: ['SUCCESS', 'SUCCESS_NO_RESULTS', 'PARTIAL_SUCCESS'],
  });
  const state = parseDoeSpSourceState(stored?.state);
  if (!stored?.producedByRunId) return state;

  const failed = await db
    .selectFrom('collection_items')
    .select(['external_id', 'raw_metadata'])
    .where('collection_run_id', '=', stored.producedByRunId)
    .where('status', '=', 'FAILED')
    .execute();
  return reopenFailedItems(
    state,
    failed
      .filter((row): row is typeof row & { external_id: string } => typeof row.external_id === 'string' && GUID.test(row.external_id))
      .map((row) => ({
        externalId: row.external_id,
        doeDate: date(record(row.raw_metadata)?.doeDate),
      })),
  );
}
