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
  SPED_GOVBR_BASE_URL,
  SPED_GOVBR_ORIGIN,
  SPED_LEGACY_ORIGIN,
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
export type SpedPortalMode = 'GOVBR' | 'LEGACY';
const GOVBR_ROOT = SPED_GOVBR_BASE_URL.replace(/\/$/, '');
const DEFAULT_REVISIT_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECHECKS_PER_RUN = 16;
const DEFAULT_MAX_PAGES_PER_MODULE = 600;
const DEFAULT_MAX_CRAWL_DEPTH = 5;

export type SpedSeedKind = 'MODULE' | 'CATEGORY' | 'MODULE_HIGHLIGHTS' | 'GLOBAL_HIGHLIGHTS';

interface SpedModuleSeed {
  url: string;
  kind: SpedSeedKind;
}

export interface SpedModuleDefinition {
  module: SpedModule;
  seeds: SpedModuleSeed[];
}

export const LEGACY_SPED_MODULES: ReadonlyArray<SpedModuleDefinition> = [
  {
    module: 'EFD_ICMS_IPI',
    seeds: [
      { url: SPED_LEGACY_ORIGIN + '/projeto/show/274', kind: 'MODULE' },
      { url: SPED_LEGACY_ORIGIN + '/item/show/1573', kind: 'CATEGORY' },
      { url: SPED_LEGACY_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_CONTRIBUICOES',
    seeds: [
      { url: SPED_LEGACY_ORIGIN + '/projeto/show/268', kind: 'MODULE' },
      { url: SPED_LEGACY_ORIGIN + '/item/show/1545', kind: 'CATEGORY' },
      { url: SPED_LEGACY_ORIGIN + '/destaques/show/285', kind: 'MODULE_HIGHLIGHTS' },
      { url: SPED_LEGACY_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_REINF',
    seeds: [
      { url: SPED_LEGACY_ORIGIN + '/projeto/show/1196', kind: 'MODULE' },
      { url: SPED_LEGACY_ORIGIN + '/destaques/show/1199', kind: 'MODULE_HIGHLIGHTS' },
      { url: SPED_LEGACY_ORIGIN + '/item/show/2270', kind: 'CATEGORY' },
    ],
  },
  {
    module: 'DERE',
    seeds: [
      { url: SPED_LEGACY_ORIGIN + '/projeto/show/2918', kind: 'MODULE' },
      { url: SPED_LEGACY_ORIGIN + '/destaques/show/7', kind: 'GLOBAL_HIGHLIGHTS' },
    ],
  },
] as const;

export const SPED_MODULES: ReadonlyArray<SpedModuleDefinition> = [
  {
    module: 'EFD_ICMS_IPI',
    seeds: [
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-icms-ipi', kind: 'MODULE' },
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos', kind: 'CATEGORY' },
      { url: GOVBR_ROOT + '/assuntos/comunicados/efd-icms-ipi', kind: 'MODULE_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_CONTRIBUICOES',
    seeds: [
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-contribuicoes', kind: 'MODULE' },
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos', kind: 'CATEGORY' },
      { url: GOVBR_ROOT + '/assuntos/comunicados/efd-contribuicoes', kind: 'MODULE_HIGHLIGHTS' },
    ],
  },
  {
    module: 'EFD_REINF',
    seeds: [
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-reinf', kind: 'MODULE' },
      { url: GOVBR_ROOT + '/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos', kind: 'CATEGORY' },
      { url: GOVBR_ROOT + '/assuntos/comunicados/efd-reinf', kind: 'MODULE_HIGHLIGHTS' },
    ],
  },
  {
    module: 'DERE',
    seeds: [
      { url: GOVBR_ROOT + '/assuntos/documentos-fiscais/dere', kind: 'MODULE' },
      { url: GOVBR_ROOT + '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1', kind: 'CATEGORY' },
      { url: GOVBR_ROOT + '/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versoes-anteriores', kind: 'CATEGORY' },
      { url: GOVBR_ROOT + '/assuntos/comunicados/dere', kind: 'MODULE_HIGHLIGHTS' },
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

export type SpedPageKind = 'CONTAINER' | 'DOCUMENT' | 'MISSING' | 'UNKNOWN';

export interface SpedKnownPage {
  canonicalUrl: string;
  kind: SpedPageKind;
  module: SpedModule;
  checkedAt: string;
}

/**
 * Identity already emitted for an origin (publication externalId).
 * Used to keep identity assignments stable across incremental runs and to
 * resolve identity collisions deterministically.
 */
export interface SpedIdentityRecord {
  key: string;
  baseKey: string;
  officialUrl: string;
  title: string;
  /** Canonical content emitted for this origin (omitted when very large). */
  content?: string;
  fileSha256s: string[];
  /**
   * Where the variable token of `baseKey` came from: the title-derived family
   * or an official document number. Only TITLE identities may be kept across
   * a reworded title. Absent in records written before this field existed.
   */
  familySource?: 'TITLE' | 'NUMBER';
}

/**
 * 3: folder pages are CONTAINERs (v2 checkpoints could mark a gov.br folder as
 * a known DOCUMENT and hide its children, e.g. the EFD-Reinf XSD packages).
 */
export const SPED_STATE_VERSION = 3;

/** Max deferred documents listed in attempt metadata (the count is always exact). */
export const SPED_DEFERRED_SAMPLE_SIZE = 50;

/**
 * Share of the available (soft) time budget that page discovery (crawl and
 * rechecks) may use. The rest is reserved for downloading the files of what
 * was discovered, so every yielded run still emits documents and the next run
 * makes progress instead of re-discovering the same pages forever.
 */
export const SPED_DISCOVERY_BUDGET_SHARE = 0.6;

/** Upper bound of crawl frontier entries carried in the checkpoint. */
export const SPED_MAX_FRONTIER = 5_000;

export const SPED_IDENTITY_VERSION = 'v2';
const MAX_STORED_IDENTITY_CONTENT = 4_000;

export interface SpedSourceState {
  /**
   * 2 = checkpoint semantics where only fully emitted documents are marked as
   * known. Older states are not trusted for incremental skipping.
   */
  version?: number;
  items: Record<string, SpedStoredFile>;
  pages: Record<string, SpedKnownPage>;
  identities?: Record<string, SpedIdentityRecord>;
  /**
   * Identity key each persisted origin (external id) is linked to, read from
   * publications.identity_basis, restricted to origins whose persisted
   * metadata proves a title-derived (never numbered) identity. Transient:
   * loaded with the checkpoint, never written back. Lets an origin whose
   * checkpoint identity was dropped (e.g. it failed in the last run) keep the
   * identity it already owns.
   */
  persistedTitleFamilyKeys?: Record<string, string>;
  /**
   * Present only while a discovery cycle is interrupted by the time budget:
   * the next run resumes from this frontier instead of restarting from the
   * seeds (so a slow portal cannot starve discovery). Cleared when a run
   * finishes without yielding.
   */
  cycle?: SpedCrawlCycle;
}

export interface SpedFrontierPage {
  module: SpedModule;
  url: string;
  depth: number;
  seedKind: SpedSeedKind;
  forceFetch?: boolean;
}

export interface SpedCrawlCycle {
  /** Modules whose crawl already finished in this cycle. */
  completedModules: SpedModule[];
  /** Pages still to visit (unvisited queue, deferred documents). */
  frontier: SpedFrontierPage[];
}

export interface SpedIdentityCollision {
  baseKey: string;
  resolvedKey: string;
  externalId: string;
  officialUrl: string;
  title: string;
  module: SpedModule;
  kind: SpedDocumentKind;
  carrier: string;
  documentFamily: string;
  documentNumber?: string;
  officialVersion?: string;
  revisionKind: string;
  collidedWith: Array<{ externalId: string; officialUrl: string; title?: string }>;
}

export interface SpedIdentityAudit {
  identityVersion: string;
  emittedPublicationCount: number;
  distinctIdentityKeyCount: number;
  mirrorGroups: Array<{ key: string; externalIds: string[] }>;
  collisionsResolved: SpedIdentityCollision[];
  unresolvedCollisions: number;
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
  portal?: SpedPortalMode;
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
  kind: 'DOCUMENT' | 'MISSING';
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
  skippedKnownMissingPages: number;
  missingHistoricalPages: number;
  seedSuccesses: number;
  failures: ConnectorPartialFailure[];
  /** true when the crawl stopped at a safe point because of the time budget. */
  yielded: boolean;
  /** Pages still queued when the crawl yielded. */
  pendingPages: number;
  /** The unvisited queue itself (for the next run's frontier). */
  remainingQueue: CrawlPage[];
  /**
   * Documents whose linked artifact pages were still queued when the crawl
   * yielded: their file set is incomplete, so they must be deferred.
   */
  incompleteExternalIds: Set<string>;
}

function isHistoricalMissing(error: unknown): error is ConnectorError {
  return (
    error instanceof ConnectorError &&
    error.kind === 'HTTP_ERROR' &&
    error.retryable === false &&
    (error.httpStatus === 404 || error.httpStatus === 410)
  );
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
  const parsed = new URL(value, SPED_GOVBR_BASE_URL);
  parsed.hash = '';
  return parsed.toString();
}

function pageKindFromUrl(url: string): SpedPageKind {
  try {
    const parsed = new URL(url, SPED_GOVBR_BASE_URL);
    const pathname = parsed.pathname;
    if (parsed.origin.toLowerCase() === SPED_LEGACY_ORIGIN) {
      if (/^\/(?:projeto|pasta)\/show\/\d+$/i.test(pathname)) return 'CONTAINER';
      if (/^\/destaques\/show\/\d+$/i.test(pathname)) return 'CONTAINER';
      if (/^\/(?:pagina|arquivo)\/show\/\d+$/i.test(pathname)) return 'DOCUMENT';
      return 'UNKNOWN';
    }
    if (parsed.origin.toLowerCase() === SPED_GOVBR_ORIGIN && pathname.startsWith('/sped/pt-br/')) {
      if (/\/@@(?:display-file|download)\/file$/i.test(pathname)) return 'UNKNOWN';
      return 'UNKNOWN';
    }
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function govModulePathAllowed(module: SpedModule, pathname: string): boolean {
  const paths: Record<SpedModule, string[]> = {
    EFD_ICMS_IPI: [
      '/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi',
      '/sped/pt-br/assuntos/comunicados/efd-icms-ipi',
    ],
    EFD_CONTRIBUICOES: [
      '/sped/pt-br/assuntos/escrituracoes-digitais/efd-contribuicoes',
      '/sped/pt-br/assuntos/comunicados/efd-contribuicoes',
    ],
    EFD_REINF: [
      '/sped/pt-br/assuntos/escrituracoes-digitais/efd-reinf',
      '/sped/pt-br/assuntos/comunicados/efd-reinf',
    ],
    DERE: [
      '/sped/pt-br/assuntos/documentos-fiscais/dere',
      '/sped/pt-br/assuntos/comunicados/dere',
    ],
  };
  return paths[module].some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function isGovBrSystemNavigation(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return segments.some((segment) => {
    if (/^@@(?:display-file|download)$/i.test(segment)) return false;
    return segment === 'object_copy' || segment.startsWith('@');
  });
}

function govBrNavigationLooksRelevant(module: SpedModule, text: string, url: string): boolean {
  let pathname = '';
  try {
    pathname = decodeURIComponent(new URL(url).pathname).toLocaleLowerCase('pt-BR');
  } catch {
    return false;
  }

  const leaf = pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (/^(?:faq|fale-conosco|contato|acesso-a-informacao|ouvidoria)$/i.test(leaf)) {
    return false;
  }

  if (isTechnicalNavigationText(text) || moduleTextMatches(module, text)) return true;

  return /(?:^|[-/])(?:manua(?:l|is)|document(?:o|os|acao)|tecnic(?:o|os|a|as)|nota(?:s)?|orienta|guia(?:s)?|leiaute(?:s)?|layout(?:s)?|xsd|schema|esquema(?:s)?|tabela(?:s)?|versao|versoes|histori(?:co|cos)|download(?:s)?|comunicado(?:s)?|programa(?:s)?|validador(?:es)?|pva|pge)(?:[-/]|$)/i.test(pathname);
}

function samePortalNavigation(module: SpedModule, url: string, portal: SpedPortalMode): boolean {
  try {
    const parsed = new URL(url);
    if (portal === 'GOVBR') {
      if (parsed.origin.toLowerCase() !== SPED_GOVBR_ORIGIN) return false;
      if (/\/@@(?:display-file|download)\/file$/i.test(parsed.pathname)) return false;
      if (isGovBrSystemNavigation(parsed.pathname)) return false;
      return govModulePathAllowed(module, parsed.pathname);
    }
    if (parsed.origin.toLowerCase() !== SPED_LEGACY_ORIGIN) return false;
    return /^\/(?:item|pasta|projeto|pagina)\/show\/\d+$/i.test(parsed.pathname)
      || /^\/arquivo\/show\/\d+$/i.test(parsed.pathname)
      || /^\/destaques\/show\/\d+$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isArtifactPage(url: string, portal: SpedPortalMode): boolean {
  if (portal !== 'LEGACY') return false;
  try {
    return /^\/arquivo\/show\/\d+$/i.test(new URL(url, SPED_LEGACY_ORIGIN).pathname);
  } catch {
    return false;
  }
}

function shouldFollowLink(
  module: SpedModule,
  seedKind: SpedModuleSeed['kind'],
  text: string,
  url: string,
  portal: SpedPortalMode,
): boolean {
  if (!samePortalNavigation(module, url, portal)) return false;
  if (portal === 'GOVBR') return govBrNavigationLooksRelevant(module, text, url);
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
  const resolved = new Set<string>();
  const resolving = new Set<string>();

  const sameDocumentFamily = (
    parent: SpedDocumentDescriptor,
    artifact: SpedDocumentDescriptor,
  ): boolean =>
    artifact.documentFamily === parent.documentFamily ||
    (
      artifact.documentNumber !== undefined &&
      artifact.documentNumber === parent.documentNumber
    );

  const resolveDescriptor = (externalId: string): SpedDocumentDescriptor | undefined => {
    const descriptor = descriptors.get(externalId);
    if (!descriptor) return undefined;
    if (resolved.has(externalId)) return descriptor;
    if (resolving.has(externalId)) return descriptor;

    resolving.add(externalId);

    const filesByUrl = new Map(descriptor.files.map((file) => [file.url, file]));
    const linkedIds = new Set(descriptor.linkedArtifactExternalIds ?? []);

    for (const artifactUrl of linkedArtifacts.get(externalId) ?? []) {
      const artifact = descriptorByUrl.get(artifactUrl);
      if (!artifact || artifact.externalId === externalId) continue;
      if (!sameDocumentFamily(descriptor, artifact)) continue;

      const child = resolveDescriptor(artifact.externalId) ?? artifact;
      consumedArtifactIds.add(artifact.externalId);
      linkedIds.add(artifact.externalId);

      for (const linkedId of child.linkedArtifactExternalIds ?? []) {
        linkedIds.add(linkedId);
      }
      for (const file of child.files) {
        filesByUrl.set(file.url, file);
      }
    }

    descriptor.files = [...filesByUrl.values()];
    if (linkedIds.size > 0) {
      descriptor.linkedArtifactExternalIds = [...linkedIds].sort();
    }

    resolving.delete(externalId);
    resolved.add(externalId);
    return descriptor;
  };

  for (const externalId of descriptors.keys()) {
    resolveDescriptor(externalId);
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
  portal: SpedPortalMode,
  shouldYield: () => boolean = () => false,
  initialQueue?: CrawlPage[],
): Promise<ModuleCrawlResult> {
  // A resumed cycle starts from its frontier instead of the seeds.
  const queue: CrawlPage[] = initialQueue
    ? initialQueue.map((page) => ({ ...page }))
    : definition.seeds.map((seed) => ({
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
  let skippedKnownMissingPages = 0;
  let missingHistoricalPages = 0;
  let yielded = false;

  while (queue.length && seen.size < maxPagesPerModule) {
    context.signal.throwIfAborted();
    const current = queue.shift()!;
    const requestedUrl = canonicalPortalUrl(current.url);
    const seenKey = (current.forceFetch ? 'F:' : 'N:') + requestedUrl + ':' + (current.parentExternalId ?? '');
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    const known = routeFor(state, requestedUrl);
    if (
      !current.forceFetch &&
      (known?.kind === 'DOCUMENT' || known?.kind === 'MISSING')
    ) {
      candidates.set(known.canonicalUrl, {
        module: definition.module,
        url: known.canonicalUrl,
        checkedAt: known.checkedAt,
        kind: known.kind,
      });
      if (known.kind === 'MISSING') skippedKnownMissingPages += 1;
      else skippedKnownDocuments += 1;
      continue;
    }

    // Safe point: stop before starting a new network request once the time
    // budget asks us to yield. The page goes back to the queue (not visited).
    if (shouldYield()) {
      seen.delete(seenKey);
      queue.unshift(current);
      yielded = true;
      break;
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
        !page.folderish &&
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
      if (page.folderish) {
        // A folder is never skipped by the checkpoint and its children are
        // always followed, even when the folder itself yields a descriptor.
        kind = 'CONTAINER';
        rememberPage(nextPages, requestedUrl, finalUrl, kind, definition.module, nowIso);
      }
      if (descriptor) {
        descriptors.set(descriptor.externalId, descriptor);

        if (current.parentExternalId) {
          const urls = linkedArtifacts.get(current.parentExternalId) ?? new Set<string>();
          urls.add(canonicalPortalUrl(descriptor.officialUrl));
          linkedArtifacts.set(current.parentExternalId, urls);
        }

        const currentDocumentUrl = canonicalPortalUrl(descriptor.officialUrl);
        const artifactUrls = page.links
          .filter((link) => isArtifactPage(link.url, portal))
          .map((link) => canonicalPortalUrl(link.url))
          .filter((artifactUrl) => artifactUrl !== currentDocumentUrl);

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
        if (!shouldFollowLink(definition.module, current.seedKind, link.text, link.url, portal)) continue;
        queue.push({
          url: canonicalPortalUrl(link.url),
          depth: current.depth + 1,
          seedKind: current.seedKind === 'GLOBAL_HIGHLIGHTS' ? 'GLOBAL_HIGHLIGHTS' : 'CATEGORY',
        });
      }
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'CANCELLED') throw error;
      if (
        current.depth > 0 &&
        error instanceof ConnectorError &&
        error.code === 'SPED_CROSS_ORIGIN_REDIRECT'
      ) {
        continue;
      }
      if (current.depth > 0 && isHistoricalMissing(error)) {
        rememberPage(
          nextPages,
          requestedUrl,
          requestedUrl,
          'MISSING',
          definition.module,
          nowIso,
        );
        missingHistoricalPages += 1;
        continue;
      }
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
    skippedKnownMissingPages,
    missingHistoricalPages,
    seedSuccesses,
    failures,
    yielded,
    pendingPages: yielded ? queue.length : 0,
    remainingQueue: yielded ? queue : [],
    incompleteExternalIds: new Set(
      yielded
        ? queue
            .map((page) => page.parentExternalId)
            .filter((value): value is string => typeof value === 'string')
        : [],
    ),
  };
}

async function recheckDocument(
  candidate: KnownDocumentCandidate,
  client: SpedClient,
  context: ConnectorExecutionContext,
  nextPages: Record<string, SpedKnownPage>,
  nowIso: string,
  portal: SpedPortalMode,
): Promise<{
  descriptors: Map<string, SpedDocumentDescriptor>;
  linkedArtifacts: Map<string, Set<string>>;
  pagesSucceeded: number;
  pagesFailed: number;
  tombstonesConfirmed: number;
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
  let tombstonesConfirmed = 0;

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

      const currentDocumentUrl = canonicalPortalUrl(descriptor.officialUrl);
      for (const link of page.links.filter((link) => isArtifactPage(link.url, portal))) {
        const artifactUrl = canonicalPortalUrl(link.url);
        if (artifactUrl === currentDocumentUrl) continue;
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
      if (isHistoricalMissing(error)) {
        rememberPage(
          nextPages,
          requestedUrl,
          requestedUrl,
          'MISSING',
          candidate.module,
          nowIso,
        );
        tombstonesConfirmed += 1;
        continue;
      }
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
    descriptors,
    linkedArtifacts,
    pagesSucceeded,
    pagesFailed,
    tombstonesConfirmed,
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

function normalizedIdentityToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleUpperCase('pt-BR');
}

/**
 * Semantic identity of a SPED document (identity v2).
 *
 * - carrier separates an announcement ("comunicado") from the document itself;
 * - number/version/revision discriminate official editions;
 * - when a document has neither number nor version, the family is title-derived
 *   and therefore weak: the stable portal path is appended as a safe canonical
 *   fallback (e.g. "Esquemas XSD" under versao-atual vs historico).
 *
 * Numbered/versioned documents keep a portal-independent key, so gov.br and
 * legacy mirrors of the same edition still correlate.
 */
export function spedBaseIdentityKey(descriptor: SpedDocumentDescriptor): string {
  const family = descriptor.documentNumber ?? descriptor.documentFamily;
  const weak = descriptor.documentNumber === undefined && descriptor.officialVersion === undefined;
  return [
    'SPED',
    SPED_IDENTITY_VERSION,
    descriptor.module,
    descriptor.carrier,
    descriptor.kind,
    normalizedIdentityToken(family),
    descriptor.officialVersion ?? '',
    descriptor.revisionKind,
    ...(weak ? ['PATH:' + descriptor.canonicalPath] : []),
  ].join('|');
}

/**
 * True when `storedBaseKey` was built for the same document as `candidate`
 * and only the title-derived family token differs. Documents identified by an
 * official number never qualify: their family does not come from the title.
 * The key string alone cannot tell whether the stored token was a family or a
 * number, so the stored identity must carry that proof: `familySource` is
 * 'TITLE' only for identities built without an official document number
 * (checkpoint records, or persisted origins whose metadata proves it). A
 * numbered or unproven stored identity never qualifies.
 */
export function sameIdentityExceptTitleFamily(
  stored: { baseKey: string; familySource?: 'TITLE' | 'NUMBER' },
  candidate: { descriptor: SpedDocumentDescriptor; baseKey: string },
): boolean {
  if (stored.familySource !== 'TITLE') return false;
  const storedBaseKey = stored.baseKey;
  const descriptor = candidate.descriptor;
  if (descriptor.documentNumber !== undefined) return false;
  const weak = descriptor.officialVersion === undefined;
  const prefix = [
    'SPED',
    SPED_IDENTITY_VERSION,
    descriptor.module,
    descriptor.carrier,
    descriptor.kind,
  ].join('|') + '|';
  const suffix = '|' + [
    descriptor.officialVersion ?? '',
    descriptor.revisionKind,
    ...(weak ? ['PATH:' + descriptor.canonicalPath] : []),
  ].join('|');
  if (
    storedBaseKey === candidate.baseKey ||
    !storedBaseKey.startsWith(prefix) ||
    !storedBaseKey.endsWith(suffix) ||
    storedBaseKey.length <= prefix.length + suffix.length
  ) return false;
  // Exactly one differing token (the family); never a key with extra segments.
  return !storedBaseKey.slice(prefix.length, storedBaseKey.length - suffix.length).includes('|');
}

function collisionKey(baseKey: string, descriptor: SpedDocumentDescriptor): string {
  return baseKey.includes('|PATH:') ? baseKey : baseKey + '|PATH:' + descriptor.canonicalPath;
}

function sameFileSet(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((value, index) => value === right[index]);
}

interface IdentityCandidate {
  descriptor: SpedDocumentDescriptor;
  files: ConnectorFile[];
  baseKey: string;
  fileSha256s: string[];
}

interface IdentityResolution {
  keys: Map<string, string>;
  canonical: Map<string, { title: string; content?: string }>;
  identities: Record<string, SpedIdentityRecord>;
  audit: SpedIdentityAudit;
}

/**
 * Deterministic identity resolution for one run.
 *
 * Invariant: two different official documents never share an identity key.
 * The only accepted sharing is a proven mirror: the same non-empty set of file
 * SHA-256 digests published at more than one official location. Mirrors emit
 * one canonical title/content so they never alternate publication_versions.
 */
function resolveIdentities(
  candidates: IdentityCandidate[],
  previous: Record<string, SpedIdentityRecord>,
  persistedTitleFamily: Record<string, string> = {},
): IdentityResolution {
  const keys = new Map<string, string>();
  const identities: Record<string, SpedIdentityRecord> = { ...previous };
  const collisions: SpedIdentityCollision[] = [];
  const runIds = new Set(candidates.map((candidate) => candidate.descriptor.externalId));

  const occupants = (key: string): Array<{ externalId: string; fileSha256s: string[]; officialUrl: string; title: string }> => {
    const found = new Map<string, { externalId: string; fileSha256s: string[]; officialUrl: string; title: string }>();
    for (const [externalId, record] of Object.entries(identities)) {
      if (record.key === key && (!runIds.has(externalId) || keys.has(externalId))) {
        found.set(externalId, { externalId, fileSha256s: record.fileSha256s, officialUrl: record.officialUrl, title: record.title });
      }
    }
    for (const candidate of candidates) {
      if (keys.get(candidate.descriptor.externalId) === key) {
        found.set(candidate.descriptor.externalId, {
          externalId: candidate.descriptor.externalId,
          fileSha256s: candidate.fileSha256s,
          officialUrl: candidate.descriptor.officialUrl,
          title: candidate.descriptor.title,
        });
      }
    }
    return [...found.values()];
  };

  const ordered = [...candidates].sort((left, right) =>
    left.baseKey.localeCompare(right.baseKey) ||
    left.descriptor.officialUrl.localeCompare(right.descriptor.officialUrl),
  );

  // 1. Origins that already own an identity keep it when the base key is the
  // same, or differs only in the title-derived family (the portal reworded
  // the title of the same file, e.g. "(v.1.2.0)" -> "(v.1.2.0 PRODUÇÃO)").
  // Module, carrier, kind, version, revision and fallback path must match,
  // so a new edition still gets a new identity; the reworded title becomes
  // a new version of the same publication. The title rule only applies to a
  // stored identity proven title-derived: a numbered identity is never
  // reused by an unnumbered candidate.
  // When the checkpoint holds no such identity (it is dropped for items that
  // failed in the last run), the identity already persisted for that origin
  // is the reference, when its persisted metadata proves it title-derived:
  // persistence accepts no other key for that origin.
  for (const candidate of ordered) {
    const externalId = candidate.descriptor.externalId;
    const stored = previous[externalId];
    const persistedKey = persistedTitleFamily[externalId];
    if (stored && stored.baseKey === candidate.baseKey) {
      keys.set(externalId, stored.key);
    } else if (stored && sameIdentityExceptTitleFamily(stored, candidate)) {
      keys.set(externalId, stored.key);
    } else if (
      persistedKey &&
      // Proven title-derived by readPersistedTitleFamilyKeys.
      sameIdentityExceptTitleFamily({ baseKey: persistedKey, familySource: 'TITLE' }, candidate)
    ) {
      keys.set(externalId, persistedKey);
    }
  }

  // 2. New origins: take the base key unless it belongs to a different document.
  for (const candidate of ordered) {
    const externalId = candidate.descriptor.externalId;
    if (keys.has(externalId)) continue;
    const current = occupants(candidate.baseKey).filter((item) => item.externalId !== externalId);
    const conflicting = current.filter((item) => !sameFileSet(item.fileSha256s, candidate.fileSha256s));
    if (current.length === 0 || conflicting.length === 0) {
      keys.set(externalId, candidate.baseKey);
      continue;
    }
    const resolvedKey = collisionKey(candidate.baseKey, candidate.descriptor);
    const stillTaken = occupants(resolvedKey).some((item) => item.externalId !== externalId);
    keys.set(externalId, stillTaken ? resolvedKey + '|ID:' + externalId : resolvedKey);
    collisions.push({
      baseKey: candidate.baseKey,
      resolvedKey: keys.get(externalId)!,
      externalId,
      officialUrl: candidate.descriptor.officialUrl,
      title: candidate.descriptor.title,
      module: candidate.descriptor.module,
      kind: candidate.descriptor.kind,
      carrier: candidate.descriptor.carrier,
      documentFamily: candidate.descriptor.documentFamily,
      ...(candidate.descriptor.documentNumber ? { documentNumber: candidate.descriptor.documentNumber } : {}),
      ...(candidate.descriptor.officialVersion ? { officialVersion: candidate.descriptor.officialVersion } : {}),
      revisionKind: candidate.descriptor.revisionKind,
      collidedWith: conflicting.map((item) => ({
        externalId: item.externalId,
        officialUrl: item.officialUrl,
        title: item.title,
      })),
    });
  }

  // 3. Canonical representation for mirror groups (same key, several origins).
  const canonical = new Map<string, { title: string; content?: string }>();
  const byKey = new Map<string, IdentityCandidate[]>();
  for (const candidate of candidates) {
    const key = keys.get(candidate.descriptor.externalId)!;
    byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }
  const mirrorGroups: Array<{ key: string; externalIds: string[] }> = [];
  for (const [key, members] of byKey) {
    const owners = Object.entries(previous)
      .filter(([externalId, record]) => record.key === key && !runIds.has(externalId))
      .map(([, record]) => record);
    if (members.length + owners.length < 2) continue;
    mirrorGroups.push({
      key,
      externalIds: [
        ...members.map((member) => member.descriptor.externalId),
        ...Object.entries(previous)
          .filter(([externalId, record]) => record.key === key && !runIds.has(externalId))
          .map(([externalId]) => externalId),
      ].sort(),
    });
    // Representative = smallest official URL among all known origins. Stored
    // owners are only eligible when their canonical content was retained, so
    // a representative absent from this run is reproduced exactly.
    const options = [
      ...members.map((member) => ({
        officialUrl: member.descriptor.officialUrl,
        title: member.descriptor.title,
        ...(member.descriptor.description !== undefined ? { content: member.descriptor.description } : {}),
      })),
      ...owners
        .filter((owner) => owner.content !== undefined)
        .map((owner) => ({
          officialUrl: owner.officialUrl,
          title: owner.title,
          content: owner.content!,
        })),
    ].sort((left, right) => left.officialUrl.localeCompare(right.officialUrl));
    const representative = options[0]!;
    for (const member of members) {
      canonical.set(member.descriptor.externalId, {
        title: representative.title,
        ...(representative.content !== undefined ? { content: representative.content } : {}),
      });
    }
  }

  for (const candidate of candidates) {
    const externalId = candidate.descriptor.externalId;
    identities[externalId] = {
      key: keys.get(externalId)!,
      baseKey: candidate.baseKey,
      officialUrl: candidate.descriptor.officialUrl,
      title: candidate.descriptor.title,
      ...(candidate.descriptor.description !== undefined &&
      candidate.descriptor.description.length <= MAX_STORED_IDENTITY_CONTENT
        ? { content: candidate.descriptor.description }
        : {}),
      fileSha256s: candidate.fileSha256s,
      familySource: candidate.descriptor.documentNumber === undefined ? 'TITLE' : 'NUMBER',
    };
  }

  // Final invariant check over this run's emissions.
  let unresolvedCollisions = 0;
  const seen = new Map<string, IdentityCandidate>();
  for (const candidate of candidates) {
    const key = keys.get(candidate.descriptor.externalId)!;
    const other = seen.get(key);
    if (other && !sameFileSet(other.fileSha256s, candidate.fileSha256s)) unresolvedCollisions += 1;
    if (!other) seen.set(key, candidate);
  }

  return {
    keys,
    canonical,
    identities,
    audit: {
      identityVersion: SPED_IDENTITY_VERSION,
      emittedPublicationCount: candidates.length,
      distinctIdentityKeyCount: new Set(keys.values()).size,
      mirrorGroups,
      collisionsResolved: collisions,
      unresolvedCollisions,
    },
  };
}

function publicationFor(
  descriptor: SpedDocumentDescriptor,
  files: ConnectorFile[],
  portal: SpedPortalMode,
  identityKey: string,
  canonical?: { title: string; content?: string },
): ConnectorPublication {
  const title = canonical?.title ?? descriptor.title;
  const content = canonical ? canonical.content : descriptor.description;
  const agency = descriptor.module === 'DERE' ? 'RFB/CGIBS' : 'SPED/RFB';
  return {
    title,
    agency,
    sphere: 'FEDERAL',
    actType: kindLabel(descriptor.kind),
    ...(descriptor.actNumber ? { actNumber: descriptor.actNumber } : {}),
    ...(descriptor.publishedAt ? { publishedAt: descriptor.publishedAt } : {}),
    ...(content ? { content } : {}),
    officialUrl: descriptor.officialUrl,
    externalId: descriptor.externalId,
    identityKey,
    ...(files.length ? { files } : {}),
    metadata: {
      module: descriptor.module,
      moduleLabel: moduleLabel(descriptor.module),
      documentKind: descriptor.kind,
      documentCarrier: descriptor.carrier,
      originTitle: descriptor.title,
      contentSource: descriptor.documentTextSource,
      identityVersion: SPED_IDENTITY_VERSION,
      documentFamily: descriptor.documentFamily,
      revisionKind: descriptor.revisionKind,
      republication: descriptor.republication,
      documentStatus: descriptor.documentStatus,
      itemId: descriptor.itemId,
      ...(descriptor.documentNumber ? { documentNumber: descriptor.documentNumber } : {}),
      ...(descriptor.officialVersion ? { officialVersion: descriptor.officialVersion } : {}),
      ...(descriptor.createdAt ? { sourceCreatedAt: descriptor.createdAt.toISOString().slice(0, 10) } : {}),
      ...(descriptor.updatedAt ? { updatedAt: descriptor.updatedAt.toISOString().slice(0, 10) } : {}),
      relatedTaxes: descriptor.relatedTaxes,
      affectedRecords: descriptor.affectedRecords,
      sourcePortal: portal,
      sourceRole: portal === 'GOVBR' ? 'PRIMARY' : 'ENRICHMENT',
      ...(descriptor.legacyReferences?.length
        ? { legacyReferences: descriptor.legacyReferences }
        : {}),
      ...(descriptor.linkedArtifactExternalIds
        ? { linkedArtifactExternalIds: descriptor.linkedArtifactExternalIds }
        : {}),
      fileCount: files.length,
    },
  };
}

export class SpedConnector implements CollectionConnector {
  readonly key = SPED_CONNECTOR_KEY;
  readonly version = '0.4.1';
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
    const portal = this.#options.portal ?? 'GOVBR';
    const definitions = portal === 'GOVBR' ? SPED_MODULES : LEGACY_SPED_MODULES;
    const nextPages: Record<string, SpedKnownPage> = { ...state.pages };

    const client = new SpedClient({
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(portal === 'GOVBR'
        ? { origin: SPED_GOVBR_ORIGIN, pathPrefix: '/sped/pt-br/' }
        : { origin: SPED_LEGACY_ORIGIN, pathPrefix: '/' }),
      ...(this.#options.client ?? {}),
    });

    const partialFailures: ConnectorPartialFailure[] = [];
    const crawlResults: ModuleCrawlResult[] = [];
    // Graceful time budget: once shouldYield() is true no new network work is
    // started; everything already obtained is returned consistently and the
    // checkpoint lets the next scheduled run continue.
    const budget = context.budget;
    const shouldYield = (): boolean => budget?.shouldYield() === true;
    // Discovery may only use SPED_DISCOVERY_BUDGET_SHARE of the soft window.
    const graceMs = budget ? budget.deadlineAt.getTime() - budget.softDeadlineAt.getTime() : 0;
    const softWindowMs = budget ? Math.max(0, budget.remainingMs() - graceMs) : 0;
    const discoveryReserveMs = softWindowMs * (1 - SPED_DISCOVERY_BUDGET_SHARE);
    const shouldYieldDiscovery = (): boolean =>
      shouldYield() ||
      (budget !== undefined && budget.remainingMs() - graceMs <= discoveryReserveMs);
    let yielded = false;
    let pendingModules = 0;

    // Resume an interrupted discovery cycle: finished modules are not crawled
    // again from their seeds; only their frontier (if any) is visited.
    const cycle = state.cycle;
    const resumed = cycle !== undefined;
    const completedModules = new Set<SpedModule>(cycle?.completedModules ?? []);
    const frontierByModule = new Map<SpedModule, CrawlPage[]>();
    for (const page of cycle?.frontier ?? []) {
      const pages = frontierByModule.get(page.module) ?? [];
      pages.push({
        url: page.url,
        depth: page.depth,
        seedKind: page.seedKind,
        ...(page.forceFetch ? { forceFetch: true } : {}),
      });
      frontierByModule.set(page.module, pages);
    }
    const finishedThisRun = new Set<SpedModule>();

    try {
      for (const [index, definition] of definitions.entries()) {
        context.signal.throwIfAborted();
        const frontier = frontierByModule.get(definition.module);
        if (completedModules.has(definition.module) && !frontier) continue;
        if (shouldYieldDiscovery()) {
          yielded = true;
          pendingModules = definitions
            .slice(index)
            .filter((item) => !completedModules.has(item.module) || frontierByModule.has(item.module))
            .length;
          break;
        }
        const result = await crawlModule(
          definition,
          client,
          context,
          state,
          nextPages,
          nowIso,
          maxPagesPerModule,
          maxCrawlDepth,
          portal,
          shouldYieldDiscovery,
          frontier,
        );
        crawlResults.push(result);
        partialFailures.push(...result.failures);
        if (!result.yielded) finishedThisRun.add(definition.module);
        if (result.yielded) {
          yielded = true;
          pendingModules = definitions.length - index - 1;
          break;
        }
      }

      const modulesSucceeded = crawlResults.filter((result) => result.seedSuccesses > 0).length;
      // Without a yield, no successful seed means the source is unavailable.
      // After a yield, modules may simply not have been reached yet: it is only
      // a failure if something was attempted and nothing succeeded.
      // A resumed cycle starts below the seeds, so seed successes are not
      // expected there either.
      const sourceUnavailable = yielded || resumed
        ? crawlResults.some((result) => result.pagesFailed > 0) &&
          !crawlResults.some((result) => result.pagesSucceeded > 0)
        : modulesSucceeded === 0;
      if (sourceUnavailable) {
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
      let recheckedMissingPageCount = 0;
      let recheckPagesSucceeded = 0;
      let recheckPagesFailed = 0;
      let recheckedTombstonesConfirmed = 0;
      let pendingRechecks = 0;

      for (const [index, candidate] of selectedRechecks.entries()) {
        // Rechecks not done now keep their old checkedAt and are the first to
        // be selected next run (oldest first). A recheck is never cut halfway.
        if (yielded || shouldYieldDiscovery()) {
          yielded = true;
          pendingRechecks = selectedRechecks.length - index;
          break;
        }
        const result = await recheckDocument(candidate, client, context, nextPages, nowIso, portal);
        if (candidate.kind === 'MISSING') recheckedMissingPageCount += 1;
        else recheckedKnownDocumentCount += 1;
        recheckPagesSucceeded += result.pagesSucceeded;
        recheckPagesFailed += result.pagesFailed;
        recheckedTombstonesConfirmed += result.tombstonesConfirmed;
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
      let pendingFiles = 0;
      // Downloads use the full soft window, even after discovery yielded.
      let downloadsYielded = false;

      for (const file of files) {
        context.signal.throwIfAborted();
        const key = stateKey(file);
        const previous = state.items[key];
        if (downloadsYielded || shouldYield()) {
          // No new download after the soft deadline. A file proven by the
          // previous checkpoint stays resolved (same as a failed recheck);
          // an unknown one leaves its document deferred for the next run.
          downloadsYielded = true;
          yielded = true;
          if (previous) resolvedFiles.set(key, connectorFile(file, previous));
          else pendingFiles += 1;
          continue;
        }
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

      // A document is emitted only when every one of its files is resolved
      // (downloaded now or proven by a previous checkpoint). Otherwise it is
      // deferred: not emitted with a partial file set (which would create an
      // artificial version later) and not marked as known, so the very next
      // run fetches it again.
      const candidates: IdentityCandidate[] = [];
      const deferred: SpedDocumentDescriptor[] = [];
      const incompleteExternalIds = new Set<string>();
      for (const result of crawlResults) {
        for (const externalId of result.incompleteExternalIds) incompleteExternalIds.add(externalId);
      }
      for (const descriptor of descriptors) {
        if (
          incompleteExternalIds.has(descriptor.externalId) ||
          (descriptor.linkedArtifactExternalIds ?? []).some((id) => incompleteExternalIds.has(id))
        ) {
          // Crawl yielded before all linked artifact pages were read.
          deferred.push(descriptor);
          continue;
        }
        const currentFiles = descriptor.files
          .map((file) => resolvedFiles.get(stateKey({
            module: descriptor.module,
            publicationExternalId: descriptor.externalId,
            url: file.url,
            externalId: file.externalId,
            ...(file.name ? { name: file.name } : {}),
          })));
        if (currentFiles.some((file) => file === undefined)) {
          deferred.push(descriptor);
          continue;
        }
        const resolved = currentFiles as ConnectorFile[];
        candidates.push({
          descriptor,
          files: resolved,
          baseKey: spedBaseIdentityKey(descriptor),
          fileSha256s: resolved
            .map((file) => file.rawSha256)
            .filter((hash): hash is string => typeof hash === 'string')
            .sort(),
        });
      }

      const identity = resolveIdentities(
        candidates,
        state.identities ?? {},
        state.persistedTitleFamilyKeys ?? {},
      );
      const publications: ConnectorPublication[] = candidates.map((candidate) =>
        publicationFor(
          candidate.descriptor,
          candidate.files,
          portal,
          identity.keys.get(candidate.descriptor.externalId)!,
          identity.canonical.get(candidate.descriptor.externalId),
        ),
      );

      const allDescriptors = new Map<string, SpedDocumentDescriptor>();
      for (const result of crawlResults) {
        for (const [externalId, descriptor] of result.descriptors) allDescriptors.set(externalId, descriptor);
      }
      const pendingUrls = new Set<string>();
      for (const descriptor of deferred) {
        pendingUrls.add(canonicalPortalUrl(descriptor.officialUrl));
        for (const linkedId of descriptor.linkedArtifactExternalIds ?? []) {
          const linked = allDescriptors.get(linkedId);
          if (linked) pendingUrls.add(canonicalPortalUrl(linked.officialUrl));
        }
      }
      for (const [key, page] of Object.entries(nextPages)) {
        if (pendingUrls.has(page.canonicalUrl) || pendingUrls.has(key)) {
          nextPages[key] = { ...page, kind: 'UNKNOWN' };
        }
      }

      const skippedKnownDocumentCount = crawlResults.reduce(
        (sum, result) => sum + result.skippedKnownDocuments,
        0,
      );
      const pendingCrawlPages = crawlResults.reduce((sum, result) => sum + result.pendingPages, 0);

      // Next cycle state (only when this run yielded).
      let nextCycle: SpedCrawlCycle | undefined;
      if (yielded) {
        const frontier: SpedFrontierPage[] = [];
        const frontierKeys = new Set<string>();
        const addFrontier = (page: SpedFrontierPage): void => {
          const key = page.module + ' ' + page.url + ' ' + (page.forceFetch ? 'F' : 'N');
          if (frontierKeys.has(key) || frontier.length >= SPED_MAX_FRONTIER) return;
          frontierKeys.add(key);
          frontier.push(page);
        };
        for (const result of crawlResults) {
          for (const page of result.remainingQueue) {
            if (page.parentExternalId) {
              // Artifact of a document read in this run: revisit the whole
              // document next time (its descriptor is not carried over).
              const parent = allDescriptors.get(page.parentExternalId);
              if (parent) {
                addFrontier({
                  module: result.module,
                  url: canonicalPortalUrl(parent.officialUrl),
                  depth: 1,
                  seedKind: 'CATEGORY',
                  forceFetch: true,
                });
              }
              continue;
            }
            addFrontier({
              module: result.module,
              url: page.url,
              depth: page.depth,
              seedKind: page.seedKind,
              ...(page.forceFetch ? { forceFetch: true } : {}),
            });
          }
        }
        for (const descriptor of deferred) {
          addFrontier({
            module: descriptor.module,
            url: canonicalPortalUrl(descriptor.officialUrl),
            depth: 1,
            seedKind: 'CATEGORY',
            forceFetch: true,
          });
        }
        nextCycle = {
          completedModules: definitions
            .map((definition) => definition.module)
            .filter((module) => completedModules.has(module) || finishedThisRun.has(module)),
          frontier,
        };
      }

      return {
        publications,
        ...(partialFailures.length ? { partialFailures } : {}),
        ...(yielded
          ? {
              completion: {
                complete: false,
                reason: 'TIME_BUDGET_REACHED' as const,
                pending: {
                  modules: pendingModules,
                  crawlPages: pendingCrawlPages,
                  rechecks: pendingRechecks,
                  files: pendingFiles,
                  deferredDocuments: deferred.length,
                },
              },
            }
          : {}),
        checkpoint: {
          version: SPED_STATE_VERSION,
          state: {
            version: SPED_STATE_VERSION,
            items: nextItems,
            pages: nextPages,
            identities: identity.identities,
            ...(nextCycle ? { cycle: nextCycle } : {}),
          },
        },
        metadata: {
          sped: {
            modulesSucceeded,
            modulesTotal: definitions.length,
            portal,
            primaryOrigin: portal === 'GOVBR' ? SPED_GOVBR_BASE_URL : SPED_LEGACY_ORIGIN,
            moduleResults: crawlResults.map((result) => ({
              module: result.module,
              pagesSucceeded: result.pagesSucceeded,
              pagesFailed: result.pagesFailed,
              pagesVisited: result.pagesVisited,
              seedSuccesses: result.seedSuccesses,
              processedDocumentCount: result.descriptors.size,
              skippedKnownDocuments: result.skippedKnownDocuments,
              skippedKnownMissingPages: result.skippedKnownMissingPages,
              missingHistoricalPages: result.missingHistoricalPages,
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
            skippedKnownMissingPageCount: crawlResults.reduce(
              (sum, result) => sum + result.skippedKnownMissingPages,
              0,
            ),
            historicalMissingPageCount: crawlResults.reduce(
              (sum, result) => sum + result.missingHistoricalPages,
              0,
            ),
            reusedCheckpointCount:
              skippedKnownDocumentCount +
              crawlResults.reduce(
                (sum, result) => sum + result.skippedKnownMissingPages,
                0,
              ),
            recheckedKnownDocumentCount,
            recheckedMissingPageCount,
            recheckedTombstonesConfirmed,
            recheckPagesSucceeded,
            recheckPagesFailed,
            knownDocumentCandidateCount: candidateMap.size,
            knownPageCount: Object.keys(nextPages).length,
            revisitAfterMs,
            maxRechecksPerRun,
            maxPagesPerModule,
            maxCrawlDepth,
            partialFailureCount: partialFailures.length,
            deferredDocumentCount: deferred.length,
            // Bounded sample: attempt metadata is history, not a data store.
            deferredDocuments: deferred.slice(0, SPED_DEFERRED_SAMPLE_SIZE).map((descriptor) => ({
              externalId: descriptor.externalId,
              officialUrl: descriptor.officialUrl,
              title: descriptor.title,
              module: descriptor.module,
            })),
            identityAudit: identity.audit,
            stateVersion: SPED_STATE_VERSION,
            scope: ['EFD_ICMS_IPI', 'EFD_CONTRIBUICOES', 'EFD_REINF', 'DERE'],
            timeBudgetYielded: yielded,
            resumedCycle: resumed,
            nextFrontierSize: nextCycle?.frontier.length ?? 0,
          },
        },
      };
    } finally {
      client.close();
    }
  }
}
