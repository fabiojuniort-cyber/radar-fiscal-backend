import type {
  CollectionConnector,
  ConnectorExecutionContext,
  ConnectorFile,
  ConnectorPartialFailure,
  ConnectorPublication,
  ConnectorResult,
} from './connector.contract.js';
import { ConnectorError } from './connector.error.js';
import { extractCgibsText, type CgibsTextExtraction } from './cgibs.text.js';
import {
  CGIBS_BASE_URL,
  CgibsClient,
  type CgibsClientOptions,
} from './cgibs.client.js';
import {
  parseCgibsContainer,
  parseCgibsDetailPage,
  type CgibsDocumentDescriptor,
  type CgibsFamily,
  type CgibsPageCandidate,
} from './cgibs.parser.js';

export const CGIBS_CONNECTOR_KEY = 'cgibs';
export const CGIBS_STATE_VERSION = 1;

const DEFAULT_REVISIT_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECHECKS_PER_RUN = 48;
const DEFAULT_MAX_DETAIL_PAGES_PER_RUN = 120;

export interface CgibsSeed {
  family: CgibsFamily;
  url: string;
}

export const CGIBS_SEEDS: ReadonlyArray<CgibsSeed> = [
  { family: 'RESOLUTIONS', url: CGIBS_BASE_URL + 'resolucoes' },
  { family: 'REGULATIONS', url: CGIBS_BASE_URL + 'regulamentos' },
  { family: 'PORTARIAS', url: CGIBS_BASE_URL + 'portarias' },
  { family: 'JOINT_ACTS', url: CGIBS_BASE_URL + 'atos-conjuntos' },
  { family: 'JOINT_TECHNICAL_ACTS', url: CGIBS_BASE_URL + 'atos-tecnicos-conjuntos' },
  { family: 'OFFICIAL_COMMUNIQUES', url: CGIBS_BASE_URL + 'comunicados-oficiais' },
  { family: 'TECHNICAL_DOCUMENTS', url: CGIBS_BASE_URL + 'documentos-tecnicos' },
  { family: 'TECHNICAL_DOCUMENTS', url: CGIBS_BASE_URL + 'declaracao-de-regimes-especificos-dere' },
  { family: 'TECHNICAL_DOCUMENTS', url: CGIBS_BASE_URL + 'split-payment' },
  { family: 'GUIDES', url: CGIBS_BASE_URL + 'guias' },
  { family: 'BOOKLETS', url: CGIBS_BASE_URL + 'cartilhas' },
  { family: 'NEWS', url: CGIBS_BASE_URL + 'noticias' },
] as const;

export interface CgibsStoredFile {
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  checkedAt: string;
  filename?: string;
  sourceEtag?: string;
  sourceLastModified?: string;
  /** Identity this origin owns; see resolveIdentityKey. */
  identityKey?: string;
  /** Outcome of reading the file's text; absent means never attempted. */
  contentExtraction?: CgibsTextExtraction;
}

export interface CgibsPersistedOrigins {
  identityKeys: Record<string, string>;
  linked: Set<string>;
}

export interface CgibsSourceState {
  items: Record<string, CgibsStoredFile>;
}

export interface CgibsConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<CgibsSourceState>;
  readPersistedOrigins?: (sourceId: string) => Promise<CgibsPersistedOrigins>;
  client?: Omit<CgibsClientOptions, 'fetch'>;
  revisitAfterMs?: number;
  maxRechecksPerRun?: number;
  maxDetailPagesPerRun?: number;
}

function failureInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorError) return { code: error.code, message: error.message };
  return {
    code: 'CGIBS_UNHANDLED_ERROR',
    message: error instanceof Error ? error.message : 'Unknown CGIBS error',
  };
}

function due(previous: CgibsStoredFile | undefined, now: Date, revisitAfterMs: number): boolean {
  if (!previous) return true;
  const checked = Date.parse(previous.checkedAt);
  return !Number.isFinite(checked) || now.getTime() - checked >= revisitAfterMs;
}

function stateKey(item: CgibsDocumentDescriptor): string {
  return item.externalId ?? item.fileUrl ?? item.officialUrl;
}

function connectorFile(item: CgibsDocumentDescriptor, stored: CgibsStoredFile): ConnectorFile {
  const url = item.fileUrl ?? item.officialUrl;
  return {
    url,
    ...(item.fileName ?? stored.filename ? { name: item.fileName ?? stored.filename } : {}),
    externalId: item.externalId ?? url,
    rawSha256: stored.rawSha256,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType,
    ...(stored.sourceEtag ? { sourceEtag: stored.sourceEtag } : {}),
    ...(stored.sourceLastModified ? { sourceLastModified: stored.sourceLastModified } : {}),
    metadata: {
      family: item.family,
      documentFamily: item.documentFamily,
      ...(item.officialVersion ? { officialVersion: item.officialVersion } : {}),
      sourceRole: item.sourceRole,
    },
  };
}

/**
 * Identity an origin is published under.
 *
 * A CGIBS origin is the stable path of one published file, so it always names
 * the same document: a new act, or a new official version of one, is a new
 * file at a new path and therefore a new origin. The derived key, by
 * contrast, is built from what the listing page says (family, document
 * family, version read from the title text, restricted-production scope), so
 * the portal rewording a title, moving a document between listings or
 * editing a section silently changes it. Persistence then refuses the write,
 * because the origin is already linked to the previous identity.
 *
 * So an origin that already owns an identity keeps it, and only a genuinely
 * new origin takes the derived key. The reworded listing becomes a new
 * version of the same publication instead of a conflict. The reference is
 * the checkpoint, falling back to the identity persisted for that origin —
 * which is what matters for an item that failed in the last run, since
 * persistence accepts no other key for it.
 */
function resolveIdentityKey(
  item: CgibsDocumentDescriptor,
  previous: CgibsStoredFile | undefined,
  persisted: Record<string, string>,
): string {
  if (!item.fileUrl) return item.identityKey;
  return previous?.identityKey ?? persisted[stateKey(item)] ?? item.identityKey;
}

/**
 * Whether an unchanged file still has to be emitted.
 *
 * The catalog is re-listed on every run, but re-emitting a document whose
 * bytes did not change would be a no-op at best. It is worse than that here:
 * the text is extracted from the downloaded bytes, so a run that reuses the
 * checkpoint has no text to send, and the content hash covers the text, so
 * the publication would alternate between having a body and not having one,
 * creating an empty version every other run. An unchanged file is therefore
 * left alone — but only once its text has been read and the origin is proven
 * persisted, so a document that never landed is never silently skipped.
 */
function settled(previous: CgibsStoredFile | undefined, key: string, linked: ReadonlySet<string>): boolean {
  return previous?.contentExtraction !== undefined && linked.has(key);
}

function publicationFor(
  item: CgibsDocumentDescriptor,
  stored?: CgibsStoredFile,
  identityKey: string = item.identityKey,
  text?: string,
): ConnectorPublication {
  const canUseStrongIdentity =
    item.actNumber !== undefined &&
    item.publishedAt !== undefined &&
    /^RESOLU|^PORTARIA|^ATO |^COMUNICADO|^NOTA ORIENTATIVA/i.test(item.actType ?? '');

  return {
    title: item.title,
    agency: 'CGIBS',
    sphere: 'FEDERAL',
    ...(item.actType ? { actType: item.actType } : {}),
    ...(item.actNumber ? { actNumber: item.actNumber } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.effectiveAt ? { effectiveAt: item.effectiveAt } : {}),
    ...(text ?? item.content ? { content: text ?? item.content } : {}),
    ...(item.presentationHtml
      ? {
          presentationHtml:
            item.presentationHtml,
        }
      : {}),
    officialUrl: item.officialUrl,
    ...(item.externalId ? { externalId: item.externalId } : {}),
    ...(!canUseStrongIdentity ? { identityKey } : {}),
    ...(stored ? { files: [connectorFile(item, stored)] } : {}),
    metadata: {
      ...item.metadata,
      sourceRole: item.sourceRole,
      family: item.family,
      documentFamily: item.documentFamily,
      documentStatus: item.documentStatus,
      revisionKind: item.revisionKind,
      ...(item.officialVersion ? { officialVersion: item.officialVersion } : {}),
      ...(item.section ? { section: item.section } : {}),
      ...(item.pageUrl ? { listingOrPageUrl: item.pageUrl } : {}),
      normativeKey: identityKey,
    },
  };
}

function mergeDocuments(items: CgibsDocumentDescriptor[]): CgibsDocumentDescriptor[] {
  const byOrigin = new Map<string, CgibsDocumentDescriptor>();
  for (const item of items) {
    const key = item.externalId ?? item.officialUrl;
    const existing = byOrigin.get(key);
    if (!existing) {
      byOrigin.set(key, item);
      continue;
    }
    if (existing.sourceRole !== 'PRIMARY' && item.sourceRole === 'PRIMARY') {
      byOrigin.set(key, item);
      continue;
    }
    const categories = new Set<string>([
      ...((existing.metadata.categories as string[] | undefined) ?? [existing.family]),
      item.family,
    ]);
    existing.metadata.categories = [...categories];
  }
  return [...byOrigin.values()];
}

function mergePages(items: CgibsPageCandidate[]): CgibsPageCandidate[] {
  const unique = new Map<string, CgibsPageCandidate>();
  for (const item of items) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  return [...unique.values()];
}

export class CgibsConnector implements CollectionConnector {
  readonly key = CGIBS_CONNECTOR_KEY;
  readonly version = '0.1.0';
  readonly #options: CgibsConnectorOptions;

  constructor(options: CgibsConnectorOptions = {}) {
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const state = await this.#options.readState?.(context.sourceId) ?? { items: {} };
    const persisted = await this.#options.readPersistedOrigins?.(context.sourceId)
      ?? { identityKeys: {}, linked: new Set<string>() };
    const revisitAfterMs = this.#options.revisitAfterMs ?? DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun = this.#options.maxRechecksPerRun ?? DEFAULT_MAX_RECHECKS_PER_RUN;
    const maxDetailPagesPerRun = this.#options.maxDetailPagesPerRun ?? DEFAULT_MAX_DETAIL_PAGES_PER_RUN;
    const client = new CgibsClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });

    const partialFailures: ConnectorPartialFailure[] = [];
    const discoveredDocuments: CgibsDocumentDescriptor[] = [];
    const pageCandidates: CgibsPageCandidate[] = [];
    const seedResults: Array<Record<string, unknown>> = [];
    let seedsSucceeded = 0;

    for (const seed of CGIBS_SEEDS) {
      context.signal.throwIfAborted();
      try {
        const response = await client.getHtml(seed.url, context.signal);
        const parsed = parseCgibsContainer(response.html, seed.family, response.url);
        seedsSucceeded += 1;
        discoveredDocuments.push(...parsed.documents);
        pageCandidates.push(...parsed.pageLinks);
        seedResults.push({
          family: seed.family,
          url: seed.url,
          finalUrl: response.url,
          status: 'SUCCESS',
          documentCount: parsed.documents.length,
          pageLinkCount: parsed.pageLinks.length,
        });
      } catch (error) {
        if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
        const failure = failureInfo(error);
        partialFailures.push({
          code: failure.code,
          message: failure.message,
          itemReference: seed.url,
        });
        seedResults.push({ family: seed.family, url: seed.url, status: 'FAILED', errorCode: failure.code });
      }
    }

    if (seedsSucceeded === 0) {
      throw new ConnectorError('CGIBS_ALL_SEEDS_FAILED', {
        code: 'CGIBS_ALL_SEEDS_FAILED',
        kind: 'SOURCE_UNAVAILABLE',
        retryable: true,
        metadata: { seedResults },
      });
    }

    let detailPagesFetched = 0;
    for (const candidate of mergePages(pageCandidates).slice(0, maxDetailPagesPerRun)) {
      context.signal.throwIfAborted();
      if (context.budget?.shouldYield()) break;
      try {
        const response = await client.getHtml(candidate.url, context.signal);
        const parsed = parseCgibsDetailPage(response.html, candidate.family, response.url);
        discoveredDocuments.push(...parsed.documents);
        detailPagesFetched += 1;
      } catch (error) {
        if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
        const failure = failureInfo(error);
        partialFailures.push({
          code: failure.code,
          message: failure.message,
          itemReference: candidate.url,
        });
      }
    }

    const discovered = mergeDocuments(discoveredDocuments);
    const nextItems: Record<string, CgibsStoredFile> = { ...state.items };
    const publications: ConnectorPublication[] = [];
    let downloadedCount = 0;
    let notModifiedCount = 0;
    let reusedCheckpointCount = 0;
    let recheckedKnownCount = 0;
    let rechecksUsed = 0;
    let newFileDownloadCount = 0;
    let keptIdentityCount = 0;
    let skippedUnchangedCount = 0;
    const unreadableByReason: Record<string, number> = {};

    for (const item of discovered) {
      context.signal.throwIfAborted();

      if (!item.fileUrl) {
        publications.push(publicationFor(item));
        continue;
      }

      const key = stateKey(item);
      const previous = state.items[key];
      const identityKey = resolveIdentityKey(item, previous, persisted.identityKeys);
      if (identityKey !== item.identityKey) keptIdentityCount += 1;
      // A known file whose text was never read must be fetched once, whatever
      // the revisit window says: that is how the catalog that predates text
      // extraction gets its body, spread over runs by the same recheck budget.
      const needsText = previous !== undefined && previous.contentExtraction === undefined;
      const shouldRecheck =
        previous !== undefined &&
        (needsText || due(previous, now, revisitAfterMs)) &&
        rechecksUsed < maxRechecksPerRun;

      if (previous && !shouldRecheck) {
        nextItems[key] = { ...previous, identityKey };
        reusedCheckpointCount += 1;
        if (settled(previous, key, persisted.linked)) {
          skippedUnchangedCount += 1;
          continue;
        }
        publications.push(publicationFor(item, previous, identityKey));
        continue;
      }

      if (previous) {
        recheckedKnownCount += 1;
        rechecksUsed += 1;
      } else {
        newFileDownloadCount += 1;
      }

      try {
        const response = await client.downloadFile(
          item.fileUrl,
          context.signal,
          previous
            ? {
                ...(previous.sourceEtag ? { etag: previous.sourceEtag } : {}),
                ...(previous.sourceLastModified ? { lastModified: previous.sourceLastModified } : {}),
              }
            : {},
        );

        let stored: CgibsStoredFile;
        let text: string | undefined;
        if (response.status === 'NOT_MODIFIED') {
          if (!previous) {
            throw new ConnectorError('CGIBS_304_WITHOUT_CHECKPOINT', {
              code: 'CGIBS_304_WITHOUT_CHECKPOINT',
              kind: 'PROCESSING_ERROR',
              retryable: false,
            });
          }
          notModifiedCount += 1;
          stored = {
            ...previous,
            checkedAt: now.toISOString(),
            ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
            ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
          };
        } else {
          downloadedCount += 1;
          const extracted = await extractCgibsText(response.bytes, response.mimeType);
          text = extracted.text || undefined;
          if (extracted.extraction !== 'PDF_TEXT') {
            unreadableByReason[extracted.extraction] = (unreadableByReason[extracted.extraction] ?? 0) + 1;
          }
          stored = {
            rawSha256: response.rawSha256,
            sizeBytes: response.sizeBytes,
            mimeType: response.mimeType,
            contentExtraction: extracted.extraction,
            checkedAt: now.toISOString(),
            ...(response.filename ? { filename: response.filename } : {}),
            ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
            ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
          };
        }
        nextItems[key] = { ...stored, identityKey };
        if (response.status === 'NOT_MODIFIED' && settled(previous, key, persisted.linked)) {
          skippedUnchangedCount += 1;
          continue;
        }
        publications.push(publicationFor(item, stored, identityKey, text));
      } catch (error) {
        if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
        if (previous) {
          nextItems[key] = { ...previous, identityKey };
          publications.push(publicationFor(item, previous, identityKey));
        }
        const failure = failureInfo(error);
        partialFailures.push({
          code: failure.code,
          message: failure.message,
          itemReference: item.fileUrl,
        });
      }
    }

    return {
      publications,
      ...(partialFailures.length ? { partialFailures } : {}),
      metadata: {
        cgibs: {
          seedsSucceeded,
          seedsTotal: CGIBS_SEEDS.length,
          seedResults,
          discoveredDocumentCount: discovered.length,
          detailPageCandidateCount: mergePages(pageCandidates).length,
          detailPagesFetched,
          publicationCount: publications.length,
          downloadedCount,
          notModifiedCount,
          reusedCheckpointCount,
          recheckedKnownCount,
          newFileDownloadCount,
          keptIdentityCount,
          skippedUnchangedCount,
          unreadableByReason,
          revisitAfterMs,
          maxRechecksPerRun,
          partialFailureCount: partialFailures.length,
          scope: [
            'RESOLUTIONS',
            'REGULATIONS',
            'PORTARIAS',
            'JOINT_ACTS',
            'JOINT_TECHNICAL_ACTS',
            'OFFICIAL_COMMUNIQUES',
            'TECHNICAL_DOCUMENTS',
            'GUIDES',
            'BOOKLETS',
            'OPERATIONAL_NEWS',
          ],
        },
      },
      checkpoint: {
        version: CGIBS_STATE_VERSION,
        state: { items: nextItems },
      },
    };
  }
}
