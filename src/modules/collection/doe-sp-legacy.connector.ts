import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorPartialFailure,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { DoeSpLegacyClient, type DoeSpLegacyClientOptions } from './doe-sp-legacy.client.js';
import {
  DOE_SP_LEGACY_RESULTS_PER_SCREEN,
  brFromIso,
  doeSpLegacyPdfUrl,
  doeSpLegacyResultScreenUrl,
  doeSpLegacyResultUrl,
  doeSpLegacyViewerUrl,
  isIsoDate,
  parseDoeSpLegacyCadernos,
  parseDoeSpLegacyResults,
  type DoeSpLegacyCaderno,
  type DoeSpLegacyPageRef,
} from './doe-sp-legacy.parser.js';
import {
  DOE_SP_LEGACY_SEARCH_TERMS,
  DOE_SP_LEGACY_VOCABULARY_VERSION,
  doeSpLegacyTaxTerms,
  isDoeSpLegacyNewsPage,
} from './doe-sp-legacy.rules.js';
import { extractDoeSpLegacyPdfText, type DoeSpLegacyPageText } from './doe-sp-legacy.text.js';

/*
 * Legacy DOE-SP archive (Imprensa Oficial, 1988 – 30/06/2023), Issue #20 /
 * DOE-SP-LEGACY-03. A finite backfill, separate from the `doe-sp` connector
 * (current platform, from 01/07/2023), which it never touches.
 *
 * Decisions of the owner (2026-09-29):
 * - only pages with tax terms are kept;
 * - the PDF is not stored: it is read in memory, turned into text and dropped
 *   (only its SHA-256/size stay as provenance);
 * - the official link of the page is preserved (`officialUrl`).
 *
 * Discovery (measured on the source, DOE-SP-LEGACY-02/03/08):
 * - Executivo I (Seção I, where normative acts are printed), the whole range
 *   (BROWSE): each edition is listed whole per date and every page is read
 *   and filtered locally. Before 2003 the keyword index does not answer; from
 *   2003 on the dry pilot P1 found a kept page the index did not return
 *   (missedBySearch = 1 in 118), so the owner chose to read every page there
 *   too (DOE-SP-LEGACY-09);
 * - Executivo II and III, from 2003 on (SEARCH): the portal's keyword index,
 *   one query per tax term, per month and per caderno; results merged by page.
 *   The two cursors advance together: the search month runs when the browse
 *   cursor reaches it.
 * Every downloaded page is confirmed locally with the same tax vocabulary
 * that drives the queries before it becomes a publication.
 *
 * Listing a period is resumable (review DOE-SP-LEGACY-04, B2/B3): the query and
 * screen being listed are kept in the checkpoint, the time budget is checked
 * before every request, and a screen that cannot be fully parsed blocks the
 * period (retried every run, the cursor never skips it).
 */

export const DOE_SP_LEGACY_CONNECTOR_KEY = 'doe-sp-legacy';
/** 2: Executivo I browsed in the whole range + searchCursor (DOE-SP-LEGACY-09). */
export const DOE_SP_LEGACY_STATE_VERSION = 2;

export const DOE_SP_LEGACY_DEFAULT_START = '1988-01-01';
/** Day before the current platform (doe-sp DOE_SP_PLATFORM_START). */
export const DOE_SP_LEGACY_END = '2023-06-30';
/** First month answered by the portal's keyword index (measured 09/2026). */
export const DOE_SP_LEGACY_SEARCH_INDEX_START = '2003-01-01';

export const DOE_SP_LEGACY_DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_000;
export const DOE_SP_LEGACY_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN = 200 * 1024 * 1024;
/** Attempts before a page that keeps failing is abandoned (reported, not retried). */
export const DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS = 3;
/** Failed attempts on the same result screen before the listing is reported as blocked (still retried). */
export const DOE_SP_LEGACY_LISTING_BLOCKED_AFTER = 3;

/** Executivo cadernos queried in SEARCH mode (the index filters by name + id); Executivo I is browsed. */
export const DOE_SP_LEGACY_SEARCH_CADERNOS: readonly DoeSpLegacyCaderno[] = [
  { id: 'ex2', name: 'Executivo II' },
  { id: 'ex3', name: 'Executivo III' },
];
/** Caderno listed whole in BROWSE mode (every date of the archive). */
export const DOE_SP_LEGACY_BROWSE_CADERNO = 'Executivo I';

const CADERNOS_AJAX = '/ajax/ImprensaOficial.PortalIO.DODigitalAjax,PortalIO.ashx?_method=GetCadernos&_session=no';
const DAY_MS = 86_400_000;

export interface DoeSpLegacyPendingPage extends DoeSpLegacyPageRef {
  discovery: 'KEYWORD_SEARCH' | 'EDITION_BROWSE';
  attempts?: number;
}

/** A period being listed (kept in the checkpoint until every query is listed). */
export interface DoeSpLegacyListing {
  mode: 'BROWSE' | 'SEARCH';
  from: string;
  to: string;
  /** Cursor after this period. */
  next: string | null;
  vocabularyVersion: number;
  /** BROWSE: Executivo I of the date (null = no edition); absent = not looked up yet. */
  browseCaderno?: DoeSpLegacyCaderno | null;
  /** Index of the query being listed (see doeSpLegacyListingQueries). */
  query: number;
  /** Next result screen of that query (1-based). */
  screen: number;
  /** Screens of that query, known after its first screen. */
  screens?: number;
  /** Pages found so far in the period (merged by link). */
  found: DoeSpLegacyPendingPage[];
  /** Consecutive failed attempts on the current screen. */
  attempts: number;
}

export interface DoeSpLegacySourceState {
  coverageFrom: string;
  coverageTo: string;
  /** Next date to browse (Executivo I). null = every date was browsed. */
  cursor: string | null;
  /**
   * Start of the next month to search (Executivo II and III, from 2003): the
   * first day of a month, or the coverage start inside its first month.
   * null = every month was searched.
   */
  searchCursor: string | null;
  /** Period being listed; null when no listing is in progress. */
  listing: DoeSpLegacyListing | null;
  /** Listed pages still to be read (from the last listed period). */
  pending: DoeSpLegacyPendingPage[];
  /** Pages whose publication failed to persist in the engine (reopened). */
  retry: DoeSpLegacyPendingPage[];
  /**
   * Pages kept for a later OCR pass (scan without any text layer). When the
   * list is full, the run stops at the next such page (gate) instead of
   * dropping it.
   */
  needsOcr: DoeSpLegacyPageRef[];
  totals: { pagesRead: number; pagesKept: number; pagesWithoutTaxTerms: number; newsPagesSkipped: number };
  lastSuccessAt?: string;
}

export const MAX_NEEDS_OCR_KEPT = 5_000;

/** First date searched for a coverage starting at `coverageFrom` (its month runs to the month end). */
export function doeSpLegacySearchStart(coverageFrom: string): string {
  return coverageFrom > DOE_SP_LEGACY_SEARCH_INDEX_START ? coverageFrom : DOE_SP_LEGACY_SEARCH_INDEX_START;
}

export function emptyDoeSpLegacyState(coverageFrom = DOE_SP_LEGACY_DEFAULT_START): DoeSpLegacySourceState {
  return {
    coverageFrom,
    coverageTo: DOE_SP_LEGACY_END,
    cursor: coverageFrom,
    searchCursor: doeSpLegacySearchStart(coverageFrom),
    listing: null,
    pending: [],
    retry: [],
    needsOcr: [],
    totals: { pagesRead: 0, pagesKept: 0, pagesWithoutTaxTerms: 0, newsPagesSkipped: 0 },
  };
}

export interface DoeSpLegacyConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<DoeSpLegacySourceState>;
  /** First archive date (default 1988-01-01; env DOE_SP_LEGACY_START_DATE). */
  startDate?: string;
  client?: Omit<DoeSpLegacyClientOptions, 'fetch'>;
  /** Stop reading new pages after this many bytes in the run (0 = unlimited). */
  maxDownloadBytesPerRun?: number;
  /** Stop listing new periods after this many in the run (0/undefined = unlimited). */
  maxPeriodsPerRun?: number;
  /** Test seam: text extraction. */
  extractText?: (bytes: Uint8Array) => Promise<DoeSpLegacyPageText>;
}

function envInteger(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Worker-side politeness towards the archive:
 * DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS (default 1000),
 * DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN (default 200 MiB; 0 = unlimited) and
 * DOE_SP_LEGACY_MAX_PERIODS_PER_RUN (default 0 = unlimited; bounds a pilot run).
 */
export function resolveDoeSpLegacySourceLimits(env: NodeJS.ProcessEnv = process.env): {
  minRequestIntervalMs: number;
  maxDownloadBytesPerRun: number;
  maxPeriodsPerRun: number;
} {
  return {
    minRequestIntervalMs: envInteger('DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS', DOE_SP_LEGACY_DEFAULT_MIN_REQUEST_INTERVAL_MS, 0, 10_000, env),
    maxDownloadBytesPerRun: envInteger('DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN', DOE_SP_LEGACY_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN, 0, 10 * 1024 * 1024 * 1024, env),
    // Pilot bound: periods (days before 2003, months after) listed per run; 0 = unlimited.
    maxPeriodsPerRun: envInteger('DOE_SP_LEGACY_MAX_PERIODS_PER_RUN', 0, 0, 100_000, env),
  };
}

function resolveStart(value: string | undefined): string {
  const raw = value ?? process.env.DOE_SP_LEGACY_START_DATE;
  if (raw === undefined || raw === '') return DOE_SP_LEGACY_DEFAULT_START;
  if (!isIsoDate(raw)) throw new RangeError('DOE_SP_LEGACY_START_DATE must be YYYY-MM-DD');
  if (raw > DOE_SP_LEGACY_END) throw new RangeError('DOE_SP_LEGACY_START_DATE must be on or before ' + DOE_SP_LEGACY_END);
  return raw;
}

export function addLegacyDays(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

function monthEnd(date: string): string {
  const [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthStart(date: string): string {
  return date.slice(0, 8) + '01';
}

export interface DoeSpLegacyPeriod { mode: 'BROWSE' | 'SEARCH'; from: string; to: string; next: string | null }

/**
 * Next period to list: the search month when the browse cursor has reached it
 * (or browsing is over), otherwise the browse date. null = archive listed.
 */
export function doeSpLegacyNextPeriod(
  state: Pick<DoeSpLegacySourceState, 'cursor' | 'searchCursor' | 'coverageTo'>,
): DoeSpLegacyPeriod | null {
  const { cursor, searchCursor, coverageTo } = state;
  if (searchCursor !== null && (cursor === null || searchCursor <= cursor)) {
    const end = monthEnd(searchCursor) < coverageTo ? monthEnd(searchCursor) : coverageTo;
    const next = addLegacyDays(end, 1);
    return { mode: 'SEARCH', from: searchCursor, to: end, next: next > coverageTo ? null : monthStart(next) };
  }
  if (cursor === null) return null;
  const next = addLegacyDays(cursor, 1);
  return { mode: 'BROWSE', from: cursor, to: cursor, next: next > coverageTo ? null : next };
}

export interface DoeSpLegacyQuery { caderno: DoeSpLegacyCaderno; keyword?: string }

/** Queries of a listing, in order: SEARCH = caderno x term; BROWSE = the whole Executivo I edition. */
export function doeSpLegacyListingQueries(listing: DoeSpLegacyListing): DoeSpLegacyQuery[] {
  if (listing.mode === 'BROWSE') return listing.browseCaderno ? [{ caderno: listing.browseCaderno }] : [];
  return DOE_SP_LEGACY_SEARCH_CADERNOS.flatMap((caderno) => DOE_SP_LEGACY_SEARCH_TERMS.map((keyword) => ({ caderno, keyword })));
}

function newListing(period: DoeSpLegacyPeriod): DoeSpLegacyListing {
  return { ...period, vocabularyVersion: DOE_SP_LEGACY_VOCABULARY_VERSION, query: 0, screen: 1, found: [], attempts: 0 };
}

function listingError(code: string, metadata: Record<string, unknown>): ConnectorError {
  return new ConnectorError(code, { code, kind: 'PROCESSING_ERROR', retryable: false, metadata });
}

function failureInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) {
    const status = error.httpStatus !== undefined ? ` [status=${error.httpStatus}]` : '';
    return { code: error.code, message: error.message + status };
  }
  return { code: 'DOE_SP_LEGACY_UNHANDLED_ERROR', message: error instanceof Error ? error.message : 'Unknown DOE-SP legacy error' };
}

function isCancel(error: unknown): boolean {
  return error instanceof ConnectorError && error.kind === 'CANCELLED';
}

/** Unavailability of the source itself: stop the run, keep everything pending. */
function isSourceLevel(error: unknown): boolean {
  return error instanceof ConnectorError &&
    ['SOURCE_UNAVAILABLE', 'NETWORK_ERROR', 'RATE_LIMITED'].includes(error.kind);
}

class SourceDown extends Error {
  constructor(readonly cause: unknown) { super('source unavailable'); }
}

export class DoeSpLegacyConnector implements CollectionConnector {
  readonly key = DOE_SP_LEGACY_CONNECTOR_KEY;
  readonly version = '1.0.0';
  readonly #options: DoeSpLegacyConnectorOptions;

  constructor(options: DoeSpLegacyConnectorOptions = {}) {
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const start = resolveStart(this.#options.startDate);
    const loaded = await this.#options.readState?.(context.sourceId) ?? emptyDoeSpLegacyState(start);
    const state: DoeSpLegacySourceState = {
      ...loaded,
      listing: loaded.listing ? { ...loaded.listing, found: loaded.listing.found.map((page) => ({ ...page })) } : null,
      pending: loaded.pending.map((page) => ({ ...page })),
      retry: loaded.retry.map((page) => ({ ...page })),
      needsOcr: [...loaded.needsOcr],
      totals: { ...loaded.totals },
    };
    // A start date earlier than the covered range re-opens the head of the archive.
    if (start < state.coverageFrom) {
      state.coverageFrom = start;
      state.cursor = start;
      state.searchCursor = doeSpLegacySearchStart(start);
      state.listing = null;
    }

    const client = new DoeSpLegacyClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });
    const extract = this.#options.extractText ?? extractDoeSpLegacyPdfText;
    const maxBytes = this.#options.maxDownloadBytesPerRun ?? 0;
    const publications: ConnectorPublication[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];
    const counters = {
      periodsListed: 0, listScreens: 0, cadernoLookups: 0, pagesRead: 0, pagesKept: 0,
      pagesWithoutTaxTerms: 0, newsPagesSkipped: 0, pagesNeedingOcr: 0, pagesFailed: 0, pagesAbandoned: 0,
      scannedPages: 0, nativeTextPages: 0,
    };
    const periods: Array<{ mode: string; from: string; to: string; listed: number }> = [];
    let yieldReason: 'TIME_BUDGET_REACHED' | 'SOURCE_BUDGET_REACHED' | undefined;
    let sourceDown: unknown;
    let ocrGate = false;

    const shouldStop = (): boolean => {
      if (context.budget?.shouldYield()) { yieldReason = 'TIME_BUDGET_REACHED'; return true; }
      // Byte budget only after the first page read: every run makes progress.
      if (maxBytes > 0 && counters.pagesRead > 0 && client.downloadedBytes >= maxBytes) {
        yieldReason = 'SOURCE_BUDGET_REACHED';
        return true;
      }
      return false;
    };

    const readPage = async (page: DoeSpLegacyPendingPage): Promise<'DONE' | 'RETRY' | 'GATE'> => {
      try {
        const pdf = await client.downloadPdf(doeSpLegacyPdfUrl(page), context.signal);
        const extracted = await extract(pdf.bytes);
        counters.pagesRead += 1;
        if (!extracted.text && state.needsOcr.length >= MAX_NEEDS_OCR_KEPT) {
          // OCR queue full: the page stays pending (gate), never dropped.
          ocrGate = true;
          return 'GATE';
        }
        state.totals.pagesRead += 1;
        if (extracted.scanned) counters.scannedPages += 1; else counters.nativeTextPages += 1;
        if (!extracted.text) {
          counters.pagesNeedingOcr += 1;
          state.needsOcr.push(stripPage(page));
          return 'DONE';
        }
        const terms = doeSpLegacyTaxTerms(extracted.text, page.date);
        if (!terms.length) {
          counters.pagesWithoutTaxTerms += 1;
          state.totals.pagesWithoutTaxTerms += 1;
          return 'DONE';
        }
        counters.pagesKept += 1;
        state.totals.pagesKept += 1;
        publications.push(buildPublication(page, extracted, terms, pdf, now));
        return 'DONE';
      } catch (error) {
        if (isCancel(error)) throw error;
        if (isSourceLevel(error)) throw new SourceDown(error);
        const attempts = (page.attempts ?? 0) + 1;
        const info = failureInfo(error);
        if (attempts >= DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS) {
          counters.pagesAbandoned += 1;
          partialFailures.push({ code: 'DOE_SP_LEGACY_PAGE_ABANDONED', message: `${info.code}: ${info.message} (after ${attempts} attempts)`, itemReference: page.link });
          return 'DONE';
        }
        counters.pagesFailed += 1;
        page.attempts = attempts;
        partialFailures.push({ code: info.code, message: info.message, itemReference: page.link });
        return 'RETRY';
      }
    };

    /**
     * Reads a queue in place, in order: finished pages leave it, failed pages
     * stay (for the next run). An exception or a gate leaves the unread pages in it.
     */
    const drain = async (queue: DoeSpLegacyPendingPage[]): Promise<void> => {
      let index = 0;
      while (index < queue.length) {
        if (yieldReason || ocrGate || shouldStop()) return;
        const outcome = await readPage(queue[index]!);
        if (outcome === 'DONE') queue.splice(index, 1);
        else if (outcome === 'RETRY') index += 1;
        else return;
      }
    };

    /**
     * Lists the period of `listing` from where it stopped (query + screen).
     * Every screen is fully parsed or the listing stops with a processing
     * error (kept for the next run); the time budget is checked before every
     * request. Returns 'YIELD' when the budget stopped it.
     */
    const continueListing = async (listing: DoeSpLegacyListing): Promise<'DONE' | 'YIELD'> => {
      if (listing.mode === 'SEARCH' && listing.vocabularyVersion !== DOE_SP_LEGACY_VOCABULARY_VERSION) {
        // Vocabulary changed mid-period: list every query again (pages found so far are kept).
        Object.assign(listing, { vocabularyVersion: DOE_SP_LEGACY_VOCABULARY_VERSION, query: 0, screen: 1, attempts: 0 });
        delete listing.screens;
      }
      if (listing.mode === 'BROWSE' && listing.browseCaderno === undefined) {
        if (shouldStop()) return 'YIELD';
        const raw = await client.postAjax(CADERNOS_AJAX, `strData=${brFromIso(listing.from)}\r\nstrBuscaEsp=true`, context.signal);
        counters.cadernoLookups += 1;
        listing.browseCaderno = parseDoeSpLegacyCadernos(raw).find((entry) => entry.name === DOE_SP_LEGACY_BROWSE_CADERNO) ?? null;
      }
      const queries = doeSpLegacyListingQueries(listing);
      const seen = new Set(listing.found.map((page) => page.link));
      const discovery: DoeSpLegacyPendingPage['discovery'] = listing.mode === 'SEARCH' ? 'KEYWORD_SEARCH' : 'EDITION_BROWSE';
      const nextQuery = () => {
        listing.query += 1;
        listing.screen = 1;
        delete listing.screens;
      };
      while (listing.query < queries.length) {
        if (shouldStop()) return 'YIELD';
        const query = queries[listing.query]!;
        const firstUrl = doeSpLegacyResultUrl({ from: listing.from, to: listing.to, caderno: query.caderno, ...(query.keyword ? { keyword: query.keyword } : {}) });
        const response = await client.getHtml(doeSpLegacyResultScreenUrl(firstUrl, listing.screen), context.signal);
        counters.listScreens += 1;
        const parsed = parseDoeSpLegacyResults(response.html, response.url);
        const where = { caderno: query.caderno.id, ...(query.keyword ? { keyword: query.keyword } : {}), screen: listing.screen };
        if (!parsed.found || (listing.screen === 1 && parsed.total === 0 && !parsed.items.length)) {
          // "No results" is only an answer for the first screen of a query.
          if (listing.screen > 1) throw listingError('DOE_SP_LEGACY_RESULT_SCREEN_MISSING', where);
          nextQuery();
          continue;
        }
        if (parsed.malformed > 0) throw listingError('DOE_SP_LEGACY_MALFORMED_RESULT_ITEM', { ...where, malformed: parsed.malformed });
        if (!parsed.items.length) throw listingError('DOE_SP_LEGACY_EMPTY_RESULT_SCREEN', where);
        if (listing.screen === 1) listing.screens = Math.ceil(parsed.total / DOE_SP_LEGACY_RESULTS_PER_SCREEN);
        for (const item of parsed.items) {
          if (seen.has(item.link)) continue;
          seen.add(item.link);
          listing.found.push({ ...item, discovery });
        }
        listing.attempts = 0;
        if (listing.screen >= (listing.screens ?? 1)) nextQuery();
        else listing.screen += 1;
      }
      return 'DONE';
    };

    /** Pages of a fully listed period that are read (in the period, not news). */
    const listedPages = (listing: DoeSpLegacyListing): DoeSpLegacyPendingPage[] => {
      const pages: DoeSpLegacyPendingPage[] = [];
      for (const page of listing.found) {
        if (page.date < listing.from || page.date > listing.to) continue; // defensive: index outside the filter
        if (isDoeSpLegacyNewsPage(page.link)) {
          counters.newsPagesSkipped += 1;
          state.totals.newsPagesSkipped += 1;
          continue;
        }
        pages.push(page);
      }
      return pages.sort((a, b) => a.date.localeCompare(b.date) || Number(a.paginaOrdenacao) - Number(b.paginaOrdenacao) || a.link.localeCompare(b.link));
    };

    try {
      await drain(state.retry);
      await drain(state.pending);
      const maxPeriods = this.#options.maxPeriodsPerRun ?? 0;
      while (!yieldReason && !ocrGate && !state.pending.length && (state.listing || state.cursor !== null || state.searchCursor !== null)) {
        if (shouldStop()) break;
        if (!state.listing) {
          if (maxPeriods > 0 && counters.periodsListed >= maxPeriods) { yieldReason = 'TIME_BUDGET_REACHED'; break; }
          state.listing = newListing(doeSpLegacyNextPeriod(state)!);
        }
        const listing = state.listing;
        let outcome: 'DONE' | 'YIELD';
        try {
          outcome = await continueListing(listing);
        } catch (error) {
          if (isCancel(error)) throw error;
          if (isSourceLevel(error)) throw new SourceDown(error);
          // The screen could not be fully read: the period stays blocked on it
          // (same query and screen next run), the cursor does not move.
          listing.attempts += 1;
          const info = failureInfo(error);
          const at = `${listing.from}..${listing.to} query=${listing.query} screen=${listing.screen}`;
          partialFailures.push(listing.attempts >= DOE_SP_LEGACY_LISTING_BLOCKED_AFTER
            ? { code: 'DOE_SP_LEGACY_LISTING_BLOCKED', message: `${info.code}: ${info.message} (after ${listing.attempts} attempts)`, itemReference: at }
            : { code: info.code, message: info.message, itemReference: at });
          break;
        }
        if (outcome === 'YIELD') break;
        const pages = listedPages(listing);
        counters.periodsListed += 1;
        periods.push({ mode: listing.mode, from: listing.from, to: listing.to, listed: pages.length });
        if (listing.mode === 'SEARCH') state.searchCursor = listing.next;
        else state.cursor = listing.next;
        state.listing = null;
        state.pending = pages;
        await drain(state.pending);
      }
    } catch (error) {
      if (error instanceof SourceDown) {
        sourceDown = error.cause;
        const info = failureInfo(error.cause);
        partialFailures.push({ code: info.code, message: info.message, itemReference: 'source' });
      } else {
        throw error;
      }
    }

    if (ocrGate) {
      partialFailures.push({
        code: 'DOE_SP_LEGACY_NEEDS_OCR_FULL',
        message: `needsOcr holds ${state.needsOcr.length} pages (limit ${MAX_NEEDS_OCR_KEPT}); the OCR pass must drain it before more pages are read`,
        itemReference: 'needsOcr',
      });
    }

    // Nothing at all could be read from the archive: unavailability, never "0 results".
    const anyProgress = counters.pagesRead > 0 || counters.listScreens > 0 || counters.cadernoLookups > 0;
    if (sourceDown instanceof ConnectorError && !anyProgress) {
      throw sourceDown;
    }

    const pendingPages = state.pending.length + state.retry.length;
    const archiveListed = state.cursor === null && state.searchCursor === null && state.listing === null;
    const pending: Record<string, number> = {
      pendingPages,
      ...(state.cursor !== null ? { cursorDate: Number(state.cursor.replace(/-/g, '')) } : {}),
      ...(state.searchCursor !== null ? { searchCursorDate: Number(state.searchCursor.replace(/-/g, '')) } : {}),
      ...(state.listing ? { listingQuery: state.listing.query, listingScreen: state.listing.screen } : {}),
    };
    // Abandoned pages are reported, not retried; everything else asks for a retry.
    const retryRequired = sourceDown !== undefined || partialFailures.some((failure) => failure.code !== 'DOE_SP_LEGACY_PAGE_ABANDONED');
    const completion: ConnectorResult['completion'] | undefined = yieldReason
      ? { complete: false, reason: yieldReason, pending }
      : retryRequired || !archiveListed || pendingPages > 0
        ? { complete: false, reason: 'PARTIAL_FAILURE_RETRY_REQUIRED', pending }
        : undefined;

    const nextState: DoeSpLegacySourceState = {
      ...state,
      ...(!partialFailures.length && !completion ? { lastSuccessAt: now.toISOString() } : {}),
    };

    return {
      publications,
      ...(partialFailures.length ? { partialFailures } : {}),
      metadata: {
        doeSpLegacy: {
          coverage: { from: state.coverageFrom, to: state.coverageTo },
          cursor: state.cursor,
          searchCursor: state.searchCursor,
          archiveListed,
          periods,
          listing: state.listing
            ? { mode: state.listing.mode, from: state.listing.from, to: state.listing.to, query: state.listing.query, queries: doeSpLegacyListingQueries(state.listing).length, screen: state.listing.screen, found: state.listing.found.length, attempts: state.listing.attempts }
            : null,
          pendingPages,
          needsOcr: state.needsOcr.length,
          ocrGate,
          totals: state.totals,
          counters: { ...counters, requests: client.requestCount, downloadedBytes: client.downloadedBytes },
          sourceLimits: {
            minRequestIntervalMs: this.#options.client?.minRequestIntervalMs ?? 0,
            maxDownloadBytesPerRun: maxBytes,
            reached: yieldReason === 'SOURCE_BUDGET_REACHED',
          },
          partialFailureCount: partialFailures.length,
        },
      },
      ...(completion ? { completion } : {}),
      checkpoint: { version: DOE_SP_LEGACY_STATE_VERSION, state: nextState as unknown as Record<string, unknown> },
    };
  }
}

function stripPage(page: DoeSpLegacyPendingPage): DoeSpLegacyPageRef {
  return { link: page.link, pagina: page.pagina, date: page.date, caderno: page.caderno, paginaOrdenacao: page.paginaOrdenacao };
}

function buildPublication(
  page: DoeSpLegacyPendingPage,
  extracted: DoeSpLegacyPageText,
  terms: string[],
  pdf: { rawSha256: string; sizeBytes: number },
  now: Date,
): ConnectorPublication {
  return {
    title: `Diário Oficial do Estado de São Paulo — ${page.caderno} — ${brFromIso(page.date)} — página ${page.pagina}`,
    agency: 'Governo do Estado de São Paulo',
    sphere: 'STATE',
    stateCode: 'SP',
    actType: 'PÁGINA DO DIÁRIO OFICIAL',
    publishedAt: new Date(page.date + 'T00:00:00Z'),
    content: extracted.text,
    officialUrl: doeSpLegacyViewerUrl(page),
    externalId: page.link,
    // The PDF is provenance only (not stored); the version is the page text.
    contentHashPolicy: 'HTML_PRIMARY_MATERIAL_FILES',
    files: [{
      url: doeSpLegacyPdfUrl(page),
      mimeType: 'application/pdf',
      rawSha256: pdf.rawSha256,
      sizeBytes: pdf.sizeBytes,
      versionRole: 'PROVENANCE',
      metadata: { kind: 'LEGACY_PAGE_PDF', stored: false, capturedAt: now.toISOString(), origin: 'DOE_SP_LEGACY' },
    }],
    metadata: {
      sourceRole: 'LEGACY_ARCHIVE',
      archive: 'IMPRENSA_OFICIAL_DO',
      caderno: page.caderno,
      doeDate: page.date,
      pagina: page.pagina,
      paginaOrdenacao: page.paginaOrdenacao,
      archiveLink: page.link,
      discovery: page.discovery,
      textExtraction: extracted.extraction,
      scanned: extracted.scanned,
      textChars: extracted.text.length,
      matchedTaxTerms: terms,
    },
    originMetadata: {
      contentRepresentation: 'PDF_TEXT_NOT_STORED',
    },
  };
}
