import type { CollectionConnector, ConnectorExecutionContext, ConnectorPartialFailure, ConnectorPublication, ConnectorResult } from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { InlabsClient, type InlabsCredentials, type InlabsXmlSection } from './inlabs.client.js';
import { readDouZip, parseDouEntries, type DouArchiveContext } from './dou.parser.js';

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
  readonly version = '0.2.0';
  readonly #options: DouOptions;
  constructor(options: DouOptions) { this.#options = options; }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const dates = this.#options.dates ?? douCollectionDates(now);
    if (!dates.length || dates.length > 4 || new Set(dates).size !== dates.length || dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) throw failure('DOU_INVALID_DATE_BATCH');
    const state = await this.#options.readState?.(context.sourceId, context.runId) ?? { archives: {} };
    // Do not silently discard a gap that exceeds the bounded reconciliation window.
    if (!this.#options.dates && state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() > 60 * 86400000) throw failure('DOU_BACKFILL_REQUIRED');
    const client = new InlabsClient({ credentials: this.#options.credentials, ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}) });
    const publications: ConnectorPublication[] = []; const partialFailures: ConnectorPartialFailure[] = [];
    const receipts: Record<string, string> = { ...state.archives };
    const archives: Array<Record<string, unknown>> = []; let available = 0; let xmlCount = 0; let mediaCount = 0;
    const editions = new Set<string>();
    try {
      await client.login(context.signal);
      for (const date of dates) {
        for (const section of ['DO1', 'DO1E'] as InlabsXmlSection[]) {
          context.signal.throwIfAborted();
          const filename = `${date}-${section}.zip`;
          const download = await client.downloadXml(date, section, context.signal);
          if (download.status === 'NOT_AVAILABLE') {
            archives.push({ filename, state: 'NOT_AVAILABLE', date, section });
            continue;
          }
          available++;
          if (state.archives[filename] === download.rawSha256) {
            archives.push({ filename, state: 'UNCHANGED', date, section, rawSha256: download.rawSha256 });
            continue;
          }
          const archive: DouArchiveContext = { filename, date, section, officialUrl: download.officialUrl, rawSha256: download.rawSha256 };
          const extracted = await readDouZip(download.bytes, context.signal);
          if (!extracted.entries.length) throw failure('DOU_ARCHIVE_HAS_NO_XML', true);
          const parsed = parseDouEntries(extracted.entries, archive);
          xmlCount += extracted.entries.length; mediaCount += extracted.mediaCount;
          publications.push(...parsed.publications); partialFailures.push(...parsed.partialFailures);
          for (const p of parsed.publications) {
            const data = p.metadata?.dou as { edition: string };
            editions.add(`${date}:${data.edition}`);
          }
          if (!parsed.partialFailures.length) receipts[filename] = download.rawSha256;
          archives.push({ ...archive, state: parsed.partialFailures.length ? 'PARTIAL' : 'PARSED', xmlCount: extracted.entries.length, matterCount: parsed.publications.length, mediaCount: extracted.mediaCount });
        }
      }
      if (!available) throw failure('INLABS_EDITIONS_NOT_AVAILABLE', true);
      // Bound receipt history. Only a terminal successful RUN makes these receipts
      // eligible as a checkpoint; attempt success alone precedes publication persistence.
      const cutoff = new Date(now); cutoff.setUTCDate(cutoff.getUTCDate() - 65);
      for (const name of Object.keys(receipts)) if (name.slice(0, 10) < cutoff.toISOString().slice(0, 10)) delete receipts[name];
      return { publications, partialFailures, metadata: {
        dou: { archives, xmlCount, mediaCount, assembledMatterCount: publications.length, editions: [...editions],
          partialFailures,
          confazMatterCount: publications.filter(p => p.agency === 'CONFAZ').length,
          coverage: 'SECTION_1_NORMAL_AND_EXTRA', supplementsVerified: false,
          archivalStorage: 'NOT_CONFIGURED', xmlTimelinessGuaranteed: false },
        douArchives: receipts,
      } };
    } finally { client.close(); }
  }
}
