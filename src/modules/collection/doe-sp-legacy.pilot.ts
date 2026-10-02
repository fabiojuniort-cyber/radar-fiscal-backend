import { ConnectorError } from './connector.error.js';
import { DoeSpLegacyClient, type DoeSpLegacyClientOptions } from './doe-sp-legacy.client.js';
import { DOE_SP_LEGACY_SEARCH_INDEX_START } from './doe-sp-legacy.connector.js';
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
 * Dry pilot of the legacy DOE-SP archive (Issue #20, before activating the
 * source). Reads the official portal only — nothing is written to the
 * database — and reports, page by page, what the connector's rules would keep:
 *
 * - browse dates: the whole Executivo I edition of the day is listed and every
 *   page is read and classified (KEPT / NO_TAX_TERMS / NEEDS_OCR / NEWS /
 *   ERROR), with the public viewer link so a person can audit the decision;
 * - compare dates (2003 on): the same edition is classified AND the keyword
 *   index is queried for the day with every search term, in the same caderno.
 *   Every page kept by the local filter must be among the search hits; the
 *   pages that are not are reported as `missedBySearch` (review
 *   DOE-SP-LEGACY-04: index behaviour with accents/hyphens must be measured
 *   before the backfill).
 *
 * Each date is run for every caderno asked (default Executivo I; Executivo II
 * and III measured in DOE-SP-LEGACY-10 to decide whether they are browsed too).
 *
 * The report carries public data only (links, page numbers, matched terms,
 * sizes); no page text is printed.
 */

const CADERNOS_AJAX = '/ajax/ImprensaOficial.PortalIO.DODigitalAjax,PortalIO.ashx?_method=GetCadernos&_session=no';

/** Executivo cadernos the pilot can measure (id as used by the keyword index). */
export const DOE_SP_LEGACY_PILOT_CADERNOS: readonly DoeSpLegacyCaderno[] = [
  { id: 'ex1', name: 'Executivo I' },
  { id: 'ex2', name: 'Executivo II' },
  { id: 'ex3', name: 'Executivo III' },
];

export type DoeSpLegacyPilotOutcome = 'KEPT' | 'NO_TAX_TERMS' | 'NEEDS_OCR' | 'NEWS' | 'ERROR';

export interface DoeSpLegacyPilotPage {
  date: string;
  pagina: string;
  link: string;
  viewerUrl: string;
  outcome: DoeSpLegacyPilotOutcome;
  extraction?: DoeSpLegacyPageText['extraction'];
  scanned?: boolean;
  textChars?: number;
  pdfBytes?: number;
  matchedTaxTerms?: string[];
  error?: string;
}

export interface DoeSpLegacyPilotDay {
  date: string;
  caderno: string;
  mode: 'BROWSE' | 'COMPARE';
  edition: boolean;
  pages: DoeSpLegacyPilotPage[];
  counts: Record<DoeSpLegacyPilotOutcome, number>;
  /** COMPARE only. */
  search?: { queries: number; hits: number; keptFoundBySearch: number; missedBySearch: string[] };
}

export interface DoeSpLegacyPilotReport {
  days: DoeSpLegacyPilotDay[];
  totals: Record<DoeSpLegacyPilotOutcome, number> & { missedBySearch: number };
  requests: number;
  downloadedBytes: number;
}

export interface DoeSpLegacyPilotOptions {
  browseDates: string[];
  compareDates: string[];
  /** Caderno ids (ex1/ex2/ex3) to measure on every date; default ex1. */
  cadernos?: string[];
  fetch?: typeof fetch;
  client?: Omit<DoeSpLegacyClientOptions, 'fetch'>;
  signal?: AbortSignal;
  /** Test seam. */
  extractText?: (bytes: Uint8Array) => Promise<DoeSpLegacyPageText>;
  /** Called with every finished page (streaming output). */
  onPage?: (page: DoeSpLegacyPilotPage) => void;
}

function emptyCounts(): Record<DoeSpLegacyPilotOutcome, number> {
  return { KEPT: 0, NO_TAX_TERMS: 0, NEEDS_OCR: 0, NEWS: 0, ERROR: 0 };
}

function errorText(error: unknown): string {
  if (error instanceof ConnectorError) return error.code;
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

export async function runDoeSpLegacyPilot(options: DoeSpLegacyPilotOptions): Promise<DoeSpLegacyPilotReport> {
  for (const date of [...options.browseDates, ...options.compareDates]) {
    if (!isIsoDate(date)) throw new RangeError(`invalid date ${date}`);
  }
  for (const date of options.compareDates) {
    if (date < DOE_SP_LEGACY_SEARCH_INDEX_START) {
      throw new RangeError(`compare dates must be on or after ${DOE_SP_LEGACY_SEARCH_INDEX_START} (keyword index): ${date}`);
    }
  }
  const cadernoIds = options.cadernos?.length ? options.cadernos : ['ex1'];
  const cadernos = cadernoIds.map((id) => {
    const caderno = DOE_SP_LEGACY_PILOT_CADERNOS.find((entry) => entry.id === id);
    if (!caderno) throw new RangeError(`unknown caderno ${id} (use ${DOE_SP_LEGACY_PILOT_CADERNOS.map((c) => c.id).join(', ')})`);
    return caderno;
  });
  if (new Set(cadernoIds).size !== cadernoIds.length) throw new RangeError('duplicate caderno');
  const signal = options.signal ?? new AbortController().signal;
  const client = new DoeSpLegacyClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.client ?? {}),
  });
  const extract = options.extractText ?? extractDoeSpLegacyPdfText;

  /** Every screen of a result list, strictly (a malformed or empty screen fails the day). */
  const listAll = async (firstUrl: string): Promise<DoeSpLegacyPageRef[]> => {
    const out = new Map<string, DoeSpLegacyPageRef>();
    let screens = 1;
    for (let screen = 1; screen <= screens; screen += 1) {
      const response = await client.getHtml(doeSpLegacyResultScreenUrl(firstUrl, screen), signal);
      const parsed = parseDoeSpLegacyResults(response.html, response.url);
      if (!parsed.found) {
        if (screen === 1) return [];
        throw new ConnectorError('DOE_SP_LEGACY_RESULT_SCREEN_MISSING', { code: 'DOE_SP_LEGACY_RESULT_SCREEN_MISSING', kind: 'PROCESSING_ERROR', retryable: false });
      }
      if (parsed.malformed > 0 || (parsed.total > 0 && !parsed.items.length)) {
        throw new ConnectorError('DOE_SP_LEGACY_INCOMPLETE_RESULT_SCREEN', { code: 'DOE_SP_LEGACY_INCOMPLETE_RESULT_SCREEN', kind: 'PROCESSING_ERROR', retryable: false });
      }
      if (screen === 1) screens = Math.ceil(parsed.total / DOE_SP_LEGACY_RESULTS_PER_SCREEN);
      for (const item of parsed.items) out.set(item.link, item);
    }
    return [...out.values()];
  };

  const classify = async (page: DoeSpLegacyPageRef): Promise<DoeSpLegacyPilotPage> => {
    const base = { date: page.date, pagina: page.pagina, link: page.link, viewerUrl: doeSpLegacyViewerUrl(page) };
    if (isDoeSpLegacyNewsPage(page.link)) return { ...base, outcome: 'NEWS' };
    try {
      const pdf = await client.downloadPdf(doeSpLegacyPdfUrl(page), signal);
      const text = await extract(pdf.bytes);
      const common = { extraction: text.extraction, scanned: text.scanned, textChars: text.text.length, pdfBytes: pdf.sizeBytes };
      if (!text.text) return { ...base, ...common, outcome: 'NEEDS_OCR' };
      const terms = doeSpLegacyTaxTerms(text.text, page.date);
      return terms.length
        ? { ...base, ...common, outcome: 'KEPT', matchedTaxTerms: terms }
        : { ...base, ...common, outcome: 'NO_TAX_TERMS' };
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
      return { ...base, outcome: 'ERROR', error: errorText(error) };
    }
  };

  const edition = async (date: string, name: string): Promise<{ edition: boolean; pages: DoeSpLegacyPilotPage[] }> => {
    const raw = await client.postAjax(CADERNOS_AJAX, `strData=${brFromIso(date)}\r\nstrBuscaEsp=true`, signal);
    const caderno = parseDoeSpLegacyCadernos(raw).find((entry) => entry.name === name);
    if (!caderno) return { edition: false, pages: [] };
    const refs = (await listAll(doeSpLegacyResultUrl({ from: date, to: date, caderno })))
      .filter((ref) => ref.date === date)
      .sort((a, b) => Number(a.paginaOrdenacao) - Number(b.paginaOrdenacao) || a.link.localeCompare(b.link));
    const pages: DoeSpLegacyPilotPage[] = [];
    for (const ref of refs) {
      const page = await classify(ref);
      pages.push(page);
      options.onPage?.(page);
    }
    return { edition: true, pages };
  };

  const days: DoeSpLegacyPilotDay[] = [];
  for (const [mode, dates] of [['BROWSE', options.browseDates], ['COMPARE', options.compareDates]] as const) {
    for (const date of dates) for (const caderno of cadernos) {
      const listed = await edition(date, caderno.name);
      const counts = emptyCounts();
      for (const page of listed.pages) counts[page.outcome] += 1;
      const day: DoeSpLegacyPilotDay = { date, caderno: caderno.name, mode, edition: listed.edition, pages: listed.pages, counts };
      if (mode === 'COMPARE') {
        const hits = new Set<string>();
        for (const keyword of DOE_SP_LEGACY_SEARCH_TERMS) {
          const refs = await listAll(doeSpLegacyResultUrl({ from: date, to: date, caderno, keyword }));
          for (const ref of refs) if (ref.date === date) hits.add(ref.link);
        }
        const kept = listed.pages.filter((page) => page.outcome === 'KEPT');
        const missed = kept.filter((page) => !hits.has(page.link)).map((page) => page.link);
        day.search = {
          queries: DOE_SP_LEGACY_SEARCH_TERMS.length,
          hits: hits.size,
          keptFoundBySearch: kept.length - missed.length,
          missedBySearch: missed,
        };
      }
      days.push(day);
    }
  }

  const totals = { ...emptyCounts(), missedBySearch: 0 };
  for (const day of days) {
    for (const [outcome, n] of Object.entries(day.counts)) totals[outcome as DoeSpLegacyPilotOutcome] += n;
    totals.missedBySearch += day.search?.missedBySearch.length ?? 0;
  }
  return { days, totals, requests: client.requestCount, downloadedBytes: client.downloadedBytes };
}
