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
  RfbNormasClient,
  type RfbNormasClientOptions,
} from './rfb-normas.client.js';
import {
  buildRfbApiRepresentationUrl,
  buildRfbModernRepresentationUrl,
  buildRfbSearchUrl,
  canonicalizeRfbListingNumber,
  decideRfbCapture,
  parseRfbApiRepresentation,
  parseRfbSearchPage,
  type RfbFilterDecision,
  type RfbNormasListingItem,
} from './rfb-normas.parser.js';

export const RFB_NORMAS_CONNECTOR_KEY = 'rfb-normas';
export const RFB_NORMAS_STATE_VERSION = 1;

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_REVISIT_AFTER_MS = 24 * 60 * 60 * 1_000;
const BOOTSTRAP_START_MONTH = '2025-01';
const MAX_EXCLUDED_ITEMS = 2_000;

export interface RfbStoredFile {
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  checkedAt: string;
  name?: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export interface RfbNormasSourceState {
  bootstrap: {
    complete: boolean;
    month: string;
    page: number;
  };
  files: Record<string, RfbStoredFile>;
  lastSuccessAt?: string;
}

export interface RfbNormasConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<RfbNormasSourceState>;
  lookbackDays?: number;
  revisitAfterMs?: number;
  bootstrapStartMonth?: string;
  maxExcludedItems?: number;
  client?: Omit<RfbNormasClientOptions, 'fetch'>;
}

interface FilteringMetrics {
  discoveredCount: number;
  includedCount: number;
  excludedCount: number;
  includedByCategory: Record<string, number>;
  excludedByReason: Record<string, number>;
  excludedItems: Array<{
    idAto: string;
    type: string;
    number: string;
    agency: string;
    publishedOn: string;
    reason: string;
  }>;
  excludedItemsTruncated: number;
}

interface RunCounters {
  searchPages: number;
  detailRequests: number;
  representationRequests: number;
  representationUnavailable: number;
  downloadedFiles: number;
  reusedFiles: number;
  recheckedFiles: number;
}

function failureInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) return { code: error.code, message: error.message };
  return {
    code: 'RFB_NORMAS_UNHANDLED_ERROR',
    message: error instanceof Error ? error.message : 'Unknown RFB Normas error',
  };
}

function resolveLookbackDays(value?: number): number {
  const raw = value ?? Number(process.env.RFB_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 60) {
    throw new RangeError('RFB_LOOKBACK_DAYS must be an integer between 1 and 60');
  }
  return raw;
}

function monthStart(month: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match?.[1] || !match[2]) throw new RangeError('Invalid bootstrap month');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new RangeError('Invalid bootstrap month');
  return new Date(Date.UTC(year, monthIndex, 1));
}

function nextMonth(month: string): string {
  const start = monthStart(month);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 7);
}

function monthEnd(month: string, now: Date): Date {
  const start = monthStart(month);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const end = new Date(next.getTime() - 1);
  const local = saoPauloDateParts(now);
  const todayEnd = new Date(Date.UTC(local.year, local.month - 1, local.day, 23, 59, 59, 999));
  return end.getTime() < todayEnd.getTime() ? end : todayEnd;
}

function saoPauloDateParts(now: Date): { year: number; month: number; day: number; iso: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    throw new RangeError('Could not resolve America/Sao_Paulo date');
  }
  return {
    year,
    month,
    day,
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function saoPauloToday(now: Date): Date {
  const local = saoPauloDateParts(now);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

function saoPauloMonth(now: Date): string {
  const local = saoPauloDateParts(now);
  return `${local.year}-${String(local.month).padStart(2, '0')}`;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shouldRecheck(file: RfbStoredFile | undefined, now: Date, revisitAfterMs: number): boolean {
  if (!file) return true;
  const checked = Date.parse(file.checkedAt);
  return !Number.isFinite(checked) || now.getTime() - checked >= revisitAfterMs;
}

function fileFromStored(url: string, externalId: string, stored: RfbStoredFile): ConnectorFile {
  return {
    url,
    externalId,
    ...(stored.name ? { name: stored.name } : {}),
    rawSha256: stored.rawSha256,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType,
    ...(stored.sourceEtag ? { sourceEtag: stored.sourceEtag } : {}),
    ...(stored.sourceLastModified ? { sourceLastModified: stored.sourceLastModified } : {}),
  };
}

function fallbackTitle(item: RfbNormasListingItem): string {
  return `${item.type} ${item.agency} nº ${item.number}, publicado em ${dateOnly(item.publishedAt)}`;
}

function addDecision(
  metrics: FilteringMetrics,
  item: RfbNormasListingItem,
  decision: RfbFilterDecision,
  maxExcludedItems: number,
): void {
  metrics.discoveredCount += 1;
  if (decision.included) {
    metrics.includedCount += 1;
    const category = decision.category ?? 'UNKNOWN';
    metrics.includedByCategory[category] = (metrics.includedByCategory[category] ?? 0) + 1;
    return;
  }

  metrics.excludedCount += 1;
  metrics.excludedByReason[decision.reason] = (metrics.excludedByReason[decision.reason] ?? 0) + 1;
  if (metrics.excludedItems.length < maxExcludedItems) {
    metrics.excludedItems.push({
      idAto: item.idAto,
      type: item.type,
      number: item.number,
      agency: item.agency,
      publishedOn: dateOnly(item.publishedAt),
      reason: decision.reason,
    });
  } else {
    metrics.excludedItemsTruncated += 1;
  }
}

function reclassifyIncludedAsExcluded(
  metrics: FilteringMetrics,
  item: RfbNormasListingItem,
  decision: RfbFilterDecision,
  reason: string,
  maxExcludedItems: number,
): void {
  metrics.includedCount = Math.max(0, metrics.includedCount - 1);
  const category = decision.category ?? 'UNKNOWN';
  const currentCategory = metrics.includedByCategory[category] ?? 0;
  if (currentCategory <= 1) delete metrics.includedByCategory[category];
  else metrics.includedByCategory[category] = currentCategory - 1;

  metrics.excludedCount += 1;
  metrics.excludedByReason[reason] = (metrics.excludedByReason[reason] ?? 0) + 1;
  if (metrics.excludedItems.length < maxExcludedItems) {
    metrics.excludedItems.push({
      idAto: item.idAto,
      type: item.type,
      number: item.number,
      agency: item.agency,
      publishedOn: dateOnly(item.publishedAt),
      reason,
    });
  } else {
    metrics.excludedItemsTruncated += 1;
  }
}

function pendingMonths(cursorMonth: string, now: Date): number {
  const cursor = monthStart(cursorMonth);
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const months = (current.getUTCFullYear() - cursor.getUTCFullYear()) * 12 +
    current.getUTCMonth() - cursor.getUTCMonth() + 1;
  return Math.max(0, months);
}

export class RfbNormasConnector implements CollectionConnector {
  readonly key = RFB_NORMAS_CONNECTOR_KEY;
  readonly version = '0.1.0';
  readonly #options: RfbNormasConnectorOptions;

  constructor(options: RfbNormasConnectorOptions = {}) {
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const lookbackDays = resolveLookbackDays(this.#options.lookbackDays);
    const revisitAfterMs = this.#options.revisitAfterMs ?? DEFAULT_REVISIT_AFTER_MS;
    const bootstrapStartMonth = this.#options.bootstrapStartMonth ?? BOOTSTRAP_START_MONTH;
    const maxExcludedItems = this.#options.maxExcludedItems ?? MAX_EXCLUDED_ITEMS;
    const state = await this.#options.readState?.(context.sourceId) ?? {
      bootstrap: { complete: false, month: bootstrapStartMonth, page: 1 },
      files: {},
    };
    if (!state.bootstrap.month) state.bootstrap.month = bootstrapStartMonth;

    const client = new RfbNormasClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });
    const publications: ConnectorPublication[] = [];
    const partialFailures: ConnectorPartialFailure[] = [];
    const nextFiles: Record<string, RfbStoredFile> = { ...state.files };
    const filtering: FilteringMetrics = {
      discoveredCount: 0,
      includedCount: 0,
      excludedCount: 0,
      includedByCategory: {},
      excludedByReason: {},
      excludedItems: [],
      excludedItemsTruncated: 0,
    };
    const counters: RunCounters = {
      searchPages: 0,
      detailRequests: 0,
      representationRequests: 0,
      representationUnavailable: 0,
      downloadedFiles: 0,
      reusedFiles: 0,
      recheckedFiles: 0,
    };

    const representationKinds = ['original', 'vigente', 'multivigente', 'relacional'] as const;

    const processIncluded = async (
      item: RfbNormasListingItem,
      decision: RfbFilterDecision,
    ): Promise<void> => {
      const representations: Record<string, Record<string, unknown>> = {};
      let original:
        | ReturnType<typeof parseRfbApiRepresentation>
        | undefined;

      for (const kind of representationKinds) {
        context.signal.throwIfAborted();
        if (context.budget?.shouldYield()) {
          throw new ConnectorError('RFB_NORMAS_TIME_BUDGET_REACHED', {
            code: 'RFB_NORMAS_TIME_BUDGET_REACHED',
            kind: 'PROCESSING_ERROR',
            retryable: true,
          });
        }

        const apiUrl = buildRfbApiRepresentationUrl(item.idAto, kind);
        try {
          counters.representationRequests += 1;
          const response = kind === 'original'
            ? await client.getJson(apiUrl, context.signal)
            : await client.getOptionalJson(apiUrl, context.signal);

          if (response.status === 'NOT_AVAILABLE') {
            counters.representationUnavailable += 1;
            representations[kind] = {
              url: buildRfbModernRepresentationUrl(item.idAto, kind),
              apiUrl,
              available: false,
              httpStatus: response.httpStatus,
              lastCheckedAt: now.toISOString(),
            };
            continue;
          }

          const parsed = parseRfbApiRepresentation(response.payload);
          const payloadId = (response.payload as { idAto?: unknown } | null)?.idAto;
          if (String(payloadId ?? '') !== item.idAto) {
            throw new ConnectorError('RFB_NORMAS_ID_MISMATCH', {
              code: 'RFB_NORMAS_ID_MISMATCH',
              kind: 'PROCESSING_ERROR',
              retryable: false,
            });
          }
          representations[kind] = {
            url: buildRfbModernRepresentationUrl(item.idAto, kind),
            apiUrl: response.url,
            available: true,
            normalizedHash: parsed.normalizedHash,
            lastCheckedAt: now.toISOString(),
            ...(parsed.status ? { status: parsed.status } : {}),
          };
          if (kind === 'original') original = parsed;
        } catch (error) {
          if (kind === 'original') throw error;
          const info = failureInfo(error);
          partialFailures.push({
            code: info.code,
            message: info.message,
            itemReference: `${item.idAto}:${kind}`,
          });
          representations[kind] = {
            url: buildRfbModernRepresentationUrl(item.idAto, kind),
            apiUrl,
            available: false,
            errorCode: info.code,
            lastCheckedAt: now.toISOString(),
          };
        }
      }

      if (!original || !original.normalizedText) {
        throw new ConnectorError('RFB_NORMAS_ORIGINAL_EMPTY', {
          code: 'RFB_NORMAS_ORIGINAL_EMPTY',
          kind: 'PROCESSING_ERROR',
          retryable: true,
        });
      }

      counters.detailRequests += 1;
      if (original.duplicatePublicationReference) {
        reclassifyIncludedAsExcluded(
          filtering,
          item,
          decision,
          'DUPLICATE_RETIFICATION_REFERENCE',
          maxExcludedItems,
        );
        return;
      }

      const canonical = canonicalizeRfbListingNumber(
        {
          ...item,
          ...(original.agency ? { agency: original.agency } : {}),
          ...(original.type ? { type: original.type } : {}),
          ...(original.number ? { number: original.number } : {}),
          ...(original.publishedAt ? { publishedAt: original.publishedAt } : {}),
        },
        original.title,
      );
      const files: ConnectorFile[] = [];

      for (const attachment of original.attachments) {
        context.signal.throwIfAborted();
        const previous = state.files[attachment.externalId];
        if (previous && !shouldRecheck(previous, now, revisitAfterMs)) {
          counters.reusedFiles += 1;
          nextFiles[attachment.externalId] = previous;
          files.push(fileFromStored(attachment.url, attachment.externalId, previous));
          continue;
        }

        try {
          if (previous) counters.recheckedFiles += 1;
          const response = await client.downloadFile(
            attachment.url,
            context.signal,
            previous
              ? {
                  ...(previous.sourceEtag ? { etag: previous.sourceEtag } : {}),
                  ...(previous.sourceLastModified ? { lastModified: previous.sourceLastModified } : {}),
                }
              : {},
            attachment.name,
          );
          let stored: RfbStoredFile;
          if (response.status === 'NOT_MODIFIED') {
            if (!previous) {
              throw new ConnectorError('RFB_NORMAS_304_WITHOUT_FILE_STATE', {
                code: 'RFB_NORMAS_304_WITHOUT_FILE_STATE',
                kind: 'PROCESSING_ERROR',
                retryable: false,
              });
            }
            stored = {
              ...previous,
              checkedAt: now.toISOString(),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          } else {
            counters.downloadedFiles += 1;
            stored = {
              rawSha256: response.rawSha256,
              sizeBytes: response.sizeBytes,
              mimeType: response.mimeType,
              checkedAt: now.toISOString(),
              ...(response.filename ?? attachment.name ? { name: response.filename ?? attachment.name } : {}),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          }
          nextFiles[attachment.externalId] = stored;
          files.push(fileFromStored(attachment.url, attachment.externalId, stored));
        } catch (error) {
          const info = failureInfo(error);
          if (previous) {
            nextFiles[attachment.externalId] = previous;
            files.push(fileFromStored(attachment.url, attachment.externalId, previous));
            partialFailures.push({
              code: info.code,
              message: info.message,
              itemReference: attachment.url,
            });
            continue;
          }
          throw error;
        }
      }

      const sourceTitle = original.title ?? fallbackTitle(item);
      const isRetification = original.revisionKind === 'RETIFICATION';
      const title = isRetification
        ? `RETIFICAÇÃO — ${sourceTitle.toLocaleUpperCase('pt-BR')}`
        : sourceTitle.toLocaleUpperCase('pt-BR');
      const canonicalContent = original.normalizedText;
      const officialUrl = buildRfbModernRepresentationUrl(item.idAto, 'original');
      const publishedAt = original.publishedAt ?? item.publishedAt;
      const retificationIdentity = isRetification
        ? [
            'RFB_NORMAS',
            'RETIFICATION',
            canonical.agency ?? original.agency ?? item.agency,
            canonical.actType ?? original.type ?? item.type,
            canonical.actNumber ?? item.number,
            dateOnly(publishedAt),
          ].join('|')
        : undefined;
      const metadata: Record<string, unknown> = {
        sourceRole: 'ENRICHMENT',
        representationSourceRole: 'PRIMARY',
        publicationEventRole: 'ENRICHMENT_WHEN_DOU_EXISTS',
        captureCategory: decision.category,
        captureReason: decision.reason,
        rfbNormas: {
          idAto: item.idAto,
          listingType: item.type,
          listingNumber: item.number,
          listingAgency: item.agency,
          publicationDate: dateOnly(original.publishedAt ?? item.publishedAt),
          listingPublicationDate: dateOnly(item.publishedAt),
          ...(original.effectiveAt ? { effectiveDate: dateOnly(original.effectiveAt) } : {}),
          sourceTitle,
          ...(original.publicationReference ? { publicationReference: original.publicationReference } : {}),
          abstract: item.abstract,
          representations,
          files,
          ...(canonical.actDate ? { actDate: dateOnly(canonical.actDate) } : {}),
          republication: original.republication,
          ...(isRetification
            ? {
                revisionKind: 'RETIFICATION',
                targetAct: {
                  ...(canonical.agency ? { agency: canonical.agency } : {}),
                  ...(canonical.actType ? { actType: canonical.actType } : {}),
                  ...(canonical.actNumber ? { actNumber: canonical.actNumber } : {}),
                },
              }
            : {}),
        },
      };

      const strong = !isRetification && canonical.agency && canonical.actType && canonical.actNumber;
      publications.push({
        title,
        sphere: 'FEDERAL',
        ...(canonical.agency ? { agency: canonical.agency } : {}),
        ...(isRetification
          ? { actType: 'RETIFICAÇÃO' }
          : canonical.actType
            ? { actType: canonical.actType }
            : {}),
        ...(!isRetification && canonical.actNumber ? { actNumber: canonical.actNumber } : {}),
        publishedAt,
        content: canonicalContent,
        officialUrl,
        externalId: item.idAto,
        ...(retificationIdentity
          ? { identityKey: retificationIdentity }
          : !strong
            ? { identityKey: `RFB_NORMAS|${item.idAto}` }
            : {}),
        ...(files.length ? { files } : {}),
        metadata,
      });
    };

    const processSearchPage = async (
      start: Date,
      end: Date,
      page: number,
    ): Promise<{ totalPages: number; yielded: boolean; failedIncluded: boolean }> => {
      const url = buildRfbSearchUrl({ start, end, page });
      const search = await client.getHtml(url, context.signal);
      counters.searchPages += 1;
      const parsed = parseRfbSearchPage(search.html, page);
      let failedIncluded = false;

      for (const item of parsed.items) {
        const decision = decideRfbCapture(item);
        addDecision(filtering, item, decision, maxExcludedItems);
        if (!decision.included) continue;

        if (context.budget?.shouldYield()) {
          return { totalPages: parsed.totalPages, yielded: true, failedIncluded };
        }

        try {
          await processIncluded(item, decision);
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            (error.kind === 'CANCELLED' || error.code === 'RFB_NORMAS_TIME_BUDGET_REACHED')
          ) {
            if (error.kind === 'CANCELLED') throw error;
            return { totalPages: parsed.totalPages, yielded: true, failedIncluded };
          }
          failedIncluded = true;
          const info = failureInfo(error);
          partialFailures.push({
            code: info.code,
            message: info.message,
            itemReference: item.idAto,
          });
        }
      }
      return { totalPages: parsed.totalPages, yielded: false, failedIncluded };
    };

    let bootstrap = { ...state.bootstrap };
    let completion: ConnectorResult['completion'];

    if (!bootstrap.complete) {
      const currentMonth = saoPauloMonth(now);
      while (bootstrap.month <= currentMonth) {
        if (context.budget?.shouldYield()) {
          completion = {
            complete: false,
            reason: 'TIME_BUDGET_REACHED',
            pending: { bootstrapMonths: pendingMonths(bootstrap.month, now) },
          };
          break;
        }

        const start = monthStart(bootstrap.month);
        const end = monthEnd(bootstrap.month, now);
        const result = await processSearchPage(start, end, bootstrap.page);
        if (result.yielded) {
          completion = {
            complete: false,
            reason: 'TIME_BUDGET_REACHED',
            pending: { bootstrapMonths: pendingMonths(bootstrap.month, now) },
          };
          break;
        }

        if (result.failedIncluded) {
          completion = {
            complete: false,
            reason: 'PARTIAL_FAILURE_RETRY_REQUIRED',
            pending: {
              bootstrapMonths: pendingMonths(bootstrap.month, now),
              bootstrapPage: bootstrap.page,
            },
          };
          break;
        }

        if (bootstrap.page < result.totalPages) {
          bootstrap.page += 1;
          continue;
        }

        bootstrap = {
          complete: bootstrap.month === currentMonth,
          month: bootstrap.month === currentMonth ? bootstrap.month : nextMonth(bootstrap.month),
          page: 1,
        };
        if (bootstrap.complete) break;
      }
    } else {
      const end = saoPauloToday(now);
      const start = new Date(end.getTime() - (lookbackDays - 1) * 86_400_000);
      let page = 1;
      while (true) {
        if (context.budget?.shouldYield()) {
          completion = {
            complete: false,
            reason: 'TIME_BUDGET_REACHED',
            pending: { lookbackPages: 1 },
          };
          break;
        }
        const result = await processSearchPage(start, end, page);
        if (result.yielded) {
          completion = {
            complete: false,
            reason: 'TIME_BUDGET_REACHED',
            pending: { lookbackPages: Math.max(1, result.totalPages - page + 1) },
          };
          break;
        }
        if (page >= result.totalPages) break;
        page += 1;
      }
    }

    const complete = completion?.complete !== false;
    return {
      publications,
      ...(partialFailures.length ? { partialFailures } : {}),
      metadata: {
        rfbNormas: {
          mode: state.bootstrap.complete ? 'INCREMENTAL' : 'BOOTSTRAP',
          bootstrap,
          lookbackDays,
          filtering,
          counters,
          partialFailureCount: partialFailures.length,
        },
      },
      ...(completion ? { completion } : {}),
      checkpoint: {
        version: RFB_NORMAS_STATE_VERSION,
        state: {
          bootstrap,
          files: nextFiles,
          ...(complete ? { lastSuccessAt: now.toISOString() } : {}),
        },
      },
    };
  }
}
