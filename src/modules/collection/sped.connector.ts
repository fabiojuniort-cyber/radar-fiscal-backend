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
  SpedClient,
  type SpedClientOptions,
} from './sped.client.js';
import {
  descriptorFromPage,
  isAllowedGlobalHighlight,
  isTechnicalNavigationText,
  moduleTextMatches,
  parseSpedPage,
  type SpedDocumentDescriptor,
  type SpedDocumentKind,
  type SpedModule,
} from './sped.parser.js';

export const SPED_CONNECTOR_KEY = 'sped';
const SPED_ORIGIN = 'https://sped.rfb.gov.br';
const DEFAULT_REVISIT_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECHECKS_PER_RUN = 32;
const DEFAULT_MAX_PAGES_PER_MODULE = 180;
const DEFAULT_MAX_CRAWL_DEPTH = 3;

interface SpedModuleSeed {
  url: string;
  kind: 'MODULE' | 'CATEGORY' | 'MODULE_HIGHLIGHTS' | 'GLOBAL_HIGHLIGHTS';
}

export interface SpedModuleDefinition {
  module: SpedModule;
  seeds: SpedModuleSeed[];
}

export const SPED_MODULES: ReadonlyArray<SpedModuleDefinition> = [
  {
    module: 'EFD_ICMS_IPI',
    seeds: [
      { url: SPED_ORIGIN + '/projeto/show/274', kind: 'MODULE' },
      { url: SPED_ORIGIN + '/item/show/1573', kind: 'CATEGORY' },
      { url: SPED_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_CONTRIBUICOES',
    seeds: [
      { url: SPED_ORIGIN + '/projeto/show/268', kind: 'MODULE' },
      { url: SPED_ORIGIN + '/item/show/1545', kind: 'CATEGORY' },
      { url: SPED_ORIGIN + '/destaques/show/285', kind: 'MODULE_HIGHLIGHTS' },
      { url: SPED_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_REINF',
    seeds: [
      { url: SPED_ORIGIN + '/projeto/show/1196', kind: 'MODULE' },
      { url: SPED_ORIGIN + '/destaques/show/1199', kind: 'MODULE_HIGHLIGHTS' },
      { url: SPED_ORIGIN + '/item/show/2270', kind: 'CATEGORY' },
    ],
  },
  {
    module: 'DERE',
    seeds: [
      { url: SPED_ORIGIN + '/pagina/show/7950', kind: 'CATEGORY' },
      { url: SPED_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
] as const;

export interface SpedStoredFile {
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  filename?: string;
  sourceEtag?: string;
  sourceLastModified?: string;
  checkedAt: string;
}

export interface SpedSourceState {
  items: Record<string, SpedStoredFile>;
}

export interface SpedConnectorOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  readState?: (sourceId: string) => Promise<SpedSourceState>;
  client?: Omit<SpedClientOptions, 'fetch'>;
  revisitAfterMs?: number;
  maxRechecksPerRun?: number;
  maxPagesPerModule?: number;
  maxCrawlDepth?: number;
}

interface DiscoveredFile {
  module: SpedModule;
  publicationExternalId: string;
  url: string;
  externalId: string;
  name?: string;
}

interface CrawlPage {
  url: string;
  depth: number;
  seedKind: SpedModuleSeed['kind'];
}

interface ModuleCrawlResult {
  module: SpedModule;
  descriptors: SpedDocumentDescriptor[];
  pagesSucceeded: number;
  pagesFailed: number;
  pagesVisited: number;
  seedSuccesses: number;
  failures: ConnectorPartialFailure[];
}

function failureInfo(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof ConnectorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'SPED_UNHANDLED_ERROR',
    message: error instanceof Error ? error.message : 'Unknown SPED error',
  };
}

function kindLabel(kind: SpedDocumentKind): string {
  switch (kind) {
    case 'GUIDE': return 'GUIA PRÁTICO SPED';
    case 'TECHNICAL_NOTE': return 'NOTA TÉCNICA SPED';
    case 'ORIENTATION_NOTE': return 'NOTA ORIENTATIVA SPED';
    case 'LAYOUT': return 'LEIAUTE SPED';
    case 'XSD_SCHEMA': return 'ESQUEMA XSD SPED';
    case 'TABLE': return 'TABELA SPED';
    case 'SOFTWARE_RELEASE': return 'VERSÃO DE SOFTWARE SPED';
    case 'MANUAL': return 'MANUAL SPED';
    case 'EVOLUTION_DOCUMENT': return 'DOCUMENTAÇÃO EVOLUTIVA SPED';
    case 'OPERATIONAL_NOTICE': return 'AVISO OPERACIONAL SPED';
  }
}

function moduleLabel(module: SpedModule): string {
  switch (module) {
    case 'EFD_ICMS_IPI': return 'EFD ICMS/IPI';
    case 'EFD_CONTRIBUICOES': return 'EFD-Contribuições';
    case 'EFD_REINF': return 'EFD-Reinf';
    case 'DERE': return 'DeRE';
  }
}

function stateKey(file: DiscoveredFile): string {
  return file.module + ':' + file.publicationExternalId + ':' + file.externalId;
}

function checkedAtMs(stored: SpedStoredFile): number {
  const value = Date.parse(stored.checkedAt);
  return Number.isFinite(value) ? value : 0;
}

function discoveredFiles(descriptors: SpedDocumentDescriptor[]): DiscoveredFile[] {
  return descriptors.flatMap((descriptor) =>
    descriptor.files.map((file) => ({
      module: descriptor.module,
      publicationExternalId: descriptor.externalId,
      url: file.url,
      externalId: file.externalId,
      ...(file.name ? { name: file.name } : {}),
    })),
  );
}

function selectKnownRechecks(
  files: DiscoveredFile[],
  state: SpedSourceState,
  now: Date,
  revisitAfterMs: number,
  maxRechecksPerRun: number,
): Set<string> {
  const nowMs = now.getTime();
  const candidates = files
    .map((file) => {
      const key = stateKey(file);
      const previous = state.items[key];
      return previous ? { key, checkedAtMs: checkedAtMs(previous) } : undefined;
    })
    .filter((candidate): candidate is { key: string; checkedAtMs: number } =>
      candidate !== undefined && nowMs - candidate.checkedAtMs >= revisitAfterMs,
    )
    .sort((left, right) => left.checkedAtMs - right.checkedAtMs || left.key.localeCompare(right.key))
    .slice(0, maxRechecksPerRun);
  return new Set(candidates.map((candidate) => candidate.key));
}

function samePortalNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin.toLowerCase() !== SPED_ORIGIN.toLowerCase()) return false;
    return /^\/(?:item|pasta|projeto|pagina)\/show\/\d+$/i.test(parsed.pathname)
      || /^\/arquivo\/show\/\d+$/i.test(parsed.pathname)
      || /^\/destaques\/show\/\d+$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function shouldFollowLink(
  module: SpedModule,
  seedKind: SpedModuleSeed['kind'],
  text: string,
  url: string,
): boolean {
  if (!samePortalNavigation(url)) return false;
  if (seedKind === 'GLOBAL_HIGHLIGHTS') return isAllowedGlobalHighlight(module, text);
  if (/\/destaques\/show\//i.test(url)) return true;
  if (
    seedKind === 'MODULE_HIGHLIGHTS' &&
    /INDISPONIBILIDADE|INTERRUPÇÃO|INTERRUPCAO|MANUTENÇÃO|MANUTENCAO/i.test(text)
  ) {
    return true;
  }
  return isTechnicalNavigationText(text) || moduleTextMatches(module, text);
}

async function crawlModule(
  definition: SpedModuleDefinition,
  client: SpedClient,
  context: ConnectorExecutionContext,
  maxPagesPerModule: number,
  maxCrawlDepth: number,
): Promise<ModuleCrawlResult> {
  const queue: CrawlPage[] = definition.seeds.map((seed) => ({
    url: seed.url,
    depth: 0,
    seedKind: seed.kind,
  }));
  const seen = new Set<string>();
  const descriptors = new Map<string, SpedDocumentDescriptor>();
  const failures: ConnectorPartialFailure[] = [];
  let pagesSucceeded = 0;
  let pagesFailed = 0;
  let seedSuccesses = 0;

  while (queue.length && seen.size < maxPagesPerModule) {
    context.signal.throwIfAborted();
    const current = queue.shift()!;
    if (seen.has(current.url)) continue;
    seen.add(current.url);
    try {
      const response = await client.getHtml(current.url, context.signal);
      const page = parseSpedPage(response.html, response.url);
      pagesSucceeded += 1;
      if (current.depth === 0) seedSuccesses += 1;
      const descriptor = descriptorFromPage(definition.module, page);
      if (descriptor) descriptors.set(descriptor.externalId, descriptor);
      if (current.depth >= maxCrawlDepth) continue;
      for (const link of page.links) {
        if (!shouldFollowLink(definition.module, current.seedKind, link.text, link.url)) continue;
        if (seen.has(link.url)) continue;
        queue.push({
          url: link.url,
          depth: current.depth + 1,
          seedKind: current.seedKind === 'GLOBAL_HIGHLIGHTS' ? 'GLOBAL_HIGHLIGHTS' : 'CATEGORY',
        });
      }
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
      pagesFailed += 1;
      const failure = failureInfo(error);
      failures.push({
        code: failure.code,
        message: failure.message,
        itemReference: current.url,
      });
    }
  }

  return {
    module: definition.module,
    descriptors: [...descriptors.values()],
    pagesSucceeded,
    pagesFailed,
    pagesVisited: seen.size,
    seedSuccesses,
    failures,
  };
}

function connectorFile(
  file: DiscoveredFile,
  stored: SpedStoredFile,
): ConnectorFile {
  return {
    url: file.url,
    externalId: file.externalId,
    rawSha256: stored.rawSha256,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType,
    ...(stored.filename ?? file.name ? { name: stored.filename ?? file.name } : {}),
    ...(stored.sourceEtag ? { sourceEtag: stored.sourceEtag } : {}),
    ...(stored.sourceLastModified ? { sourceLastModified: stored.sourceLastModified } : {}),
    metadata: {
      module: file.module,
      publicationExternalId: file.publicationExternalId,
      officialFileId: file.externalId,
    },
  };
}

function publicationFor(
  descriptor: SpedDocumentDescriptor,
  files: ConnectorFile[],
): ConnectorPublication {
  const agency = descriptor.module === 'DERE' ? 'RFB/CGIBS' : 'SPED/RFB';
  return {
    title: descriptor.title,
    agency,
    sphere: 'FEDERAL',
    actType: kindLabel(descriptor.kind),
    ...(descriptor.actNumber ? { actNumber: descriptor.actNumber } : {}),
    ...(descriptor.publishedAt ? { publishedAt: descriptor.publishedAt } : {}),
    ...(descriptor.description ? { content: descriptor.description } : {}),
    officialUrl: descriptor.officialUrl,
    externalId: descriptor.externalId,
    ...(files.length ? { files } : {}),
    metadata: {
      module: descriptor.module,
      moduleLabel: moduleLabel(descriptor.module),
      documentKind: descriptor.kind,
      documentFamily: descriptor.documentFamily,
      revisionKind: descriptor.revisionKind,
      republication: descriptor.republication,
      documentStatus: descriptor.documentStatus,
      itemId: descriptor.itemId,
      ...(descriptor.documentNumber ? { documentNumber: descriptor.documentNumber } : {}),
      ...(descriptor.officialVersion ? { officialVersion: descriptor.officialVersion } : {}),
      ...(descriptor.updatedAt ? { updatedAt: descriptor.updatedAt.toISOString().slice(0, 10) } : {}),
      relatedTaxes: descriptor.relatedTaxes,
      affectedRecords: descriptor.affectedRecords,
      fileCount: files.length,
    },
  };
}

export class SpedConnector implements CollectionConnector {
  readonly key = SPED_CONNECTOR_KEY;
  readonly version = '0.1.0';
  readonly #options: SpedConnectorOptions;

  constructor(options: SpedConnectorOptions = {}) {
    const revisitAfterMs = options.revisitAfterMs ?? DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun = options.maxRechecksPerRun ?? DEFAULT_MAX_RECHECKS_PER_RUN;
    const maxPagesPerModule = options.maxPagesPerModule ?? DEFAULT_MAX_PAGES_PER_MODULE;
    const maxCrawlDepth = options.maxCrawlDepth ?? DEFAULT_MAX_CRAWL_DEPTH;
    for (const [name, value, minimum] of [
      ['revisitAfterMs', revisitAfterMs, 0],
      ['maxRechecksPerRun', maxRechecksPerRun, 0],
      ['maxPagesPerModule', maxPagesPerModule, 1],
      ['maxCrawlDepth', maxCrawlDepth, 0],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(name + ' must be an integer >= ' + minimum);
    }
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const state = await this.#options.readState?.(context.sourceId) ?? { items: {} };
    const revisitAfterMs = this.#options.revisitAfterMs ?? DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun = this.#options.maxRechecksPerRun ?? DEFAULT_MAX_RECHECKS_PER_RUN;
    const maxPagesPerModule = this.#options.maxPagesPerModule ?? DEFAULT_MAX_PAGES_PER_MODULE;
    const maxCrawlDepth = this.#options.maxCrawlDepth ?? DEFAULT_MAX_CRAWL_DEPTH;
    const client = new SpedClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });
    const partialFailures: ConnectorPartialFailure[] = [];
    const crawlResults: ModuleCrawlResult[] = [];

    try {
      for (const definition of SPED_MODULES) {
        context.signal.throwIfAborted();
        const result = await crawlModule(definition, client, context, maxPagesPerModule, maxCrawlDepth);
        crawlResults.push(result);
        partialFailures.push(...result.failures);
      }

      const modulesSucceeded = crawlResults.filter((result) => result.seedSuccesses > 0).length;
      if (modulesSucceeded === 0) {
        throw new ConnectorError('SPED_ALL_MODULES_FAILED', {
          code: 'SPED_ALL_MODULES_FAILED',
          kind: 'SOURCE_UNAVAILABLE',
          retryable: true,
          metadata: {
            modules: crawlResults.map((result) => ({
              module: result.module,
              pagesSucceeded: result.pagesSucceeded,
              pagesFailed: result.pagesFailed,
              seedSuccesses: result.seedSuccesses,
            })),
          },
        });
      }

      const descriptors = crawlResults.flatMap((result) => result.descriptors);
      const files = discoveredFiles(descriptors);
      const recheckKeys = selectKnownRechecks(files, state, now, revisitAfterMs, maxRechecksPerRun);
      const nextItems: Record<string, SpedStoredFile> = {};
      const resolvedFiles = new Map<string, ConnectorFile>();
      let downloadedCount = 0;
      let notModifiedCount = 0;
      let reusedCheckpointCount = 0;
      let recheckedKnownCount = 0;
      let newFileDownloadCount = 0;

      for (const file of files) {
        context.signal.throwIfAborted();
        const key = stateKey(file);
        const previous = state.items[key];
        if (previous && !recheckKeys.has(key)) {
          nextItems[key] = previous;
          resolvedFiles.set(key, connectorFile(file, previous));
          reusedCheckpointCount += 1;
          continue;
        }
        if (previous) recheckedKnownCount += 1;
        else newFileDownloadCount += 1;
        try {
          const response = await client.downloadFile(
            file.url,
            context.signal,
            previous
              ? {
                  ...(previous.sourceEtag ? { etag: previous.sourceEtag } : {}),
                  ...(previous.sourceLastModified ? { lastModified: previous.sourceLastModified } : {}),
                }
              : {},
          );
          let stored: SpedStoredFile;
          if (response.status === 'NOT_MODIFIED') {
            if (!previous) {
              throw new ConnectorError('SPED_304_WITHOUT_CHECKPOINT', {
                code: 'SPED_304_WITHOUT_CHECKPOINT',
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
            stored = {
              rawSha256: response.rawSha256,
              sizeBytes: response.sizeBytes,
              mimeType: response.mimeType,
              checkedAt: now.toISOString(),
              ...(response.filename ? { filename: response.filename } : {}),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          }
          nextItems[key] = stored;
          resolvedFiles.set(key, connectorFile(file, stored));
        } catch (error) {
          if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
          if (previous) {
            nextItems[key] = previous;
            resolvedFiles.set(key, connectorFile(file, previous));
          }
          const failure = failureInfo(error);
          partialFailures.push({
            code: failure.code,
            message: failure.message,
            itemReference: file.url,
          });
        }
      }

      const publications: ConnectorPublication[] = [];
      for (const descriptor of descriptors) {
        const descriptorFiles = descriptor.files
          .map((file) => resolvedFiles.get(stateKey({
            module: descriptor.module,
            publicationExternalId: descriptor.externalId,
            url: file.url,
            externalId: file.externalId,
            ...(file.name ? { name: file.name } : {}),
          })))
          .filter((file): file is ConnectorFile => file !== undefined);
        if (descriptor.files.length > 0 && descriptorFiles.length === 0) continue;
        publications.push(publicationFor(descriptor, descriptorFiles));
      }

      return {
        publications,
        ...(partialFailures.length ? { partialFailures } : {}),
        metadata: {
          sped: {
            modulesSucceeded,
            modulesTotal: SPED_MODULES.length,
            moduleResults: crawlResults.map((result) => ({
              module: result.module,
              pagesSucceeded: result.pagesSucceeded,
              pagesFailed: result.pagesFailed,
              pagesVisited: result.pagesVisited,
              seedSuccesses: result.seedSuccesses,
              documentCount: result.descriptors.length,
            })),
            discoveredDocumentCount: descriptors.length,
            publicationCount: publications.length,
            discoveredFileCount: files.length,
            downloadedCount,
            notModifiedCount,
            reusedCheckpointCount,
            recheckedKnownCount,
            newFileDownloadCount,
            revisitAfterMs,
            maxRechecksPerRun,
            partialFailureCount: partialFailures.length,
            scope: ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE'],
          },
          spedState: { items: nextItems },
        },
      };
    } finally {
      client.close();
    }
  }
}
