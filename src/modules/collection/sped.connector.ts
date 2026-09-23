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

interface SpedModuleSeed {
  url: string;
  kind: 'MODULE' | 'CATEGORY' | 'MODULE_HIGHLIGHTS' | 'GLOBAL_HIGHLIGHTS';
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
  if (/^(?:faq|fale-conosco|contato|acesso-a-informacao|ouvidoria|validadores?)$/i.test(leaf)) {
    return false;
  }

  if (isTechnicalNavigationText(text) || moduleTextMatches(module, text)) return true;

  return /(?:^|[-/])(?:manua(?:l|is)|document(?:o|os|acao)|tecnic(?:o|os|a|as)|nota(?:s)?|orienta|guia(?:s)?|leiaute(?:s)?|layout(?:s)?|xsd|schema|esquema(?:s)?|tabela(?:s)?|versao|versoes|histori(?:co|cos)|download(?:s)?|comunicado(?:s)?|programa(?:s)?|pva|pge)(?:[-/]|$)/i.test(pathname);
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
  let skippedKnownMissingPages = 0;
  let missingHistoricalPages = 0;

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

function spedPublicationIdentityKey(descriptor: SpedDocumentDescriptor): string {
  const family = descriptor.documentNumber ?? descriptor.documentFamily;
  return [
    'SPED',
    descriptor.module,
    descriptor.kind,
    normalizedIdentityToken(family),
    descriptor.officialVersion ?? '',
    descriptor.revisionKind,
  ].join('|');
}

function publicationFor(
  descriptor: SpedDocumentDescriptor,
  files: ConnectorFile[],
  portal: SpedPortalMode,
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
    identityKey: spedPublicationIdentityKey(descriptor),
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
  readonly version = '0.3.0';
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

    try {
      for (const definition of definitions) {
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
          portal,
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
      let recheckedMissingPageCount = 0;
      let recheckPagesSucceeded = 0;
      let recheckPagesFailed = 0;
      let recheckedTombstonesConfirmed = 0;

      for (const candidate of selectedRechecks) {
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
        publications.push(publicationFor(descriptor, currentFiles, portal));
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
