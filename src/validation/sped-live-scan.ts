import { SpedClient } from '../modules/collection/sped.client.js';
import { SPED_MODULES } from '../modules/collection/sped.connector.js';
import {
  descriptorFromPage,
  isAllowedGlobalHighlight,
  isTechnicalNavigationText,
  moduleTextMatches,
  parseSpedPage,
  type SpedDocumentDescriptor,
  type SpedModule,
} from '../modules/collection/sped.parser.js';

const ORIGIN = 'https://sped.rfb.gov.br';
const MAX_PAGES_PER_MODULE = 600;
const MAX_DEPTH = 5;

function sameNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN &&
      (
        /^\/(?:item|pasta)\/show\/\d+$/i.test(parsed.pathname) ||
        /^\/arquivo\/show\/\d+$/i.test(parsed.pathname) ||
        /^\/destaques\/show\/\d+$/i.test(parsed.pathname)
      );
  } catch {
    return false;
  }
}

function shouldFollow(module: SpedModule, seedKind: string, text: string, url: string): boolean {
  if (!sameNavigation(url)) return false;
  if (seedKind === 'GLOBAL_HIGHLIGHTS') return isAllowedGlobalHighlight(module, text);
  if (/\/destaques\/show\//i.test(url)) return true;
  return isTechnicalNavigationText(text) || moduleTextMatches(module, text);
}

interface CrawlResult {
  module: SpedModule;
  pagesVisited: number;
  pagesSucceeded: number;
  pagesFailed: number;
  descriptors: SpedDocumentDescriptor[];
  fileCount: number;
  failures: Array<{ url: string; error: string }>;
}

async function crawlModule(moduleDef: (typeof SPED_MODULES)[number], client: SpedClient): Promise<CrawlResult> {
  const queue = moduleDef.seeds.map(seed => ({ url: seed.url, depth: 0, seedKind: seed.kind }));
  const seen = new Set<string>();
  const descriptors = new Map<string, SpedDocumentDescriptor>();
  const failures: Array<{ url: string; error: string }> = [];
  let pagesSucceeded = 0;
  let pagesFailed = 0;

  while (queue.length && seen.size < MAX_PAGES_PER_MODULE) {
    const current = queue.shift()!;
    if (seen.has(current.url)) continue;
    seen.add(current.url);
    try {
      const response = await client.getHtml(current.url, AbortSignal.timeout(30_000));
      const page = parseSpedPage(response.html, response.url);
      pagesSucceeded += 1;
      const descriptor = descriptorFromPage(moduleDef.module, page);
      if (descriptor) descriptors.set(descriptor.externalId, descriptor);
      if (current.depth >= MAX_DEPTH) continue;
      for (const link of page.links) {
        if (!shouldFollow(moduleDef.module, current.seedKind, link.text, link.url)) continue;
        if (seen.has(link.url)) continue;
        queue.push({
          url: link.url,
          depth: current.depth + 1,
          seedKind: current.seedKind === 'GLOBAL_HIGHLIGHTS' ? 'GLOBAL_HIGHLIGHTS' : 'CATEGORY',
        });
      }
    } catch (error) {
      pagesFailed += 1;
      failures.push({
        url: current.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const values = [...descriptors.values()];
  return {
    module: moduleDef.module,
    pagesVisited: seen.size,
    pagesSucceeded,
    pagesFailed,
    descriptors: values,
    fileCount: values.reduce((sum, item) => sum + item.files.length, 0),
    failures,
  };
}

function gateName(descriptor: SpedDocumentDescriptor): string | undefined {
  const title = descriptor.title.toLowerCase();
  if (descriptor.module === 'EFD_ICMS_IPI' && descriptor.officialVersion === '3.2.1' && descriptor.kind === 'GUIDE') return 'GUIDE_3_2_1';
  if (descriptor.module === 'EFD_ICMS_IPI' && descriptor.officialVersion === '3.2.2' && descriptor.kind === 'GUIDE') return 'GUIDE_3_2_2';
  if (descriptor.module === 'EFD_REINF' && descriptor.documentNumber === '01/2026' && !descriptor.republication) return 'REINF_NT_01_2026';
  if (descriptor.module === 'EFD_REINF' && descriptor.documentNumber === '01/2026' && descriptor.republication) return 'REINF_NT_01_2026_REPUBLICADA';
  if (descriptor.module === 'EFD_CONTRIBUICOES' && descriptor.documentNumber === '11/2026') return 'CONTRIB_NT_11_2026';
  if (descriptor.module === 'EFD_CONTRIBUICOES' && descriptor.documentNumber === '12/2026') return 'CONTRIB_NT_12_2026';
  if (descriptor.module === 'EFD_REINF' && descriptor.kind === 'XSD_SCHEMA') return 'REINF_XSD';
  if (descriptor.module === 'DERE' && /dere|regimes especiais/i.test(title + ' ' + descriptor.documentFamily)) return 'DERE';
  return undefined;
}

const client = new SpedClient({ timeoutMs: 30_000 });
try {
  const crawls: CrawlResult[] = [];
  for (const moduleDef of SPED_MODULES) {
    const result = await crawlModule(moduleDef, client);
    crawls.push(result);
    console.log('SPED_LIVE_MODULE=' + JSON.stringify({
      module: result.module,
      pagesVisited: result.pagesVisited,
      pagesSucceeded: result.pagesSucceeded,
      pagesFailed: result.pagesFailed,
      documentCount: result.descriptors.length,
      fileCount: result.fileCount,
      kinds: Object.fromEntries(
        [...new Set(result.descriptors.map(d => d.kind))]
          .sort()
          .map(kind => [kind, result.descriptors.filter(d => d.kind === kind).length]),
      ),
    }));
  }

  const descriptors = crawls.flatMap(result => result.descriptors);
  const selected = new Map<string, SpedDocumentDescriptor>();
  for (const descriptor of descriptors) {
    const gate = gateName(descriptor);
    if (gate && !selected.has(gate)) selected.set(gate, descriptor);
  }

  const gateResults: Record<string, unknown> = {};
  for (const gate of [
    'GUIDE_3_2_1',
    'GUIDE_3_2_2',
    'REINF_NT_01_2026',
    'REINF_NT_01_2026_REPUBLICADA',
    'CONTRIB_NT_11_2026',
    'CONTRIB_NT_12_2026',
    'REINF_XSD',
    'DERE',
  ]) {
    const descriptor = selected.get(gate);
    if (!descriptor) {
      gateResults[gate] = { found: false };
      continue;
    }
    const firstFile = descriptor.files[0];
    let file: unknown = null;
    if (firstFile) {
      try {
        const download = await client.downloadFile(firstFile.url, AbortSignal.timeout(60_000));
        file = download.status === 'DOWNLOADED'
          ? {
              status: download.status,
              url: download.url,
              rawSha256: download.rawSha256,
              sizeBytes: download.sizeBytes,
              mimeType: download.mimeType,
              filename: download.filename ?? null,
            }
          : { status: download.status, url: download.url };
      } catch (error) {
        file = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    gateResults[gate] = {
      found: true,
      title: descriptor.title,
      module: descriptor.module,
      kind: descriptor.kind,
      externalId: descriptor.externalId,
      officialVersion: descriptor.officialVersion ?? null,
      documentNumber: descriptor.documentNumber ?? null,
      revisionKind: descriptor.revisionKind,
      publishedAt: descriptor.publishedAt?.toISOString() ?? null,
      officialUrl: descriptor.officialUrl,
      files: descriptor.files.length,
      sampleFile: file,
    };
  }

  console.log('SPED_LIVE_SCAN=' + JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      pagesVisited: crawls.reduce((sum, item) => sum + item.pagesVisited, 0),
      pagesSucceeded: crawls.reduce((sum, item) => sum + item.pagesSucceeded, 0),
      pagesFailed: crawls.reduce((sum, item) => sum + item.pagesFailed, 0),
      documents: descriptors.length,
      files: descriptors.reduce((sum, item) => sum + item.files.length, 0),
    },
    modules: crawls.map(item => ({
      module: item.module,
      pagesVisited: item.pagesVisited,
      pagesSucceeded: item.pagesSucceeded,
      pagesFailed: item.pagesFailed,
      documents: item.descriptors.length,
      files: item.fileCount,
      failures: item.failures.slice(0, 10),
    })),
    gates: gateResults,
  }));
} finally {
  client.close();
}
