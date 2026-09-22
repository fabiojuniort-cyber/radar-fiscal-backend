// HTTP bootstrap validation trigger
import { createHash } from 'node:crypto';

import {
  SPED_MODULES,
} from '../modules/collection/sped.connector.js';
import {
  descriptorFromPage,
  isAllowedGlobalHighlight,
  isTechnicalNavigationText,
  moduleTextMatches,
  parseSpedPage,
  type SpedDocumentDescriptor,
  type SpedModule,
} from '../modules/collection/sped.parser.js';

console.error('SPED_HTTP_SCAN_START=' + new Date().toISOString());

const OFFICIAL_ORIGIN = 'https://sped.rfb.gov.br';
const TRANSPORT_ORIGIN = 'http://sped.rfb.gov.br';
const MAX_PAGES_PER_MODULE = 800;
const MAX_DEPTH = 6;

function transportUrl(officialUrl: string): string {
  const parsed = new URL(officialUrl, OFFICIAL_ORIGIN);
  return TRANSPORT_ORIGIN + parsed.pathname + parsed.search;
}

async function requestHttp(
  officialUrl: string,
  timeoutMs: number,
): Promise<Response & { finalOfficialUrl?: string }> {
  let current = transportUrl(officialUrl);
  const seen = new Set<string>();

  for (let redirects = 0; redirects <= 6; redirects += 1) {
    if (seen.has(current)) throw new Error('HTTP_REDIRECT_LOOP');
    seen.add(current);

    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'RadarFiscal-SPED-Validation/1.0',
        accept: '*/*',
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const finalOfficialUrl =
        OFFICIAL_ORIGIN + new URL(current).pathname + new URL(current).search;
      Object.defineProperty(response, 'finalOfficialUrl', {
        value: finalOfficialUrl,
        enumerable: false,
      });
      return response as Response & { finalOfficialUrl?: string };
    }

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('HTTP_REDIRECT_WITHOUT_LOCATION');
    const next = new URL(location, current);
    if (next.hostname.toLowerCase() !== 'sped.rfb.gov.br') {
      throw new Error('HTTP_CROSS_ORIGIN_REDIRECT:' + next.toString());
    }
    next.protocol = 'http:';
    current = next.toString();
  }

  throw new Error('HTTP_TOO_MANY_REDIRECTS');
}

async function getHtml(
  officialUrl: string,
): Promise<{ html: string; status: number; bytes: number; officialUrl: string }> {
  const response = await requestHttp(officialUrl, 20_000);
  const html = await response.text();
  return {
    html,
    status: response.status,
    bytes: Buffer.byteLength(html),
    officialUrl: response.finalOfficialUrl ?? officialUrl,
  };
}

async function download(officialUrl: string): Promise<{
  status: number;
  rawSha256?: string;
  sizeBytes?: number;
  contentType?: string;
  filename?: string;
}> {
  const response = await requestHttp(officialUrl, 60_000);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const disposition = response.headers.get('content-disposition');
  const filename = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '')?.[1]?.trim();
  return {
    status: response.status,
    ...(response.status >= 200 && response.status < 300
      ? {
          rawSha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
        }
      : {}),
    ...(response.headers.get('content-type')
      ? { contentType: response.headers.get('content-type')! }
      : {}),
    ...(filename ? { filename } : {}),
  };
}

function sameNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === OFFICIAL_ORIGIN &&
      (
        /^\/(?:item|pasta|projeto|pagina)\/show\/\d+$/i.test(parsed.pathname) ||
        /^\/arquivo\/show\/\d+$/i.test(parsed.pathname) ||
        /^\/destaques\/show\/\d+$/i.test(parsed.pathname)
      );
  } catch {
    return false;
  }
}

function shouldFollow(
  module: SpedModule,
  seedKind: string,
  text: string,
  url: string,
): boolean {
  if (!sameNavigation(url)) return false;
  if (seedKind === 'GLOBAL_HIGHLIGHTS') {
    return isAllowedGlobalHighlight(module, text);
  }
  if (/\/destaques\/show\//i.test(url)) return true;
  return isTechnicalNavigationText(text) || moduleTextMatches(module, text);
}

interface CrawlResult {
  module: SpedModule;
  pagesVisited: number;
  pagesSucceeded: number;
  pagesFailed: number;
  descriptors: SpedDocumentDescriptor[];
  failures: Array<{ url: string; error: string }>;
}

async function crawlModule(
  definition: (typeof SPED_MODULES)[number],
): Promise<CrawlResult> {
  const queue = definition.seeds.map((seed) => ({
    url: seed.url,
    depth: 0,
    seedKind: seed.kind,
  }));
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
      const response = await getHtml(current.url);
      if (response.status < 200 || response.status >= 300) {
        throw new Error('HTTP_' + response.status);
      }
      const page = parseSpedPage(response.html, response.officialUrl);
      pagesSucceeded += 1;

      const descriptor = descriptorFromPage(definition.module, page);
      if (descriptor) descriptors.set(descriptor.externalId, descriptor);

      if (current.depth >= MAX_DEPTH) continue;
      for (const link of page.links) {
        if (!shouldFollow(definition.module, current.seedKind, link.text, link.url)) {
          continue;
        }
        if (seen.has(link.url)) continue;
        queue.push({
          url: link.url,
          depth: current.depth + 1,
          seedKind:
            current.seedKind === 'GLOBAL_HIGHLIGHTS'
              ? 'GLOBAL_HIGHLIGHTS'
              : 'CATEGORY',
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

  return {
    module: definition.module,
    pagesVisited: seen.size,
    pagesSucceeded,
    pagesFailed,
    descriptors: [...descriptors.values()],
    failures,
  };
}

function gateName(descriptor: SpedDocumentDescriptor): string | undefined {
  if (
    descriptor.module === 'EFD_ICMS_IPI' &&
    descriptor.kind === 'GUIDE' &&
    descriptor.officialVersion === '3.2.1'
  ) return 'GUIDE_3_2_1';

  if (
    descriptor.module === 'EFD_ICMS_IPI' &&
    descriptor.kind === 'GUIDE' &&
    descriptor.officialVersion === '3.2.2'
  ) return 'GUIDE_3_2_2';

  if (
    descriptor.module === 'EFD_REINF' &&
    descriptor.documentNumber === '01/2026' &&
    !descriptor.republication
  ) return 'REINF_NT_01_2026';

  if (
    descriptor.module === 'EFD_REINF' &&
    descriptor.documentNumber === '01/2026' &&
    descriptor.republication
  ) return 'REINF_NT_01_2026_REPUBLICADA';

  if (
    descriptor.module === 'EFD_CONTRIBUICOES' &&
    descriptor.documentNumber === '11/2026'
  ) return 'CONTRIB_NT_11_2026';

  if (
    descriptor.module === 'EFD_CONTRIBUICOES' &&
    descriptor.documentNumber === '12/2026'
  ) return 'CONTRIB_NT_12_2026';

  if (
    descriptor.module === 'EFD_REINF' &&
    descriptor.kind === 'XSD_SCHEMA'
  ) return 'REINF_XSD';

  if (descriptor.module === 'DERE') return 'DERE';

  return undefined;
}

const crawls: CrawlResult[] = [];
for (const definition of SPED_MODULES) {
  const result = await crawlModule(definition);
  crawls.push(result);

  const files = result.descriptors.flatMap((descriptor) => descriptor.files);
  const kindCounts = Object.fromEntries(
    [...new Set(result.descriptors.map((descriptor) => descriptor.kind))]
      .sort()
      .map((kind) => [
        kind,
        result.descriptors.filter((descriptor) => descriptor.kind === kind).length,
      ]),
  );

  console.log('SPED_HTTP_MODULE=' + JSON.stringify({
    module: result.module,
    pagesVisited: result.pagesVisited,
    pagesSucceeded: result.pagesSucceeded,
    pagesFailed: result.pagesFailed,
    documents: result.descriptors.length,
    files: files.length,
    kindCounts,
    failures: result.failures.slice(0, 10),
  }));
}

const descriptors = crawls.flatMap((result) => result.descriptors);
const gates = new Map<string, SpedDocumentDescriptor>();

for (const descriptor of descriptors) {
  const gate = gateName(descriptor);
  if (gate && !gates.has(gate)) gates.set(gate, descriptor);
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
  const descriptor = gates.get(gate);
  if (!descriptor) {
    gateResults[gate] = { found: false };
    continue;
  }

  const firstFile = descriptor.files[0];
  let sampleFile: unknown = null;
  if (firstFile) {
    try {
      sampleFile = await download(firstFile.url);
    } catch (error) {
      sampleFile = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  gateResults[gate] = {
    found: true,
    title: descriptor.title,
    module: descriptor.module,
    kind: descriptor.kind,
    externalId: descriptor.externalId,
    documentFamily: descriptor.documentFamily,
    officialVersion: descriptor.officialVersion ?? null,
    documentNumber: descriptor.documentNumber ?? null,
    revisionKind: descriptor.revisionKind,
    republication: descriptor.republication,
    publishedAt: descriptor.publishedAt?.toISOString() ?? null,
    officialUrl: descriptor.officialUrl,
    fileCount: descriptor.files.length,
    firstOfficialFileUrl: firstFile?.url ?? null,
    sampleFile,
  };
}

console.log('SPED_HTTP_BOOTSTRAP=' + JSON.stringify({
  generatedAt: new Date().toISOString(),
  transport: 'HTTP_VALIDATION_ONLY',
  officialOrigin: OFFICIAL_ORIGIN,
  totals: {
    pagesVisited: crawls.reduce((sum, item) => sum + item.pagesVisited, 0),
    pagesSucceeded: crawls.reduce((sum, item) => sum + item.pagesSucceeded, 0),
    pagesFailed: crawls.reduce((sum, item) => sum + item.pagesFailed, 0),
    documents: descriptors.length,
    files: descriptors.reduce(
      (sum, descriptor) => sum + descriptor.files.length,
      0,
    ),
  },
  modules: crawls.map((result) => ({
    module: result.module,
    pagesVisited: result.pagesVisited,
    pagesSucceeded: result.pagesSucceeded,
    pagesFailed: result.pagesFailed,
    documents: result.descriptors.length,
    files: result.descriptors.reduce(
      (sum, descriptor) => sum + descriptor.files.length,
      0,
    ),
  })),
  gates: gateResults,
}));
