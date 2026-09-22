import http from 'node:http';

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

const OFFICIAL_ORIGIN = 'https://sped.rfb.gov.br';
const TRANSPORT_ORIGIN = 'http://sped.rfb.gov.br';
const MAX_PAGES_PER_MODULE = 800;
const MAX_DEPTH = 6;
const CONCURRENCY = 6;

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  finalOfficialUrl: string;
}

function transportUrl(officialUrl: string): string {
  const parsed = new URL(officialUrl, OFFICIAL_ORIGIN);
  return TRANSPORT_ORIGIN + parsed.pathname + parsed.search;
}

function requestOnce(url: string, method: 'GET' | 'HEAD', timeoutMs: number): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      protocol: 'http:',
      hostname: parsed.hostname,
      port: 80,
      path: parsed.pathname + parsed.search,
      method,
      family: 4,
      timeout: timeoutMs,
      headers: {
        host: 'sped.rfb.gov.br',
        'user-agent': 'RadarFiscal-SPED-Validation/1.0',
        accept: '*/*',
        connection: 'close',
      },
    }, (res) => {
      if (method === 'HEAD') {
        res.resume();
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.alloc(0),
        }));
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

async function requestHttp(
  officialUrl: string,
  method: 'GET' | 'HEAD',
  timeoutMs = 20_000,
): Promise<HttpResult & { body: Buffer }> {
  let current = transportUrl(officialUrl);
  const seen = new Set<string>();

  for (let redirects = 0; redirects <= 8; redirects += 1) {
    if (seen.has(current)) throw new Error('HTTP_REDIRECT_LOOP');
    seen.add(current);

    const result = await requestOnce(current, method, timeoutMs);
    if (![301, 302, 303, 307, 308].includes(result.status)) {
      const parsed = new URL(current);
      return {
        status: result.status,
        headers: result.headers,
        body: result.body,
        finalOfficialUrl: OFFICIAL_ORIGIN + parsed.pathname + parsed.search,
      };
    }

    const location = typeof result.headers.location === 'string'
      ? result.headers.location
      : undefined;
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

async function getHtml(officialUrl: string): Promise<{
  html: string;
  officialUrl: string;
}> {
  const result = await requestHttp(officialUrl, 'GET');
  if (result.status < 200 || result.status >= 300) throw new Error('HTTP_' + result.status);
  return {
    html: result.body.toString('utf8'),
    officialUrl: result.finalOfficialUrl,
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

function shouldFollow(module: SpedModule, seedKind: string, text: string, url: string): boolean {
  if (!sameNavigation(url)) return false;
  if (seedKind === 'GLOBAL_HIGHLIGHTS') return isAllowedGlobalHighlight(module, text);
  if (/\/destaques\/show\//i.test(url)) return true;
  return isTechnicalNavigationText(text) || moduleTextMatches(module, text);
}

async function crawlModule(definition: (typeof SPED_MODULES)[number]): Promise<SpedDocumentDescriptor[]> {
  const queue = definition.seeds.map((seed) => ({
    url: seed.url,
    depth: 0,
    seedKind: seed.kind,
  }));
  const seen = new Set<string>();
  const descriptors = new Map<string, SpedDocumentDescriptor>();

  while (queue.length && seen.size < MAX_PAGES_PER_MODULE) {
    const current = queue.shift()!;
    if (seen.has(current.url)) continue;
    seen.add(current.url);

    try {
      const response = await getHtml(current.url);
      const page = parseSpedPage(response.html, response.officialUrl);
      const descriptor = descriptorFromPage(definition.module, page);
      if (descriptor) descriptors.set(descriptor.externalId, descriptor);

      if (current.depth >= MAX_DEPTH) continue;
      for (const link of page.links) {
        if (!shouldFollow(definition.module, current.seedKind, link.text, link.url)) continue;
        queue.push({
          url: link.url,
          depth: current.depth + 1,
          seedKind: current.seedKind === 'GLOBAL_HIGHLIGHTS'
            ? 'GLOBAL_HIGHLIGHTS'
            : 'CATEGORY',
        });
      }
    } catch {}
  }

  return [...descriptors.values()];
}

const descriptors: SpedDocumentDescriptor[] = [];
for (const definition of SPED_MODULES) {
  const moduleDescriptors = await crawlModule(definition);
  descriptors.push(...moduleDescriptors);
  console.error('SPED_SIZE_MODULE=' + JSON.stringify({
    module: definition.module,
    documents: moduleDescriptors.length,
    fileRefs: moduleDescriptors.reduce((sum, item) => sum + item.files.length, 0),
  }));
}

const requestedFiles = [...new Map(
  descriptors.flatMap((descriptor) =>
    descriptor.files.map((file) => [file.url, {
      module: descriptor.module,
      publicationExternalId: descriptor.externalId,
      url: file.url,
      name: file.name ?? null,
    }] as const),
  ),
).values()];

type HeadResult = {
  module: SpedModule;
  publicationExternalId: string;
  requestedUrl: string;
  finalOfficialUrl?: string;
  status?: number;
  contentLength?: number;
  contentType?: string;
  name?: string | null;
  error?: string;
};

const results: HeadResult[] = new Array(requestedFiles.length);
let cursor = 0;

async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    if (index >= requestedFiles.length) return;
    const file = requestedFiles[index]!;
    try {
      const response = await requestHttp(file.url, 'HEAD', 20_000);
      const lengthRaw = response.headers['content-length'];
      const contentLength =
        typeof lengthRaw === 'string' && /^\d+$/.test(lengthRaw)
          ? Number(lengthRaw)
          : undefined;
      const contentTypeRaw = response.headers['content-type'];
      results[index] = {
        module: file.module,
        publicationExternalId: file.publicationExternalId,
        requestedUrl: file.url,
        finalOfficialUrl: response.finalOfficialUrl,
        status: response.status,
        ...(contentLength !== undefined ? { contentLength } : {}),
        ...(typeof contentTypeRaw === 'string' ? { contentType: contentTypeRaw } : {}),
        name: file.name,
      };
    } catch (error) {
      results[index] = {
        module: file.module,
        publicationExternalId: file.publicationExternalId,
        requestedUrl: file.url,
        name: file.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const successful = results.filter((item) => item && item.status && item.status >= 200 && item.status < 300);
const knownSizes = successful.filter((item) => item.contentLength !== undefined);
const uniqueFinal = new Map<string, HeadResult>();
for (const item of successful) {
  const key = item.finalOfficialUrl ?? item.requestedUrl;
  if (!uniqueFinal.has(key)) uniqueFinal.set(key, item);
}

const uniqueKnown = [...uniqueFinal.values()].filter((item) => item.contentLength !== undefined);
const totalBytes = uniqueKnown.reduce((sum, item) => sum + (item.contentLength ?? 0), 0);
const largest = [...uniqueKnown]
  .sort((a, b) => (b.contentLength ?? 0) - (a.contentLength ?? 0))
  .slice(0, 20);
const over160 = uniqueKnown.filter((item) => (item.contentLength ?? 0) > 160 * 1024 * 1024);

const byModule = Object.fromEntries(
  SPED_MODULES.map(({ module }) => {
    const moduleItems = uniqueKnown.filter((item) => item.module === module);
    return [module, {
      uniqueFilesWithSize: moduleItems.length,
      totalBytes: moduleItems.reduce((sum, item) => sum + (item.contentLength ?? 0), 0),
      maxBytes: moduleItems.reduce((max, item) => Math.max(max, item.contentLength ?? 0), 0),
    }];
  }),
);

console.error('SPED_SIZE_SUMMARY=' + JSON.stringify({
  generatedAt: new Date().toISOString(),
  transport: 'HTTP_VALIDATION_ONLY',
  documentCount: descriptors.length,
  requestedFileRefs: requestedFiles.length,
  successfulHeadCount: successful.length,
  knownSizeCount: knownSizes.length,
  uniqueFinalFiles: uniqueFinal.size,
  uniqueKnownSizeCount: uniqueKnown.length,
  unknownSizeCount: uniqueFinal.size - uniqueKnown.length,
  totalBytes,
  totalMiB: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
  over160MiBCount: over160.length,
  over160MiB: over160,
  largest,
  byModule,
  errors: results.filter((item) => item?.error || !item?.status || item.status < 200 || item.status >= 300).slice(0, 30),
}));
