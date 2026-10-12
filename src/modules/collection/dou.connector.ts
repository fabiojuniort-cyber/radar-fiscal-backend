import type { CollectionConnector, ConnectorExecutionContext, ConnectorPartialFailure, ConnectorPublication, ConnectorResult } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { InlabsClient, type InlabsCredentials, type InlabsXmlSection } from './inlabs.client.js';
import { parseDouZip, type DouArchiveContext } from './dou.parser.js';
import { classifyDouContractExcerpt, DOU_SCOPE_RULE_VERSION } from './dou-scope.rules.js';

export const DOU_XML_SECTIONS: readonly InlabsXmlSection[] = ['DO1', 'DO1E', 'DO3', 'DO3E'];

export interface DouState {
  archives: Record<string, string>;
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
  /** Explicit sections for controlled BACKFILL only; regular monitoring keeps all four. */
  sections?: readonly InlabsXmlSection[];
  /**
   * Backfill of past dates only: a batch where every package is absent is a
   * consulted batch without editions (weekends, holidays), not a pending
   * availability to retry. Monitoring never sets it.
   */
  allowEmptyBatch?: boolean;
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
    const dates = this.#options.dates ?? douCollectionDates(now);
    const sections = this.#options.sections ?? DOU_XML_SECTIONS;
    if (!sections.length || new Set(sections).size !== sections.length || sections.some(s => !DOU_XML_SECTIONS.includes(s))) throw failure('DOU_INVALID_SECTION_SET');
    if (!dates.length || dates.length > 4 || new Set(dates).size !== dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw failure('DOU_INVALID_DATE_BATCH');
    const state = await this.#options.readState?.(context.sourceId, context.runId) ?? { archives: {} };
    // Do not silently discard a gap that exceeds the bounded reconciliation window.
    if (!this.#options.dates && state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() > 60 * 86400000) throw failure('DOU_BACKFILL_REQUIRED');
    const client = new InlabsClient({ credentials: this.#options.credentials, ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}) });
    const partialFailures: ConnectorPartialFailure[] = [];
    const receipts: Record<string, string> = { ...state.archives };
    const archives: Array<Record<string, unknown>> = []; let available = 0; let xmlCount = 0; let mediaCount = 0;
    let assembledMatterCount = 0; let scopeIgnoredCount = 0;
    let publicationCount = 0; let embeddedActCount = 0; let confazMatterCount = 0;
    const scopeIgnoredByCategory: Record<string, number> = {};
    const scopeIgnoredReferences: Array<Record<string, unknown>> = [];
    const editions = new Set<string>();
    try {
      await client.login(context.signal);
      for (const date of dates) {
        for (const section of sections) {
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
          if (state.archives[filename] === download.rawSha256) {
            archives.push({ filename, state: 'UNCHANGED', date, section, rawSha256: download.rawSha256 });
            continue;
          }
          const archive: DouArchiveContext = { filename, date, section, officialUrl: download.officialUrl, rawSha256: download.rawSha256 };
          let sourceMatterCount = 0; let archivePublicationCount = 0; let archiveEmbeddedActCount = 0;
          let archiveIgnoredCount = 0;
          const parsed = await parseDouZip(download.bytes, archive, context.signal, async publication => {
            const data = publication.metadata?.dou as { edition: string; embeddedAct?: boolean };
            editions.add(`${date}:${data.edition}`);
            if (data.embeddedAct !== true) sourceMatterCount++;
            const classification = classifyDouContractExcerpt(publication);
            if (classification?.decision === 'IGNORE') {
              scopeIgnoredCount += 1;
              archiveIgnoredCount += 1;
              scopeIgnoredByCategory[classification.category] = (scopeIgnoredByCategory[classification.category] ?? 0) + 1;
              if (scopeIgnoredReferences.length < 100) {
                scopeIgnoredReferences.push({
                  externalId: publication.externalId ?? null,
                  officialUrl: publication.officialUrl,
                  actType: publication.actType ?? null,
                  category: classification.category,
                  reasonCodes: classification.reasonCodes,
                });
              }
              return;
            }
            // The sink controls backpressure. No whole-run publications array
            // exists in the engine path, and multipart matters are already whole.
            await emit(classification ? {
              ...publication,
              metadata: { ...publication.metadata, douScope: classification },
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
            scopeIgnoredCount: archiveIgnoredCount,
            mediaCount: parsed.mediaCount,
          });
        }
      }
      if (!available && !this.#options.allowEmptyBatch) throw failure('INLABS_EDITIONS_NOT_AVAILABLE', true);
      // Bound receipt history. Only a terminal successful RUN makes these receipts
      // eligible as a checkpoint; attempt success alone precedes publication persistence.
      const cutoff = new Date(now); cutoff.setUTCDate(cutoff.getUTCDate() - 65);
      for (const name of Object.keys(receipts)) if (name.slice(0, 10) < cutoff.toISOString().slice(0, 10)) delete receipts[name];
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
            ignoredCount: scopeIgnoredCount,
            ignoredByCategory: scopeIgnoredByCategory,
            ignoredReferences: scopeIgnoredReferences,
            ignoredReferenceLimit: 100,
          },
          coverage: this.#options.sections ? 'DOU_BACKFILL_EXPLICIT_SECTIONS' : 'DOU_SECTIONS_1_3_NORMAL_AND_EXTRA', sections: [...sections], supplementsVerified: false,
          archivalStorage: 'NOT_CONFIGURED', xmlTimelinessGuaranteed: false },
        douArchives: receipts,
      } };
    } finally { client.close(); }
  }
}
