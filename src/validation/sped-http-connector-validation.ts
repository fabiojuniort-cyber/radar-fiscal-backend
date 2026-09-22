import { createHash } from 'node:crypto';

import { SpedConnector, type SpedSourceState } from '../modules/collection/sped.connector.js';

const HOST = 'sped.rfb.gov.br';
const CONTEXT_BASE = {
  sourceId: '00000000-0000-4000-8000-000000000032',
  runId: '00000000-0000-4000-8000-000000000033',
  attemptId: '00000000-0000-4000-8000-000000000034',
};

let requestCount = 0;
let htmlRequestCount = 0;
let fileRequestCount = 0;

function inputUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? undefined;
}

function normalizeHtmlToOfficialHttps(body: string): string {
  return body
    .replaceAll('http://sped.rfb.gov.br', 'https://sped.rfb.gov.br')
    .replaceAll('http:\/\/sped.rfb.gov.br', 'https:\/\/sped.rfb.gov.br');
}

function stubFileResponse(url: URL, init?: RequestInit): Response {
  fileRequestCount += 1;
  const etag = '"' + createHash('sha1').update(url.pathname + url.search).digest('hex') + '"';
  if (headerValue(init, 'if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const bytes = new TextEncoder().encode('%PDF-1.7\nRadar Fiscal SPED validation stub\n' + url.pathname);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      etag,
      'content-length': String(bytes.byteLength),
      'content-disposition': 'attachment; filename="sped-validation.pdf"',
    },
  });
}

const transportFetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  requestCount += 1;
  if (requestCount % 100 === 0) {
    console.error('SPED_REAL_CONNECTOR_PROGRESS=' + JSON.stringify({
      requestCount,
      htmlRequestCount,
      fileRequestCount,
      at: new Date().toISOString(),
    }));
  }
  const official = inputUrl(input);
  if (official.hostname.toLowerCase() !== HOST) {
    throw new Error('Unexpected host in SPED validation: ' + official.hostname);
  }

  if (/^\/arquivo\/download\/\d+$/i.test(official.pathname) || /^\/estatico\//i.test(official.pathname)) {
    return stubFileResponse(official, init);
  }

  htmlRequestCount += 1;
  const transport = new URL(official);
  transport.protocol = 'http:';

  const response = await fetch(transport, {
    ...init,
    redirect: 'manual',
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });

  const headers = new Headers(response.headers);
  const location = headers.get('location');
  if (location) {
    const next = new URL(location, transport);
    if (next.hostname.toLowerCase() !== HOST) {
      throw new Error('Cross-origin redirect in SPED validation: ' + next.toString());
    }
    next.protocol = 'https:';
    headers.set('location', next.toString());
  }

  const contentType = headers.get('content-type') ?? '';
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const body = normalizeHtmlToOfficialHttps(await response.text());
    headers.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}) as typeof fetch;

function metrics(result: Awaited<ReturnType<SpedConnector['collect']>>) {
  return result.metadata?.sped as Record<string, unknown>;
}

function state(result: Awaited<ReturnType<SpedConnector['collect']>>): SpedSourceState {
  return result.metadata?.spedState as SpedSourceState;
}

function publicationGate(result: Awaited<ReturnType<SpedConnector['collect']>>) {
  const repub = result.publications.find((publication) =>
    publication.metadata?.documentFamily === 'EFD-Reinf NT 01/2026' &&
    publication.metadata?.republication === true
  );
  return repub
    ? {
        title: repub.title,
        externalId: repub.externalId,
        fileCount: repub.files?.length ?? 0,
        linkedArtifactExternalIds: repub.metadata?.linkedArtifactExternalIds ?? null,
        fileHashes: repub.files?.map((file) => file.rawSha256) ?? [],
      }
    : null;
}

async function run(
  label: string,
  now: Date,
  previousState?: SpedSourceState,
  overrides: { revisitAfterMs?: number; maxRechecksPerRun?: number } = {},
): Promise<Awaited<ReturnType<SpedConnector['collect']>>> {
  const beforeTotal = requestCount;
  const beforeHtml = htmlRequestCount;
  const beforeFile = fileRequestCount;
  const started = Date.now();

  const connector = new SpedConnector({
    fetch: transportFetch,
    now: () => now,
    ...(previousState ? { readState: async () => previousState } : {}),
    ...(overrides.revisitAfterMs !== undefined ? { revisitAfterMs: overrides.revisitAfterMs } : {}),
    ...(overrides.maxRechecksPerRun !== undefined ? { maxRechecksPerRun: overrides.maxRechecksPerRun } : {}),
    client: {
      timeoutMs: 30_000,
      maxFileBytes: 160 * 1024 * 1024,
    },
  });

  const result = await connector.collect({
    ...CONTEXT_BASE,
    signal: AbortSignal.timeout(25 * 60 * 1_000),
  });

  console.error('SPED_REAL_CONNECTOR=' + JSON.stringify({
    label,
    durationMs: Date.now() - started,
    requests: requestCount - beforeTotal,
    htmlRequests: htmlRequestCount - beforeHtml,
    fileRequests: fileRequestCount - beforeFile,
    publications: result.publications.length,
    partialFailures: result.partialFailures?.length ?? 0,
    partialFailureDetails: (result.partialFailures ?? []).map((failure) => ({
      code: failure.code,
      message: failure.message,
      itemReference: failure.itemReference ?? null,
    })),
    metrics: metrics(result),
    statePages: Object.keys(state(result).pages ?? {}).length,
    stateFiles: Object.keys(state(result).items ?? {}).length,
    reinfRepublication: publicationGate(result),
  }));

  return result;
}

console.error('SPED_REAL_CONNECTOR_START=' + JSON.stringify({
  at: new Date().toISOString(),
}));

const bootstrap = await run(
  'BOOTSTRAP',
  new Date('2026-09-22T13:00:00Z'),
);

const hourly = await run(
  'PLUS_1H',
  new Date('2026-09-22T14:00:00Z'),
  state(bootstrap),
);

const aged = await run(
  'PLUS_25H',
  new Date('2026-09-23T14:00:00Z'),
  state(hourly),
);

console.error('SPED_REAL_CONNECTOR_DONE=' + JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalRequests: requestCount,
  totalHtmlRequests: htmlRequestCount,
  totalFileRequests: fileRequestCount,
  bootstrapStatePages: Object.keys(state(bootstrap).pages ?? {}).length,
  hourlyStatePages: Object.keys(state(hourly).pages ?? {}).length,
  agedStatePages: Object.keys(state(aged).pages ?? {}).length,
}));
