import type { CollectionConnector, ConnectorExecutionContext, ConnectorPartialFailure, ConnectorPublication, ConnectorResult } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { InlabsClient, type InlabsCredentials, type InlabsXmlSection } from './inlabs.client.js';
import { parseDouZip, type DouArchiveContext } from './dou.parser.js';
import { classifyDouContractExcerpt, DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';
import { DouReserveClient } from './dou-reserve.client.js';
import { collectDouReserve, countDouEdition, isDouReserveEligible, type DouObservedEditions, type DouReserveReceipts } from './dou-reserve.js';
import { beginDouCoverage, coverageDates, markDouCoverage, type DouChannel, type DouCoverage } from './dou-coverage.js';

export const DOU_XML_SECTIONS: readonly InlabsXmlSection[] = ['DO1', 'DO1E', 'DO3', 'DO3E'];

export interface DouState {
  archives: Record<string, string>;
  reserveArchives?: DouReserveReceipts;
  reserveCoverage?: DouCoverage;
  lastSuccessAt?: Date;
}
export interface DouOptions {
  credentials: () => InlabsCredentials | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string, runId: string) => Promise<DouState>;
  // A bounded, explicit date range for controlled validation/backfill. Runtime registry
  // never supplies these dates and does not mutate shared source configuration.
  dates?: string[];
  /**
   * Backfill of past dates only: a batch where every package is absent is a
   * consulted batch without editions (weekends, holidays), not a pending
   * availability to retry. Monitoring never sets it.
   */
  allowEmptyBatch?: boolean;
  /** Opt-in dependency. The runtime does not supply this in the candidate. */
  reserve?: DouReserveClient;
}
function failure(code: string, retryable = false) {
  return new ConnectorError(code, { code, kind: 'FETCH_ERROR', retryable });
}
export function douCollectionDates(now: Date): string[] {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const end = new Date(`${today}T12:00:00Z`);
  const recent = Array.from({ length: 3 }, (_, i) => new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10));
  // Help page permits delayed XML availability until the fifth business day of the
  // following month. Revisit one older date per hourly slot across this + last month.
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1, 12));
  const older: string[] = [];
  for (let d = start.getTime(); d < end.getTime() - 2 * 86400000; d += 86400000) older.push(new Date(d).toISOString().slice(0, 10));
  if (older.length) recent.push(older[Math.floor(now.getTime() / 3600000) % older.length]!);
  return recent;
}

export class DouConnector implements CollectionConnector {
  readonly key = 'dou';
  readonly version = '0.6.0';
  readonly #options: DouOptions;
  constructor(options: DouOptions) { this.#options = options; }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const publications: ConnectorPublication[] = [];
    const result = await this.collectIncremental(context, async publication => { publications.push(publication); });
    return { ...result, publications };
  }

  async collectIncremental(
    context: ConnectorExecutionContext,
    emit: (publication: ConnectorPublication) => Promise<void>,
  ): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const state = await this.#options.readState?.(context.sourceId, context.runId) ?? { archives: {} };
    const reserve = this.#options.reserve;
    const coverage = reserve && state.reserveCoverage ? beginDouCoverage(state.reserveCoverage, now) : undefined;
    const ordinaryDates = douCollectionDates(now);
    const dates = this.#options.dates ?? (coverage ? coverageDates(coverage, ordinaryDates, now) : ordinaryDates);
    if (!dates.length || dates.length > 4 || new Set(dates).size !== dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw failure('DOU_INVALID_DATE_BATCH');
    // Do not silently discard a gap that exceeds the bounded reconciliation window.
    if (!this.#options.dates && !coverage && state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() > 60 * 86400000) throw failure('DOU_BACKFILL_REQUIRED');
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - 65);
    const oldestReceiptDate = cutoff.toISOString().slice(0, 10);
    const receipts = { ...state.archives };
    const reserveReceipts: DouReserveReceipts = Object.fromEntries(
      Object.entries(state.reserveArchives ?? {}).filter(([key]) => key.slice(0, 10) >= oldestReceiptDate),
    );
    let emitted = false;
    const primaryObserved: DouObservedEditions = {};
    const emitPrimary = async (publication: ConnectorPublication) => {
      if (coverage) countDouEdition(primaryObserved, publication.publishedAt!.toISOString().slice(0, 10), publication);
      emitted = true;
      await emit(publication);
    };
    let primary: ConnectorResult;
    try {
      // Recompute the edition inventory while coverage is being tracked. In
      // particular a previously known native ZIP must emit provenance again
      // after an observed channel change, even if its checksum is unchanged.
      primary = await this.#collectInlabs(context, dates, receipts, reserveReceipts, oldestReceiptDate, emitPrimary, Boolean(coverage));
    } catch (error) {
      context.signal.throwIfAborted();
      if (!reserve || emitted || !isDouReserveEligible(error)) {
        if (coverage && error instanceof ConnectorError) throw this.#coverageError(error, coverage, dates, now);
        throw error;
      }
      const ledger = coverage ?? beginDouCoverage(undefined, now);
      const reserveDates = this.#options.dates ?? coverageDates(ledger, ordinaryDates, now);
      const observed: DouObservedEditions = {};
      try {
        const result = await collectDouReserve(reserve, reserveDates, context, emit, error, reserveReceipts, observed, ledger.lastChannel !== 'DOU_OPEN_DATA_ZIP');
        for (const map of [receipts, reserveReceipts]) {
          for (const key of Object.keys(map)) if (key.slice(0, 10) < oldestReceiptDate) delete map[key];
        }
        return await this.#withCoverage({ ...result, metadata: { ...result.metadata, douArchives: receipts, douReserveArchives: reserveReceipts } },
          reserve, ledger, reserveDates, now, 'DOU_OPEN_DATA_ZIP', observed, context.signal);
      } catch (failure) {
        context.signal.throwIfAborted();
        if (failure instanceof ConnectorError) throw this.#coverageError(failure, ledger, reserveDates, now);
        throw failure;
      }
    }
    if (!coverage || !reserve) return primary;
    return this.#withCoverage(primary, reserve, coverage, dates, now, 'INLABS', primaryObserved, context.signal);
  }

  #coverageError(error: ConnectorError, ledger: DouCoverage, dates: readonly string[], now: Date): ConnectorError {
    return new ConnectorError(error.message, {
      code: error.code, kind: error.kind, retryable: error.retryable,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      metadata: { ...error.metadata, douCoverage: markDouCoverage(ledger, dates, now, { error: error.code }) },
    });
  }

  async #withCoverage(
    result: ConnectorResult, client: DouReserveClient, ledger: DouCoverage, dates: readonly string[], now: Date,
    channel: DouChannel, observed: DouObservedEditions, signal: AbortSignal,
  ): Promise<ConnectorResult> {
    const expected: DouObservedEditions = {};
    let next: DouCoverage;
    if (result.partialFailures?.length) next = markDouCoverage(ledger, dates, now, { error: 'DOU_PRIMARY_PARTIAL' });
    else {
      const referenceSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      for (const date of dates) {
        try {
          for (const [section, counts] of Object.entries(await client.editions(date, referenceSignal))) expected[`${date}:${section}`] = counts;
        } catch (error) {
          signal.throwIfAborted();
          if (!referenceSignal.aborted) throw error;
          break;
        }
      }
      next = markDouCoverage(ledger, dates, now, { observed, expected, channel });
    }
    const pending = Object.values(next.rows).filter(row => row.status !== 'CONFIRMED_BY_COUNT').length;
    return {
      ...result,
      ...(pending ? { completion: { complete: false, reason: 'MATERIAL_CONTENT_DEFERRED', pending: { douCoverageRows: pending } } } : {}),
      metadata: {
        ...result.metadata, douCoverage: next,
        douConsultation: result.partialFailures?.length ? 'FAILED' : 'OK',
        douCoverageStatus: pending ? 'INCOMPLETE' : 'CONFIRMED_BY_COUNT',
        douCoverageEscalatedCount: Object.values(next.rows).filter(row => row.status === 'ESCALATED').length,
      },
    };
  }

  async #collectInlabs(
    context: ConnectorExecutionContext,
    dates: readonly string[],
    priorReceipts: Record<string, string>,
    reserveReceipts: DouReserveReceipts,
    oldestReceiptDate: string,
    emit: (publication: ConnectorPublication) => Promise<void>,
    replay: boolean,
  ): Promise<ConnectorResult> {
    const client = new InlabsClient({ credentials: this.#options.credentials, ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}) });
    const partialFailures: ConnectorPartialFailure[] = [];
    const receipts: Record<string, string> = { ...priorReceipts };
    const archives: Array<Record<string, unknown>> = []; let available = 0; let xmlCount = 0; let mediaCount = 0;
    let assembledMatterCount = 0; let legacyIgnoreCount = 0;
    let publicationCount = 0; let embeddedActCount = 0; let confazMatterCount = 0;
    const legacyIgnoreByCategory: Record<string, number> = {};
    const legacyIgnoreReferences: Array<Record<string, unknown>> = [];
    const editions = new Set<string>();
    try {
      await client.login(context.signal);
      for (const date of dates) {
        for (const section of DOU_XML_SECTIONS) {
          context.signal.throwIfAborted();
          const filename = `${date}-${section}.zip`;
          let download: Awaited<ReturnType<InlabsClient['downloadXml']>>;
          try {
            download = await client.downloadXml(date, section, context.signal);
          } catch (e) {
            // One archive answering 200 with a non-ZIP body (login, session,
            // maintenance and WAF pages are recognised earlier and still fail
            // the attempt) must not hold every other edition hostage: a run
            // stuck in persistent retry on it stopped all DOU persistence.
            // Record it without a receipt so every later run tries it again.
            if (!(e instanceof ConnectorError) || e.code !== 'INLABS_INVALID_DOWNLOAD') throw e;
            partialFailures.push({ code: e.code, message: `${filename}: ${e.code}`, itemReference: filename });
            archives.push({ filename, state: 'INVALID_DOWNLOAD', date, section, httpStatus: e.httpStatus ?? null, ...(e.metadata ?? {}) });
            continue;
          }
          if (download.status === 'NOT_AVAILABLE') {
            archives.push({
              filename, state: 'NOT_AVAILABLE', date, section,
              ...(download.evidence ? { evidence: download.evidence } : {}),
              ...(download.metadata ?? {}),
            });
            continue;
          }
          available++;
          context.memory?.('archive_downloaded', { archives: available, archiveBytes: download.bytes.byteLength, publications: publicationCount });
          if (!replay && priorReceipts[filename] === download.rawSha256) {
            archives.push({ filename, state: 'UNCHANGED', date, section, rawSha256: download.rawSha256 });
            continue;
          }
          const archive: DouArchiveContext = { filename, date, section, officialUrl: download.officialUrl, rawSha256: download.rawSha256 };
          let sourceMatterCount = 0; let archivePublicationCount = 0; let archiveEmbeddedActCount = 0;
          let archiveLegacyIgnoreCount = 0;
          const parsed = await parseDouZip(download.bytes, archive, context.signal, async publication => {
            const data = publication.metadata?.dou as { edition: string; embeddedAct?: boolean };
            editions.add(`${date}:${data.edition}`);
            if (data.embeddedAct !== true) sourceMatterCount++;
            const classification = classifyDouContractExcerpt(publication);
            if (classification?.decision === 'IGNORE') {
              legacyIgnoreCount += 1;
              archiveLegacyIgnoreCount += 1;
              legacyIgnoreByCategory[classification.category] = (legacyIgnoreByCategory[classification.category] ?? 0) + 1;
              if (legacyIgnoreReferences.length < 100) {
                legacyIgnoreReferences.push({
                  externalId: publication.externalId ?? null,
                  officialUrl: publication.officialUrl,
                  actType: publication.actType ?? null,
                  category: classification.category,
                  reasonCodes: classification.reasonCodes,
                });
              }
            }
            // F3: legacy scope classification is diagnostic only. Every act in
            // the configured editions reaches the shared type-policy runtime.
            // The sink controls backpressure. No whole-run publications array
            // exists in the engine path, and multipart matters are already whole.
            await emit(classification ? {
              ...publication,
              metadata: { ...publication.metadata, douScope: { ...classification, informationalOnly: true } },
            } : publication);
            publicationCount++; archivePublicationCount++;
            if (data.embeddedAct === true) { embeddedActCount++; archiveEmbeddedActCount++; }
            if (publication.agency === 'CONFAZ') confazMatterCount++;
          });
          if (!parsed.xmlCount) throw failure('DOU_ARCHIVE_HAS_NO_XML', true);
          assembledMatterCount += sourceMatterCount;
          xmlCount += parsed.xmlCount; mediaCount += parsed.mediaCount;
          partialFailures.push(...parsed.partialFailures);
          context.memory?.('archive_parsed', { archives: available, xmlEntries: xmlCount, publications: publicationCount });
          if (!parsed.partialFailures.length) receipts[filename] = download.rawSha256;
          archives.push({
            ...archive,
            state: parsed.partialFailures.length ? 'PARTIAL' : 'PARSED',
            xmlCount: parsed.xmlCount,
            matterCount: sourceMatterCount,
            publicationCount: archivePublicationCount,
            embeddedActCount: archiveEmbeddedActCount,
            scopeIgnoredCount: 0,
            legacyIgnoreCount: archiveLegacyIgnoreCount,
            mediaCount: parsed.mediaCount,
          });
        }
      }
      if (!available && !this.#options.allowEmptyBatch) throw failure('INLABS_EDITIONS_NOT_AVAILABLE', true);
      // Bound receipt history. Only a terminal successful RUN makes these receipts
      // eligible as a checkpoint; attempt success alone precedes publication persistence.
      for (const name of Object.keys(receipts)) if (name.slice(0, 10) < oldestReceiptDate) delete receipts[name];
      return { publications: [], partialFailures, metadata: {
        dou: {
          archives,
          xmlCount,
          mediaCount,
          assembledMatterCount,
          publicationCount,
          embeddedActCount,
          editions: [...editions],
          partialFailures,
          confazMatterCount,
          scope: {
            ruleVersion: DOU_SCOPE_RULE_VERSION,
            informationalOnly: true,
            ignoredCount: 0,
            ignoredByCategory: {},
            ignoredReferences: [],
            ignoredReferenceLimit: 100,
            legacyIgnoreCount,
            legacyIgnoreByCategory,
            legacyIgnoreReferences,
          },
          coverage: 'DOU_SECTIONS_1_3_NORMAL_AND_EXTRA', sections: [...DOU_XML_SECTIONS], supplementsVerified: false,
          archivalStorage: 'NOT_CONFIGURED', xmlTimelinessGuaranteed: false },
        douArchives: receipts,
        ...(Object.keys(reserveReceipts).length ? { douReserveArchives: reserveReceipts } : {}),
      } };
    } finally { client.close(); }
  }
}
