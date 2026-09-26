import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorFile,
  ConnectorPartialFailure,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import {
  DOE_SP_PDF_API,
  DOE_SP_SEARCH_API,
  DoeSpClient,
  attachmentUrl,
  authenticatedPdfUrl,
  normalizeDoeSpApiUrl,
  publicationPageUrl,
  type DoeSpClientOptions,
} from './doe-sp.client.js';
import {
  doeSpEmenta,
  doeSpHtmlText,
  doeSpIdsHash,
  findDoeSpNamed,
  parseDoeSpDetail,
  parseDoeSpEditionStatus,
  parseDoeSpEditionUrl,
  parseDoeSpList,
  parseDoeSpNamedItems,
  parseDoeSpStructured,
  parseDoeSpSupplementaryUrls,
  parseDoeSpTypeCatalogue,
  type DoeSpListItem,
} from './doe-sp.parser.js';
import {
  decideDoeSpCapture,
  doeSpActType,
  doeSpNormativeIdentity,
  doeSpOrgan,
  doeSpTitleDate,
  type DoeSpInclusionCategory,
} from './doe-sp.rules.js';

export const DOE_SP_CONNECTOR_KEY = 'doe-sp';
export const DOE_SP_STATE_VERSION = 1;

/** First day available in the current DOE-SP platform (earlier = legacy Imprensa Oficial). */
export const DOE_SP_PLATFORM_START = '2023-07-01';
export const DOE_SP_JOURNAL = 'Executivo';
export const DOE_SP_SECTION = 'Atos Normativos';
/**
 * Measured on the source (09/2026): supplements are published on the same
 * date; extra editions also happen on weekends (e.g. 13/09/2026, Sunday).
 * Three days cover a Friday -> Monday gap plus one re-check of each date.
 */
export const DOE_SP_DEFAULT_LOOKBACK_DAYS = 3;
const MAX_EXCLUDED_SAMPLES = 200;
const DAY_MS = 86_400_000;

export interface DoeSpDayState {
  /** Fingerprint of the day's publication ids when the day was last fully processed. */
  idsHash: string;
  total: number;
  /** Included DOE ids already turned into publications (never re-downloaded). */
  included: string[];
  checkedAt: string;
}

export interface DoeSpDateRange { from: string; to: string }

export interface DoeSpSourceState {
  /** Earliest date the source must cover (bootstrap target). */
  coverageFrom: string | null;
  /** Last date processed by the incremental window. */
  windowEnd: string | null;
  /** Dates still to be processed once (bootstrap or gap), ascending. */
  pendingRanges: DoeSpDateRange[];
  /** Incremental window only (pruned every run). */
  days: Record<string, DoeSpDayState>;
  lastSuccessAt?: string;
}

export const EMPTY_DOE_SP_STATE: DoeSpSourceState = {
  coverageFrom: null,
  windowEnd: null,
  pendingRanges: [],
  days: {},
};

export interface DoeSpConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<DoeSpSourceState>;
  lookbackDays?: number;
  bootstrapStartDate?: string;
  /** Ignore day fingerprints/known ids (replay gate). Also DOE_SP_FORCE_REPROCESS_UNTIL. */
  forceReprocess?: boolean;
  client?: Omit<DoeSpClientOptions, 'fetch'>;
}

interface DayOutcome {
  date: string;
  mode: 'WINDOW' | 'BACKFILL';
  discovered: number;
  included: number;
  excluded: number;
  newIncluded: number;
  published: number;
  failed: number;
  malformed: number;
  skippedUnchanged: boolean;
  complete: boolean;
  yielded: boolean;
  idsHash?: string;
  processedIds: string[];
}

interface Filtering {
  discoveredCount: number;
  includedCount: number;
  excludedCount: number;
  includedByCategory: Record<string, number>;
  excludedByReason: Record<string, number>;
  excludedSamples: Array<{ date: string; id: string; organ: string; reason: string }>;
  excludedSamplesTruncated: number;
}

class BudgetReached extends Error {}

// ------------------------------------------------------------------ dates

export function saoPauloDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) out.push(date);
  return out;
}

function validIsoDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function resolveLookbackDays(value?: number): number {
  const raw = value ?? Number(process.env.DOE_SP_LOOKBACK_DAYS ?? DOE_SP_DEFAULT_LOOKBACK_DAYS);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 30) {
    throw new RangeError('DOE_SP_LOOKBACK_DAYS must be an integer between 1 and 30');
  }
  return raw;
}

function resolveBootstrapStart(value: string | undefined, windowStart: string): string {
  const raw = value ?? process.env.DOE_SP_BOOTSTRAP_START_DATE;
  if (raw === undefined || raw === '') return windowStart;
  if (!validIsoDate(raw)) throw new RangeError('DOE_SP_BOOTSTRAP_START_DATE must be YYYY-MM-DD');
  return raw < DOE_SP_PLATFORM_START ? DOE_SP_PLATFORM_START : raw;
}

function resolveForce(value: boolean | undefined, now: Date): boolean {
  if (value !== undefined) return value;
  const until = process.env.DOE_SP_FORCE_REPROCESS_UNTIL;
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && now.getTime() < at;
}

/** Adds [from, to] to the queue (ascending, merged). */
function pushRange(ranges: DoeSpDateRange[], from: string, to: string): DoeSpDateRange[] {
  if (from > to) return ranges;
  const all = [...ranges, { from, to }].sort((a, b) => a.from.localeCompare(b.from));
  const merged: DoeSpDateRange[] = [];
  for (const range of all) {
    const last = merged.at(-1);
    if (last && range.from <= addDays(last.to, 1)) {
      if (range.to > last.to) last.to = range.to;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

// ------------------------------------------------------------------ helpers

function failureInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) {
    if (error.code === 'DOE_SP_HTTP_ERROR') {
      const endpoint = typeof error.metadata?.endpoint === 'string' ? error.metadata.endpoint : undefined;
      const contentType = typeof error.metadata?.contentType === 'string' ? error.metadata.contentType : undefined;
      const responseSample = typeof error.metadata?.responseSample === 'string' ? error.metadata.responseSample : undefined;
      const diagnostics = [
        error.httpStatus !== undefined ? `status=${error.httpStatus}` : undefined,
        endpoint ? `endpoint=${endpoint}` : undefined,
        contentType ? `contentType=${contentType}` : undefined,
        responseSample ? `responseSample=${JSON.stringify(responseSample)}` : undefined,
      ].filter((value): value is string => Boolean(value));

      return {
        code: error.code,
        message: diagnostics.length ? `${error.message} [${diagnostics.join('; ')}]` : error.message,
      };
    }
    return { code: error.code, message: error.message };
  }
  return { code: 'DOE_SP_UNHANDLED_ERROR', message: error instanceof Error ? error.message : 'Unknown DOE-SP error' };
}

function isCancel(error: unknown): boolean {
  return error instanceof ConnectorError && error.kind === 'CANCELLED';
}

/** Unavailability of the source itself (as opposed to a malformed item). */
function isSourceLevel(error: unknown): boolean {
  return error instanceof ConnectorError &&
    ['SOURCE_UNAVAILABLE', 'NETWORK_ERROR', 'RATE_LIMITED'].includes(error.kind);
}

/** Heuristic only: supplement/extra-edition acts are listed with a midnight timestamp. */
function editionHint(item: DoeSpListItem): 'REGULAR' | 'SUPPLEMENTARY_OR_EXTRA' {
  return /T00:00:00(?:\.0+)?$/.test(item.date) ? 'SUPPLEMENTARY_OR_EXTRA' : 'REGULAR';
}

interface EditionInfo {
  editionId?: string;
  editionAuthCode?: string;
  volume?: number;
  number?: number;
  editionPdfUrl?: string;
  supplementaryEditionCount: number;
  supplementaryPdfUrls: string[];
}

// ------------------------------------------------------------------ connector

export class DoeSpConnector implements CollectionConnector {
  readonly key = DOE_SP_CONNECTOR_KEY;
  readonly version = '1.0.0';
  readonly #options: DoeSpConnectorOptions;

  constructor(options: DoeSpConnectorOptions = {}) {
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const loaded = await this.#options.readState?.(context.sourceId) ?? EMPTY_DOE_SP_STATE;
    const state: DoeSpSourceState = {
      coverageFrom: loaded.coverageFrom,
      windowEnd: loaded.windowEnd,
      pendingRanges: loaded.pendingRanges.map((range) => ({ ...range })),
      days: { ...loaded.days },
      ...(loaded.lastSuccessAt ? { lastSuccessAt: loaded.lastSuccessAt } : {}),
    };
    const lookbackDays = resolveLookbackDays(this.#options.lookbackDays);
    const today = saoPauloDate(now);
    const windowStart = addDays(today, -(lookbackDays - 1));
    const bootstrapStart = resolveBootstrapStart(this.#options.bootstrapStartDate, windowStart);
    const force = resolveForce(this.#options.forceReprocess, now);
    const client = new DoeSpClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });

    // ---- coverage planning (bootstrap target, gaps after downtime)
    if (state.coverageFrom === null) {
      state.pendingRanges = pushRange(state.pendingRanges, bootstrapStart, addDays(windowStart, -1));
      state.coverageFrom = bootstrapStart < windowStart ? bootstrapStart : windowStart;
    } else if (bootstrapStart < state.coverageFrom) {
      state.pendingRanges = pushRange(state.pendingRanges, bootstrapStart, addDays(state.coverageFrom, -1));
      state.coverageFrom = bootstrapStart;
    }
    if (state.windowEnd !== null && addDays(state.windowEnd, 1) < windowStart) {
      state.pendingRanges = pushRange(state.pendingRanges, addDays(state.windowEnd, 1), addDays(windowStart, -1));
    }

    // ---- catalogue: journal/section ids are discovered, never hard-coded
    const journals = parseDoeSpNamedItems(
      (await client.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, context.signal)).body,
      'DOE_SP_INVALID_JOURNALS',
    );
    const journal = findDoeSpNamed(journals, DOE_SP_JOURNAL);
    if (!journal) throw new ConnectorError('DOE_SP_JOURNAL_NOT_FOUND', { code: 'DOE_SP_JOURNAL_NOT_FOUND', kind: 'PROCESSING_ERROR', retryable: false });
    const sections = parseDoeSpNamedItems(
      (await client.getJson(DOE_SP_SEARCH_API, 'v2/sections', { JournalId: journal.id }, context.signal)).body,
      'DOE_SP_INVALID_SECTIONS',
    );
    const section = findDoeSpNamed(sections, DOE_SP_SECTION);
    if (!section) throw new ConnectorError('DOE_SP_SECTION_NOT_FOUND', { code: 'DOE_SP_SECTION_NOT_FOUND', kind: 'PROCESSING_ERROR', retryable: false });
    const scope = { JournalId: journal.id, SectionId: section.id };

    const publications: ConnectorPublication[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];
    const filtering: Filtering = {
      discoveredCount: 0, includedCount: 0, excludedCount: 0,
      includedByCategory: {}, excludedByReason: {}, excludedSamples: [], excludedSamplesTruncated: 0,
    };
    const counters = { detailsFetched: 0, filesDownloaded: 0, fileBytes: 0, editionLookups: 0, sourceErrors: 0, authPdfNotRendered: 0 };
    const typeCache = new Map<string, Map<string, string>>();

    const typesFor = async (date: string): Promise<Map<string, string>> => {
      const cached = typeCache.get(date);
      if (cached) return cached;
      const body = (await client.getJson(DOE_SP_SEARCH_API, 'v2/summary/filters', { Date: date, ...scope }, context.signal)).body;
      const map = parseDoeSpTypeCatalogue(body);
      typeCache.set(date, map);
      return map;
    };

    const editionFor = async (date: string): Promise<EditionInfo> => {
      const info: EditionInfo = { supplementaryEditionCount: 0, supplementaryPdfUrls: [] };
      counters.editionLookups += 1;
      try {
        const status = parseDoeSpEditionStatus(
          (await client.getJson(DOE_SP_PDF_API, 'v1/editions/status/' + date, {}, context.signal, { allowNotFound: true })).body,
        );
        const edition = status.find((item) => item.editionName.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === 'Executivo_Atos_Normativos');
        if (edition) {
          info.editionId = edition.editionId;
          if (edition.editionAuthCode) info.editionAuthCode = edition.editionAuthCode;
          if (edition.volume !== undefined) info.volume = edition.volume;
          if (edition.number !== undefined) info.number = edition.number;
        }
        const main = parseDoeSpEditionUrl((await client.getJson(DOE_SP_PDF_API, 'v1/editions/url', {
          JournalId: journal.id, RootSectionId: section.id, EditionDate: date,
        }, context.signal, { allowNotFound: true })).body);
        if (main) info.editionPdfUrl = normalizeDoeSpApiUrl(main.url);
        const supplementary = parseDoeSpSupplementaryUrls((await client.getJson(DOE_SP_PDF_API, 'v1/supplementary-editions/url', {
          JournalId: journal.id, RootSectionId: section.id, EditionDate: date,
        }, context.signal, { allowNotFound: true })).body);
        info.supplementaryEditionCount = supplementary.length;
        info.supplementaryPdfUrls = supplementary.map((item) => normalizeDoeSpApiUrl(item.url));
      } catch (error) {
        if (isCancel(error)) throw error;
        // Edition references are evidence metadata; the act itself is complete without them.
      }
      return info;
    };

    const buildPublication = async (
      item: DoeSpListItem,
      category: DoeSpInclusionCategory,
      typeName: string | undefined,
      edition: EditionInfo,
    ): Promise<ConnectorPublication> => {
      const response = await client.getJson(DOE_SP_SEARCH_API, 'v2/publications/' + item.id, {}, context.signal);
      counters.detailsFetched += 1;
      const detail = parseDoeSpDetail(response.body, item.id);
      const capturedAt = now.toISOString();
      const files: ConnectorFile[] = [];
      const contentText =
        doeSpHtmlText(detail.contentHtml);
      const officialContentCompleteness =
        contentText &&
        detail.attachments.length === 0
          ? 'FULL_OFFICIAL_CONTENT'
          : 'PARTIAL_OFFICIAL_CONTENT';

      let authenticatedPdf:
        | 'CAPTURED'
        | 'NOT_RENDERED_BY_SOURCE'
        | 'UNAVAILABLE_REDUNDANT'
        | 'NO_AUTH_CODE' =
        detail.authCode ? 'CAPTURED' : 'NO_AUTH_CODE';
      let authenticatedPdfError:
        | Record<string, unknown>
        | undefined;
      const pdf = detail.authCode
        ? await client
            .downloadAuthenticatedPdf(
              detail.authCode,
              context.signal,
            )
            .catch((error: unknown) => {
              if (isCancel(error)) {
                throw error;
              }

              /*
               * D-017: the official HTML is the complete canonical
               * content for DOE-SP. A failure isolated to the
               * redundant authenticated PDF is provenance loss,
               * not publication loss. If HTML is absent we cannot
               * claim complete capture and retain the failure.
               */
              if (!contentText) {
                throw error;
              }

              if (error instanceof ConnectorError) {
                authenticatedPdf =
                  error.code ===
                  'DOE_SP_AUTHENTICATED_PDF_NOT_READY'
                    ? 'NOT_RENDERED_BY_SOURCE'
                    : 'UNAVAILABLE_REDUNDANT';
                if (
                  error.code ===
                  'DOE_SP_AUTHENTICATED_PDF_NOT_READY'
                ) {
                  counters.authPdfNotRendered += 1;
                }
                authenticatedPdfError = {
                  code: error.code,
                  kind: error.kind,
                  retryable: error.retryable,
                  ...(error.httpStatus !== undefined
                    ? {
                        httpStatus:
                          error.httpStatus,
                      }
                    : {}),
                };
                return undefined;
              }

              throw error;
            })
        : undefined;
      if (detail.authCode && pdf) {
        counters.filesDownloaded += 1;
        counters.fileBytes += pdf.sizeBytes;
        files.push({
          url: authenticatedPdfUrl(detail.authCode),
          ...(pdf.name ? { name: pdf.name } : {}),
          mimeType: pdf.mimeType,
          externalId: 'auth:' + detail.authCode,
          rawSha256: pdf.rawSha256,
          sizeBytes: pdf.sizeBytes,
          versionRole: contentText
            ? 'PROVENANCE'
            : 'MATERIAL_CONTENT',
          metadata: {
            kind: 'AUTHENTICATED_PUBLICATION_PDF',
            capturedAt,
            origin: 'DOE_SP',
            ...(contentText
              ? {
                  textExtraction:
                    'NOT_REQUIRED_HTML_TEXT_AVAILABLE',
                }
              : {
                  materialContent: true,
                  textExtraction: 'NOT_EXTRACTED',
                }),
          },
        });
      }
      for (const attachment of detail.attachments) {
        const file = await client.downloadAttachment(attachment.id, attachment.name, context.signal);
        counters.filesDownloaded += 1;
        counters.fileBytes += file.sizeBytes;
        files.push({
          url: attachmentUrl(attachment.id),
          name: attachment.name,
          mimeType: file.mimeType,
          externalId: attachment.id,
          rawSha256: file.rawSha256,
          sizeBytes: file.sizeBytes,
          versionRole: 'MATERIAL_CONTENT',
          metadata: { kind: 'ATTACHMENT', position: attachment.position, capturedAt, origin: 'DOE_SP', materialContent: true, textExtraction: 'NOT_EXTRACTED' },
        });
      }

      const identity = doeSpNormativeIdentity({ title: detail.title, ...(typeName ? { typeName } : {}), category });
      const actType = identity?.actType ?? doeSpActType(detail.title, detail.publicationType ?? typeName);
      const organ = doeSpOrgan(item.hierarchy);
      const signedOn = identity?.signedOn ?? doeSpTitleDate(detail.title);
      const ementa = contentText ? doeSpEmenta(contentText) : undefined;
      const isRetification = actType === 'RETIFICAÇÃO';

      return {
        title: detail.title,
        agency: identity?.agency ?? organ,
        sphere: 'STATE',
        stateCode: 'SP',
        actType,
        ...(identity ? { actNumber: identity.actNumber } : {}),
        publishedAt: new Date(detail.date + 'T00:00:00Z'),
        ...(contentText ? { content: contentText } : {}),
        officialUrl: publicationPageUrl(detail.slug),
        externalId: detail.id,
        ...(isRetification ? { identityKey: `DOE_SP|RETIFICACAO|${detail.id}` } : {}),
        ...(contentText
          ? {
              contentHashPolicy:
                'HTML_PRIMARY_MATERIAL_FILES' as const,
            }
          : {}),
        ...(files.length ? { files } : {}),
        metadata: {
          sourceRole: 'PRIMARY',
          journal: detail.journal,
          section: detail.firstLevelSectionName ?? DOE_SP_SECTION,
          organ,
          unit: item.hierarchy.slice(3).join(' > ') || organ,
          hierarchy: item.hierarchy.join(' > '),
          ...(detail.publicationType ? { publicationType: detail.publicationType } : {}),
          doeDate: detail.date,
          ...(signedOn ? { signedOn } : {}),
          ...(identity?.designation ? { designation: identity.designation } : {}),
          ...(ementa ? { ementa } : {}),
          captureCategory: category,
          identityMode: identity ? 'NORMATIVE' : isRetification ? 'RETIFICATION' : 'DOE_PUBLICATION_ID',
          slug: detail.slug,
          ...(detail.authCode ? { authCode: detail.authCode } : {}),
          editionHint: editionHint(item),
          ...(edition.editionAuthCode ? { editionAuthCode: edition.editionAuthCode } : {}),
          ...(edition.number !== undefined ? { editionNumber: edition.number } : {}),
          ...(edition.volume !== undefined ? { editionVolume: edition.volume } : {}),
          ...(edition.editionPdfUrl ? { editionPdfUrl: edition.editionPdfUrl } : {}),
          supplementaryEditionCount: edition.supplementaryEditionCount,
          textExtraction: contentText ? 'HTML_TEXT' : 'EMPTY',
          officialContentCompleteness,
          authenticatedPdf,
          ...(authenticatedPdfError
            ? { authenticatedPdfError }
            : {}),
          attachmentCount: detail.attachments.length,
        },
      };
    };

    const processDay = async (date: string, mode: 'WINDOW' | 'BACKFILL'): Promise<DayOutcome> => {
      const previous = mode === 'WINDOW' && !force ? state.days[date] : undefined;
      const outcome: DayOutcome = {
        date, mode, discovered: 0, included: 0, excluded: 0, newIncluded: 0, published: 0, failed: 0,
        malformed: 0, skippedUnchanged: false, complete: false, yielded: false, processedIds: [],
      };

      if (mode === 'WINDOW') {
        const structured = parseDoeSpStructured(
          (await client.getJson(DOE_SP_SEARCH_API, 'v2/summary/structured', { Date: date, ...scope }, context.signal)).body,
        );
        outcome.idsHash = doeSpIdsHash(structured.map((entry) => entry.id));
        outcome.discovered = structured.length;
        if (previous && previous.idsHash === outcome.idsHash) {
          outcome.skippedUnchanged = true;
          outcome.complete = true;
          outcome.processedIds = previous.included;
          return outcome;
        }
      }

      const list = parseDoeSpList(
        (await client.getJson(DOE_SP_SEARCH_API, 'v2/summary/list', { Date: date, ...scope }, context.signal)).body,
      );
      outcome.discovered = list.items.length + list.malformed.length;
      outcome.malformed = list.malformed.length;
      if (mode === 'BACKFILL') outcome.idsHash = doeSpIdsHash(list.items.map((item) => item.id));
      for (const bad of list.malformed) {
        partialFailures.push({
          code: 'DOE_SP_MALFORMED_LIST_ITEM',
          message: bad.reason,
          itemReference: `${date}#${bad.id ?? bad.index}`,
        });
      }
      if (!list.items.length) {
        outcome.complete = list.malformed.length === 0;
        return outcome;
      }

      const types = await typesFor(date);
      const known = new Set(previous?.included ?? []);
      const processed = new Set(previous?.included ?? []);
      const toProcess: Array<{ item: DoeSpListItem; category: DoeSpInclusionCategory; typeName?: string }> = [];

      for (const item of list.items) {
        const typeName = item.publicationTypeId ? types.get(item.publicationTypeId) : undefined;
        const decision = decideDoeSpCapture({
          title: item.title, hierarchy: item.hierarchy, excerpt: item.excerpt, ...(typeName ? { typeName } : {}),
        });
        filtering.discoveredCount += 1;
        if (decision.included) {
          outcome.included += 1;
          filtering.includedCount += 1;
          filtering.includedByCategory[decision.category] = (filtering.includedByCategory[decision.category] ?? 0) + 1;
          if (!known.has(item.id)) toProcess.push({ item, category: decision.category, ...(typeName ? { typeName } : {}) });
        } else {
          outcome.excluded += 1;
          filtering.excludedCount += 1;
          filtering.excludedByReason[decision.reason] = (filtering.excludedByReason[decision.reason] ?? 0) + 1;
          // Only ids/organs: excluded titles can identify taxpayers.
          if (filtering.excludedSamples.length < MAX_EXCLUDED_SAMPLES) {
            filtering.excludedSamples.push({ date, id: item.id, organ: doeSpOrgan(item.hierarchy), reason: decision.reason });
          } else {
            filtering.excludedSamplesTruncated += 1;
          }
        }
      }
      outcome.newIncluded = toProcess.length;

      const edition = toProcess.length ? await editionFor(date) : { supplementaryEditionCount: 0, supplementaryPdfUrls: [] };
      for (const next of toProcess) {
        if (context.budget?.shouldYield()) {
          outcome.yielded = true;
          break;
        }
        try {
          publications.push(await buildPublication(next.item, next.category, next.typeName, edition));
          processed.add(next.item.id);
          outcome.published += 1;
        } catch (error) {
          if (isCancel(error)) throw error;
          if (isSourceLevel(error)) counters.sourceErrors += 1;
          outcome.failed += 1;
          const info = failureInfo(error);
          partialFailures.push({ code: info.code, message: info.message, itemReference: `${date}#${next.item.id}` });
        }
      }
      outcome.processedIds = [...processed].sort();
      outcome.complete = !outcome.yielded && outcome.failed === 0 && outcome.malformed === 0;
      return outcome;
    };

    // ---- incremental window (always first: freshness has priority)
    const days: DayOutcome[] = [];
    const nextDays: Record<string, DoeSpDayState> = {};
    let windowFailures = 0;
    let lastSourceError: unknown;
    let yielded = false;

    for (const date of datesBetween(windowStart, today)) {
      if (context.budget?.shouldYield()) { yielded = true; break; }
      try {
        const outcome = await processDay(date, 'WINDOW');
        days.push(outcome);
        const prior = state.days[date];
        nextDays[date] = {
          idsHash: outcome.complete ? outcome.idsHash ?? '' : prior?.idsHash ?? '',
          total: outcome.discovered,
          included: outcome.processedIds,
          checkedAt: now.toISOString(),
        };
        if (outcome.yielded) { yielded = true; break; }
      } catch (error) {
        if (isCancel(error)) throw error;
        windowFailures += 1;
        lastSourceError = error;
        if (state.days[date]) nextDays[date] = state.days[date];
        const info = failureInfo(error);
        partialFailures.push({ code: info.code, message: info.message, itemReference: date });
      }
    }
    // Keep any window day not reached (budget) as it was.
    for (const date of datesBetween(windowStart, today)) {
      if (!nextDays[date] && state.days[date]) nextDays[date] = state.days[date];
    }

    const windowDays = datesBetween(windowStart, today).length;
    if (windowFailures === windowDays) {
      // Nothing of the source could be read: this is unavailability, never "0 publications".
      if (lastSourceError instanceof ConnectorError) throw lastSourceError;
      throw new ConnectorError('DOE_SP_WINDOW_UNAVAILABLE', {
        code: 'DOE_SP_WINDOW_UNAVAILABLE', kind: 'SOURCE_UNAVAILABLE', retryable: true,
      });
    }

    // ---- bootstrap / gap ranges with the remaining budget
    let ranges = state.pendingRanges.map((range) => ({ ...range }));
    let backfillDaysProcessed = 0;
    try {
      while (ranges.length && !yielded) {
        const range = ranges[0]!;
        if (context.budget?.shouldYield()) throw new BudgetReached();
        const outcome = await processDay(range.from, 'BACKFILL');
        days.push(outcome);
        if (outcome.yielded) throw new BudgetReached();
        if (!outcome.complete) break; // failed item: retry this date on the next run
        backfillDaysProcessed += 1;
        range.from = addDays(range.from, 1);
        if (range.from > range.to) ranges = ranges.slice(1);
      }
    } catch (error) {
      if (error instanceof BudgetReached) yielded = true;
      else if (isCancel(error)) throw error;
      else {
        const info = failureInfo(error);
        partialFailures.push({ code: info.code, message: info.message, itemReference: ranges[0]?.from ?? 'backfill' });
      }
    }

    const pendingDays = ranges.reduce((sum, range) => sum + datesBetween(range.from, range.to).length, 0);
    const retryRequired = !yielded && days.some((day) => !day.complete);
    const completion: ConnectorResult['completion'] | undefined = yielded
      ? { complete: false, reason: 'TIME_BUDGET_REACHED', pending: { pendingDays } }
      : retryRequired && pendingDays > 0
        ? { complete: false, reason: 'PARTIAL_FAILURE_RETRY_REQUIRED', pending: { pendingDays } }
        : undefined;

    const windowComplete = datesBetween(windowStart, today).every((date) => days.some((day) => day.date === date && day.mode === 'WINDOW' && day.complete));
    const nextState: DoeSpSourceState = {
      coverageFrom: state.coverageFrom,
      windowEnd: windowComplete ? today : state.windowEnd,
      pendingRanges: ranges,
      days: nextDays,
      ...(!partialFailures.length && !completion ? { lastSuccessAt: now.toISOString() } : state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    };

    return {
      publications,
      ...(partialFailures.length ? { partialFailures } : {}),
      metadata: {
        doeSp: {
          mode: pendingDays > 0 || backfillDaysProcessed > 0 ? 'INCREMENTAL_WITH_BACKFILL' : 'INCREMENTAL',
          journal: { name: journal.name, id: journal.id },
          section: { name: section.name, id: section.id },
          lookbackDays,
          window: { from: windowStart, to: today },
          forceReprocess: force,
          coverageFrom: nextState.coverageFrom,
          pendingDays,
          backfillDaysProcessed,
          days: days.map((day) => ({
            date: day.date, mode: day.mode, discovered: day.discovered, included: day.included,
            excluded: day.excluded, newIncluded: day.newIncluded, published: day.published,
            failed: day.failed, malformed: day.malformed, skippedUnchanged: day.skippedUnchanged,
            complete: day.complete,
          })),
          filtering,
          counters: { ...counters, requests: client.requestCount, downloadedBytes: client.downloadedBytes },
          partialFailureCount: partialFailures.length,
        },
      },
      ...(completion ? { completion } : {}),
      checkpoint: { version: DOE_SP_STATE_VERSION, state: nextState as unknown as Record<string, unknown> },
    };
  }
}
