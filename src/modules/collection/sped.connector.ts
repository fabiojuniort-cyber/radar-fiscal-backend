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
const DEFAULT_MAX_PAGES_PER_MODULE = 600;
const DEFAULT_MAX_CRAWL_DEPTH = 5;

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
      { url: SPED_ORIGIN + '/projeto/show/2918', kind: 'MODULE' },
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

export type SpedPageKind = 'CONTAINER' | 'DOCUMENT' | 'UNKNOWN';

export interface SpedKnownPage {
  canonicalUrl: string;
  kind: SpedPageKind;
  module: SpedModule;
  checkedAt: string;
}

export interface SpedSourceState {
  items: Record<string, SpedStoredFile>;
  pages: Record<string, SpedKnownPage>;
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
  forceFetch?: boolean;
  parentExternalId?: string;
}

interface KnownDocumentCandidate {
  module: SpedModule;
  url: string;
  checkedAt: string;
}

interface ModuleCrawlResult {
  module: SpedModule;
  descriptors: Map<string, SpedDocumentDescriptor>;
  linkedArtifacts: Map<string, Set<string>>;
  candidates: KnownDocumentCandidate[];
  pagesSucceeded: number;
  pagesFailed: number;
  pagesVisited: number;
  skippedKnownDocuments: number;
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

function canonicalPortalUrl(value: string): string {
  const parsed = new URL(value, SPED_ORIGIN);
  parsed.hash = '';
  return parsed.toString();
}

function pageKindFromUrl(url: string): SpedPageKind {
  try {
    const pathname = new URL(url, SPED_ORIGIN).pathname;
    if (/^\/(?:projeto|pasta)\/show\/\d+$/i.test(pathname)) return 'CONTAINER';
    if (/^\/destaques\/show\/\d+$/i.test(pathname)) return 'CONTAINER';
    if (/^\/(?:pagina|arquivo)\/show\/\d+$/i.test(pathname)) return 'DOCUMENT';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
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

function isArtifactPage(url: string): boolean {
  try {
    return /^\/arquivo\/show\/\d+$/i.test(new URL(url, SPED_ORIGIN).pathname);
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

function rememberPage(
  pages: Record<string, SpedKnownPage>,
  requestedUrl: string,
  canonicalUrl: string,
  kind: SpedPageKind,
  module: SpedModule,
  checkedAt: string,
): void {
  const value: SpedKnownPage = { canonicalUrl, kind, module, checkedAt };
  pages[canonicalPortalUrl(requestedUrl)] = value;
  pages[canonicalUrl] = value;
}

function routeFor(
  state: SpedSourceState,
  url: string,
): SpedKnownPage | undefined {
  return state.pages[canonicalPortalUrl(url)];
}

function descriptorFiles(descriptors: Iterable<SpedDocumentDescriptor>): DiscoveredFile[] {
  return [...descriptors].flatMap((descriptor) =>
    descriptor.files.map((file) => ({
      module: descriptor.module,
      publicationExternalId: descriptor.externalId,
      url: file.url,
      externalId: file.externalId,
      ...(file.name ? { name: file.name } : {}),
    })),
  );
}

function mergeLinkedArtifacts(
  descriptors: Map<string, SpedDocumentDescriptor>,
  linkedArtifacts: Map<string, Set<string>>,
): SpedDocumentDescriptor[] {
  const descriptorByUrl = new Map(
    [...descriptors.values()].map((descriptor) => [
      canonicalPortalUrl(descriptor.officialUrl),
      descriptor,
    ]),
  );
  const consumedArtifactIds = new Set<string>();

  for (const [parentExternalId, artifactUrls] of linkedArtifacts) {
    const parent = descriptors.get(parentExternalId);
    if (!parent) continue;

    const linkedIds = new Set(parent.linkedArtifactExternalIds ?? []);
    const filesByUrl = new Map(parent.files.map((file) => [file.url, file]));

    for (const artifactUrl of artifactUrls) {
      const artifact = descriptorByUrl.get(artifactUrl);
      if (!artifact) continue;
      const sameFamily =
        artifact.documentFamily === parent.documentFamily ||
        (
          artifact.documentNumber !== undefined &&
          artifact.documentNumber === parent.documentNumber
        );
      if (!sameFamily) continue;

      linkedIds.add(artifact.externalId);
      consumedArtifactIds.add(artifact.externalId);
      for (const file of artifact.files) filesByUrl.set(file.url, file);
    }

    if (linkedIds.size > 0) parent.linkedArtifactExternalIds = [...linkedIds].sort();
    parent.files = [...filesByUrl.values()];
  }

  return [...descriptors.values()].filter(
    (descriptor) => !consumedArtifactIds.has(descriptor.externalId),
  );
}

async function crawlModule(
  definition: SpedModuleDefinition,
  client: SpedClient,
  context: ConnectorExecutionContext,
  state: SpedSourceState,
  nextPages: Record<string, SpedKnownPage>,
  nowIso: string,
  maxPagesPerModule: number,
  maxCrawlDepth: number,
): Promise<ModuleCrawlResult> {
  const queue: CrawlPage[] = definition.seeds.map((seed) => ({
    url: seed.url,
    depth: 0,
    seedKind: seed.kind,
  }));
  const seen = new Set<string>();
  const candidates = new Map<string, KnownDocumentCandidate>();
  const descriptors = new Map<string, SpedDocumentDescriptor>();
  const linkedArtifacts = new Map<string, Set<string>>();
  const failures: ConnectorPartialFailure[] = [];
  let pagesSucceeded = 0;
  let pagesFailed = 0;
  let seedSuccesses = 0;
  let skippedKnownDocuments = 0;

  while (queue.length && seen.size < maxPagesPerModule) {
    context.signal.throwIfAborted();
    const current = queue.shift()!;
    const requestedUrl = canonicalPortalUrl(current.url);
    const seenKey = (current.forceFetch ? 'F:' : 'N:') + requestedUrl + ':' + (current.parentExternalId ?? '');
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const known = routeFor(state, requestedUrl);
    if (!current.forceFetch && known?.kind === 'DOCUMENT') {
      candidates.set(known.canonicalUrl, {
        module: definition.module,
        url: known.canonicalUrl,
        checkedAt: known.checkedAt,
      });
      skippedKnownDocuments += 1;
      continue;
    }

    try {
      const response = await client.getHtml(requestedUrl, context.signal);
      const finalUrl = canonicalPortalUrl(response.url);
      let kind = pageKindFromUrl(finalUrl);
      rememberPage(nextPages, requestedUrl, finalUrl, kind, definition.module, nowIso);

      const page = parseSpedPage(response.html, finalUrl);
      pagesSucceeded += 1;
      if (current.depth === 0) seedSuccesses += 1;

      const descriptor = descriptorFromPage(definition.module, page);
      if (
        descriptor &&
        kind === 'UNKNOWN' &&
        (
          descriptor.files.length > 0 ||
          descriptor.publishedAt !== undefined ||
          descriptor.updatedAt !== undefined ||
          descriptor.documentNumber !== undefined ||
          descriptor.officialVersion !== undefined
        )
      ) {
        kind = 'DOCUMENT';
        rememberPage(nextPages, requestedUrl, finalUrl, kind, definition.module, nowIso);
      }
      if (descriptor) {
        descriptors.set(descriptor.externalId, descriptor);

        if (current.parentExternalId) {
          const urls = linkedArtifacts.get(current.parentExternalId) ?? new Set<string>();
          urls.add(canonicalPortalUrl(descriptor.officialUrl));
          linkedArtifacts.set(current.parentExternalId, urls);
        }

        const artifactUrls = page.links
          .filter((link) => isArtifactPage(link.url))
          .map((link) => canonicalPortalUrl(link.url));

        if (artifactUrls.length > 0) {
          const urls = linkedArtifacts.get(descriptor.externalId) ?? new Set<string>();
          for (const artifactUrl of artifactUrls) urls.add(artifactUrl);
          linkedArtifacts.set(descriptor.externalId, urls);

          for (const artifactUrl of artifactUrls) {
            queue.push({
              url: artifactUrl,
              depth: current.depth + 1,
              seedKind: current.seedKind,
              forceFetch: true,
              parentExternalId: descriptor.externalId,
            });
          }
        }
      }

      if (kind === 'DOCUMENT') continue;
      if (current.depth >= maxCrawlDepth) continue;

      for (const link of page.links) {
        if (!shouldFollowLink(definition.module, current.seedKind, link.text, link.url)) continue;
        queue.push({
          url: canonicalPortalUrl(link.url),
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
        itemReference: requestedUrl,
      });
    }
  }

  return {
    module: definition.module,
    descriptors,
    linkedArtifacts,
    candidates: [...candidates.values()],
    pagesSucceeded,
    pagesFailed,
    pagesVisited: seen.size,
    skippedKnownDocuments,
    seedSuccesses,
    failures,
  };
}

async function recheckDocument(
  candidate: KnownDocumentCandidate,
  client: SpedClient,
  context: ConnectorExecutionContext,
  nextPages: Record<string, SpedKnownPage>,
  nowIso: string,
): Promise<{
  descriptors: Map<string, SpedDocumentDescriptor>;
  linkedArtifacts: Map<string, Set<string>>;
  pagesSucceeded: number;
  pagesFailed: number;
  failures: ConnectorPartialFailure[];
}> {
  const descriptors = new Map<string, SpedDocumentDescriptor>();
  const linkedArtifacts = new Map<string, Set<string>>();
  const failures: ConnectorPartialFailure[] = [];
  const queue: CrawlPage[] = [{
    url: candidate.url,
    depth: 0,
    seedKind: 'CATEGORY',
    forceFetch: true,
  }];
  const seen = new Set<string>();
  let pagesSucceeded = 0;
  let pagesFailed = 0;

  while (queue.length) {
    context.signal.throwIfAborted();
    const current = queue.shift()!;
    const requestedUrl = canonicalPortalUrl(current.url);
    if (seen.has(requestedUrl)) continue;
    seen.add(requestedUrl);

    try {
      const response = await client.getHtml(requestedUrl, context.signal);
      const finalUrl = canonicalPortalUrl(response.url);
      const kind = pageKindFromUrl(finalUrl);
      rememberPage(nextPages, requestedUrl, finalUrl, kind, candidate.module, nowIso);
      const page = parseSpedPage(response.html, finalUrl);
      pagesSucceeded += 1;

      const descriptor = descriptorFromPage(candidate.module, page);
      if (!descriptor) continue;
      descriptors.set(descriptor.externalId, descriptor);

      if (current.parentExternalId) {
        const urls = linkedArtifacts.get(current.parentExternalId) ?? new Set<string>();
        urls.add(canonicalPortalUrl(descriptor.officialUrl));
        linkedArtifacts.set(current.parentExternalId, urls);
      }

      for (const link of page.links.filter((link) => isArtifactPage(link.url))) {
        const artifactUrl = canonicalPortalUrl(link.url);
        const urls = linkedArtifacts.get(descriptor.externalId) ?? new Set<string>();
        urls.add(artifactUrl);
        linkedArtifacts.set(descriptor.externalId, urls);
        queue.push({
          url: artifactUrl,
          depth: current.depth + 1,
          seedKind: 'CATEGORY',
          forceFetch: true,
          parentExternalId: descriptor.externalId,
        });
      }
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
      pagesFailed += 1;
      const failure = failureInfo(error);
      failures.push({
        code: failure.code,
        message: failure.message,
        itemReference: requestedUrl,
      });
    }
  }

  return { descriptors, linkedArtifacts, pagesSucceeded, pagesFailed, failures };
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
      ...(descriptor.linkedArtifactExternalIds
        ? { linkedArtifactExternalIds: descriptor.linkedArtifactExternalIds }
        : {}),
      fileCount: files.length,
    },
  };
}

export class SpedConnector implements CollectionConnector {
  readonly key = SPED_CONNECTOR_KEY;
  readonly version = '0.2.0';
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
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(name + ' must be an integer >= ' + minimum);
      }
    }
    this.#options = options;
  }

  async collect(context: ConnectorExecutionContext): Promise<ConnectorResult> {
    const now = this.#options.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const state = await this.#options.readState?.(context.sourceId) ?? { items: {}, pages: {} };
    const revisitAfterMs = this.#options.revisitAfterMs ?? DEFAULT_REVISIT_AFTER_MS;
    const maxRechecksPerRun = this.#options.maxRechecksPerRun ?? DEFAULT_MAX_RECHECKS_PER_RUN;
    const maxPagesPerModule = this.#options.maxPagesPerModule ?? DEFAULT_MAX_PAGES_PER_MODULE;
    const maxCrawlDepth = this.#options.maxCrawlDepth ?? DEFAULT_MAX_CRAWL_DEPTH;
    const nextPages: Record<string, SpedKnownPage> = { ...state.pages };

    const client = new SpedClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.client ?? {}),
    });

    const partialFailures: ConnectorPartialFailure[] = [];
    const crawlResults: ModuleCrawlResult[] = [];

    try {
      for (const definition of SPED_MODULES) {
        context.signal.throwIfAborted();
        const result = await crawlModule(
          definition,
          client,
          context,
          state,
          nextPages,
          nowIso,
          maxPagesPerModule,
          maxCrawlDepth,
        );
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

      const nowMs = now.getTime();
      const candidateMap = new Map<string, KnownDocumentCandidate>();
      for (const result of crawlResults) {
        for (const candidate of result.candidates) {
          const existing = candidateMap.get(candidate.url);
          if (!existing || Date.parse(candidate.checkedAt) < Date.parse(existing.checkedAt)) {
            candidateMap.set(candidate.url, candidate);
          }
        }
      }

      const selectedRechecks = [...candidateMap.values()]
        .filter((candidate) => {
          const checkedAt = Date.parse(candidate.checkedAt);
          return !Number.isFinite(checkedAt) || nowMs - checkedAt >= revisitAfterMs;
        })
        .sort((left, right) =>
          (Date.parse(left.checkedAt) || 0) - (Date.parse(right.checkedAt) || 0)
          || left.url.localeCompare(right.url),
        )
        .slice(0, maxRechecksPerRun);

      let recheckedKnownDocumentCount = 0;
      let recheckPagesSucceeded = 0;
      let recheckPagesFailed = 0;

      for (const candidate of selectedRechecks) {
        const result = await recheckDocument(candidate, client, context, nextPages, nowIso);
        recheckedKnownDocumentCount += 1;
        recheckPagesSucceeded += result.pagesSucceeded;
        recheckPagesFailed += result.pagesFailed;
        partialFailures.push(...result.failures);

        const moduleResult = crawlResults.find((item) => item.module === candidate.module);
        if (!moduleResult) continue;

        for (const [key, descriptor] of result.descriptors) {
          moduleResult.descriptors.set(key, descriptor);
        }
        for (const [parent, urls] of result.linkedArtifacts) {
          const existing = moduleResult.linkedArtifacts.get(parent) ?? new Set<string>();
          for (const url of urls) existing.add(url);
          moduleResult.linkedArtifacts.set(parent, existing);
        }
      }

      const descriptors = crawlResults.flatMap((result) =>
        mergeLinkedArtifacts(result.descriptors, result.linkedArtifacts),
      );
      const files = descriptorFiles(descriptors);
      const nextItems: Record<string, SpedStoredFile> = { ...state.items };
      const resolvedFiles = new Map<string, ConnectorFile>();

      let downloadedCount = 0;
      let notModifiedCount = 0;
      let existingFileRecheckCount = 0;
      let newFileDownloadCount = 0;

      for (const file of files) {
        context.signal.throwIfAborted();
        const key = stateKey(file);
        const previous = state.items[key];
        if (previous) existingFileRecheckCount += 1;
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
              checkedAt: nowIso,
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          } else {
            downloadedCount += 1;
            stored = {
              rawSha256: response.rawSha256,
              sizeBytes: response.sizeBytes,
              mimeType: response.mimeType,
              checkedAt: nowIso,
              ...(response.filename ? { filename: response.filename } : {}),
              ...(response.sourceEtag ? { sourceEtag: response.sourceEtag } : {}),
              ...(response.sourceLastModified ? { sourceLastModified: response.sourceLastModified } : {}),
            };
          }

          nextItems[key] = stored;
          resolvedFiles.set(key, connectorFile(file, stored));
        } catch (error) {
          if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
          if (previous) resolvedFiles.set(key, connectorFile(file, previous));
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
        const currentFiles = descriptor.files
          .map((file) => resolvedFiles.get(stateKey({
            module: descriptor.module,
            publicationExternalId: descriptor.externalId,
            url: file.url,
            externalId: file.externalId,
            ...(file.name ? { name: file.name } : {}),
          })))
          .filter((file): file is ConnectorFile => file !== undefined);

        if (descriptor.files.length > 0 && currentFiles.length === 0) continue;
        publications.push(publicationFor(descriptor, currentFiles));
      }

      const skippedKnownDocumentCount = crawlResults.reduce(
        (sum, result) => sum + result.skippedKnownDocuments,
        0,
      );

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
              processedDocumentCount: result.descriptors.size,
              skippedKnownDocuments: result.skippedKnownDocuments,
              knownDocumentCandidates: result.candidates.length,
            })),
            processedDocumentCount: descriptors.length,
            publicationCount: publications.length,
            processedFileCount: files.length,
            downloadedCount,
            notModifiedCount,
            existingFileRecheckCount,
            newFileDownloadCount,
            skippedKnownDocumentCount,
            reusedCheckpointCount: skippedKnownDocumentCount,
            recheckedKnownDocumentCount,
            recheckPagesSucceeded,
            recheckPagesFailed,
            knownDocumentCandidateCount: candidateMap.size,
            knownPageCount: Object.keys(nextPages).length,
            revisitAfterMs,
            maxRechecksPerRun,
            maxPagesPerModule,
            maxCrawlDepth,
            partialFailureCount: partialFailures.length,
            scope: ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE'],
          },
          spedState: {
            items: nextItems,
            pages: nextPages,
          },
        },
      };
    } finally {
      client.close();
    }
  }
}
