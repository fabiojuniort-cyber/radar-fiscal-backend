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
import { DOE_SP_LEGACY_SEARCH_TERMS, doeSpLegacyTaxTerms, isDoeSpLegacyNewsPage } from './doe-sp-legacy.rules.js';
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
 * Discovery (measured on the source, DOE-SP-LEGACY-02/03):
 * - from 2003 on (SEARCH): the portal's keyword index, one query per tax term,
 *   per month and per Executivo caderno; results merged by page;
 * - before 2003 (BROWSE): the index does not answer, so each edition of
 *   Executivo I (Seção I, where normative acts are printed) is listed whole
 *   per date and every page is read and filtered locally.
 * Every downloaded page is confirmed locally with the tax vocabulary before
 * it becomes a publication.
 */

export const DOE_SP_LEGACY_CONNECTOR_KEY = 'doe-sp-legacy';
export const DOE_SP_LEGACY_STATE_VERSION = 1;

export const DOE_SP_LEGACY_DEFAULT_START = '1988-01-01';
/** Day before the current platform (doe-sp DOE_SP_PLATFORM_START). */
export const DOE_SP_LEGACY_END = '2023-06-30';
/** First month answered by the portal's keyword index (measured 09/2026). */
export const DOE_SP_LEGACY_SEARCH_INDEX_START = '2003-01-01';

export const DOE_SP_LEGACY_DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_000;
export const DOE_SP_LEGACY_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN = 200 * 1024 * 1024;
/** Attempts before a page that keeps failing is abandoned (reported, not retried). */
export const DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS = 3;

/** Executivo cadernos queried in SEARCH mode (the index filters by name + id). */
export const DOE_SP_LEGACY_SEARCH_CADERNOS: readonly DoeSpLegacyCaderno[] = [
  { id: 'ex1', name: 'Executivo I' },
  { id: 'ex2', name: 'Executivo II' },
  { id: 'ex3', name: 'Executivo III' },
];
/** Caderno listed whole in BROWSE mode. */
export const DOE_SP_LEGACY_BROWSE_CADERNO = 'Executivo I';

const CADERNOS_AJAX = '/ajax/ImprensaOficial.PortalIO.DODigitalAjax,PortalIO.ashx?_method=GetCadernos&_session=no';
const DAY_MS = 86_400_000;

export interface DoeSpLegacyPendingPage extends DoeSpLegacyPageRef {
  discovery: 'KEYWORD_SEARCH' | 'EDITION_BROWSE';
  attempts?: number;
}

export interface DoeSpLegacySourceState {
  coverageFrom: string;
  coverageTo: string;
  /**
   * Next period to list: a date (BROWSE, before the index start) or the first
   * day of a month (SEARCH). null = the whole archive range was listed.
   */
  cursor: string | null;
  /** Listed pages still to be read (from the last listed period). */
  pending: DoeSpLegacyPendingPage[];
  /** Pages whose publication failed to persist in the engine (reopened). */
  retry: DoeSpLegacyPendingPage[];
  /** Pages kept for a later OCR pass (scan without any text layer). */
  needsOcr: DoeSpLegacyPageRef[];
  needsOcrTruncated: number;
  totals: { pagesRead: number; pagesKept: number; pagesWithoutTaxTerms: number; newsPagesSkipped: number };
  lastSuccessAt?: string;
}

export const MAX_NEEDS_OCR_KEPT = 5_000;

export function emptyDoeSpLegacyState(coverageFrom = DOE_SP_LEGACY_DEFAULT_START): DoeSpLegacySourceState {
  return {
    coverageFrom,
    coverageTo: DOE_SP_LEGACY_END,
    cursor: coverageFrom,
    pending: [],
    retry: [],
    needsOcr: [],
    needsOcrTruncated: 0,
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
 * DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS (default 1000) and
 * DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN (default 200 MiB; 0 = unlimited).
 */
export function resolveDoeSpLegacySourceLimits(env: NodeJS.ProcessEnv = process.env): {
  minRequestIntervalMs: number;
  maxDownloadBytesPerRun: number;
} {
  return {
    minRequestIntervalMs: envInteger('DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS', DOE_SP_LEGACY_DEFAULT_MIN_REQUEST_INTERVAL_MS, 0, 10_000, env),
    maxDownloadBytesPerRun: envInteger('DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN', DOE_SP_LEGACY_DEFAULT_MAX_DOWNLOAD_BYTES_PER_RUN, 0, 10 * 1024 * 1024 * 1024, env),
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

/** Period starting at `cursor`: one day (BROWSE) or the rest of its month (SEARCH). */
export function doeSpLegacyPeriod(cursor: string, coverageTo: string): { mode: 'BROWSE' | 'SEARCH'; from: string; to: string; next: string | null } {
  if (cursor < DOE_SP_LEGACY_SEARCH_INDEX_START) {
    const next = addLegacyDays(cursor, 1);
    return { mode: 'BROWSE', from: cursor, to: cursor, next: next > coverageTo ? null : next };
  }
  const end = monthEnd(cursor) < coverageTo ? monthEnd(cursor) : coverageTo;
  const next = addLegacyDays(end, 1);
  return { mode: 'SEARCH', from: cursor, to: end, next: next > coverageTo ? null : monthStart(next) };
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
      pending: loaded.pending.map((page) => ({ ...page })),
      retry: loaded.retry.map((page) => ({ ...page })),
      needsOcr: [...loaded.needsOcr],
      totals: { ...loaded.totals },
    };
    // A start date earlier than the covered range re-opens the head of the archive.
    if (start < state.coverageFrom) {
      state.coverageFrom = start;
      state.cursor = start;
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

    const shouldStop = (): boolean => {
      if (context.budget?.shouldYield()) { yieldReason = 'TIME_BUDGET_REACHED'; return true; }
      // Byte budget only after the first page read: every run makes progress.
      if (maxBytes > 0 && counters.pagesRead > 0 && client.downloadedBytes >= maxBytes) {
        yieldReason = 'SOURCE_BUDGET_REACHED';
        return true;
      }
      return false;
    };

    const readPage = async (page: DoeSpLegacyPendingPage): Promise<'DONE' | 'RETRY'> => {
      try {
        const pdf = await client.downloadPdf(doeSpLegacyPdfUrl(page), context.signal);
        const extracted = await extract(pdf.bytes);
        counters.pagesRead += 1;
        state.totals.pagesRead += 1;
        if (extracted.scanned) counters.scannedPages += 1; else counters.nativeTextPages += 1;
        if (!extracted.text) {
          counters.pagesNeedingOcr += 1;
          if (state.needsOcr.length < MAX_NEEDS_OCR_KEPT) state.needsOcr.push(stripPage(page));
          else state.needsOcrTruncated += 1;
          return 'DONE';
        }
        const terms = doeSpLegacyTaxTerms(extracted.text);
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

    /** Reads a queue in order; failed pages stay in it for the next run. */
    const drain = async (queue: DoeSpLegacyPendingPage[]): Promise<DoeSpLegacyPendingPage[]> => {
      const left: DoeSpLegacyPendingPage[] = [];
      for (let index = 0; index < queue.length; index += 1) {
        const page = queue[index]!;
        if (yieldReason || shouldStop()) { left.push(...queue.slice(index)); break; }
        if ((await readPage(page)) === 'RETRY') left.push(page);
      }
      return left;
    };

    const listScreens = async (firstUrl: string, discovery: DoeSpLegacyPendingPage['discovery'], into: Map<string, DoeSpLegacyPendingPage>): Promise<void> => {
      const first = await client.getHtml(firstUrl, context.signal);
      counters.listScreens += 1;
      const page1 = parseDoeSpLegacyResults(first.html, first.url);
      if (!page1.found) return;
      const add = (items: DoeSpLegacyPageRef[]) => {
        for (const item of items) {
          if (into.has(item.link)) continue;
          into.set(item.link, { ...item, discovery });
        }
      };
      add(page1.items);
      const screens = Math.ceil(page1.total / DOE_SP_LEGACY_RESULTS_PER_SCREEN);
      for (let screen = 2; screen <= screens; screen += 1) {
        const next = await client.getHtml(doeSpLegacyResultScreenUrl(firstUrl, screen), context.signal);
        counters.listScreens += 1;
        const parsed = parseDoeSpLegacyResults(next.html, next.url);
        if (!parsed.found || !parsed.items.length) break;
        add(parsed.items);
      }
      if (page1.malformed) {
        partialFailures.push({ code: 'DOE_SP_LEGACY_MALFORMED_RESULT_ITEM', message: `${page1.malformed} result link(s) not parsed`, itemReference: firstUrl });
      }
    };

    /** Lists every candidate page of a period (no page is read here). */
    const listPeriod = async (period: ReturnType<typeof doeSpLegacyPeriod>): Promise<DoeSpLegacyPendingPage[]> => {
      const found = new Map<string, DoeSpLegacyPendingPage>();
      if (period.mode === 'BROWSE') {
        counters.cadernoLookups += 1;
        const raw = await client.postAjax(CADERNOS_AJAX, `strData=${brFromIso(period.from)}\r\nstrBuscaEsp=true`, context.signal);
        const caderno = parseDoeSpLegacyCadernos(raw).find((entry) => entry.name === DOE_SP_LEGACY_BROWSE_CADERNO);
        if (caderno) {
          await listScreens(doeSpLegacyResultUrl({ from: period.from, to: period.to, caderno }), 'EDITION_BROWSE', found);
        }
      } else {
        for (const caderno of DOE_SP_LEGACY_SEARCH_CADERNOS) {
          for (const term of DOE_SP_LEGACY_SEARCH_TERMS) {
            await listScreens(doeSpLegacyResultUrl({ from: period.from, to: period.to, caderno, keyword: term }), 'KEYWORD_SEARCH', found);
          }
        }
      }
      const pages: DoeSpLegacyPendingPage[] = [];
      for (const page of found.values()) {
        if (page.date < period.from || page.date > period.to) continue; // defensive: index outside the filter
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
      state.retry = await drain(state.retry);
      state.pending = await drain(state.pending);
      while (!yieldReason && state.cursor !== null && !state.pending.length) {
        if (shouldStop()) break;
        const period = doeSpLegacyPeriod(state.cursor, state.coverageTo);
        let pages: DoeSpLegacyPendingPage[];
        try {
          pages = await listPeriod(period);
        } catch (error) {
          if (isCancel(error)) throw error;
          if (isSourceLevel(error)) throw new SourceDown(error);
          // Unknown page shape: stop here, the period is listed again next run.
          const info = failureInfo(error);
          partialFailures.push({ code: info.code, message: info.message, itemReference: `${period.from}..${period.to}` });
          break;
        }
        counters.periodsListed += 1;
        periods.push({ mode: period.mode, from: period.from, to: period.to, listed: pages.length });
        state.cursor = period.next;
        state.pending = await drain(pages);
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

    // Nothing at all could be read from the archive: unavailability, never "0 results".
    if (sourceDown instanceof ConnectorError && counters.pagesRead === 0 && counters.periodsListed === 0) {
      throw sourceDown;
    }

    const pendingPages = state.pending.length + state.retry.length;
    const archiveListed = state.cursor === null;
    const pending = { pendingPages, ...(archiveListed ? {} : { cursorDate: Number(state.cursor!.replace(/-/g, '')) }) };
    // Abandoned pages and unparsed result links are reported, not retried.
    const retryRequired = sourceDown !== undefined || partialFailures.some(
      (failure) => failure.code !== 'DOE_SP_LEGACY_PAGE_ABANDONED' && failure.code !== 'DOE_SP_LEGACY_MALFORMED_RESULT_ITEM',
    );
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
          archiveListed,
          periods,
          pendingPages,
          needsOcr: state.needsOcr.length + state.needsOcrTruncated,
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
