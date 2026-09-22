import { SpedConnector } from '../modules/collection/sped.connector.js';

const OFFICIAL = 'https://sped.rfb.gov.br';
const TRANSPORT = 'http://sped.rfb.gov.br';
const ALLOWED_FILE_ID = '8070';

function normalizeLocation(value: string | null, base: string): string | null {
  if (!value) return null;
  const next = new URL(value, base);
  if (next.hostname.toLowerCase() === 'sped.rfb.gov.br') {
    next.protocol = 'https:';
    return next.toString();
  }
  return value;
}

const diagnosticFetch: typeof fetch = async (input, init) => {
  const requested = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url,
  );

  if (requested.origin !== OFFICIAL) {
    return fetch(input, init);
  }

  const blockedNonReinfRoots = new Set([
    '/projeto/show/274',
    '/item/show/1573',
    '/destaques/show/7',
    '/projeto/show/268',
    '/item/show/1545',
    '/destaques/show/285',
    '/pagina/show/7950',
  ]);
  if (blockedNonReinfRoots.has(requested.pathname)) {
    return new Response('diagnostic module blocked', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const downloadId = /\/arquivo\/download\/(\d+)/i.exec(requested.pathname)?.[1];
  if (downloadId && downloadId !== ALLOWED_FILE_ID) {
    return new Response('diagnostic file blocked', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const transport = new URL(requested);
  transport.protocol = 'http:';
  const response = await fetch(transport, {
    ...init,
    redirect: 'manual',
  });
  const headers = new Headers(response.headers);
  const location = normalizeLocation(headers.get('location'), transport.toString());
  if (location) headers.set('location', location);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const connector = new SpedConnector({
  fetch: diagnosticFetch,
  maxPagesPerModule: 50,
  maxCrawlDepth: 3,
  revisitAfterMs: 24 * 60 * 60 * 1000,
  maxRechecksPerRun: 0,
});

const controller = new AbortController();
const result = await connector.collect({
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: controller.signal,
});

const republished = result.publications.find(
  (publication) => publication.externalId === 'pagina:8129',
);
const duplicateArtifact = result.publications.find(
  (publication) => publication.externalId === 'arquivo:8070',
);

console.log('SPED_CONNECTOR_LIVE_CHECK=' + JSON.stringify({
  publicationCount: result.publications.length,
  partialFailureCount: result.partialFailures?.length ?? 0,
  moduleResults: (result.metadata?.sped as { moduleResults?: unknown })?.moduleResults ?? null,
  republication: republished
    ? {
        title: republished.title,
        externalId: republished.externalId,
        actNumber: republished.actNumber ?? null,
        files: republished.files?.map((file) => ({
          externalId: file.externalId ?? null,
          rawSha256: file.rawSha256 ?? null,
          sizeBytes: file.sizeBytes ?? null,
          mimeType: file.mimeType ?? null,
          url: file.url,
        })) ?? [],
        linkedArtifactExternalIds:
          republished.metadata?.linkedArtifactExternalIds ?? null,
      }
    : null,
  duplicateArtifactPresent: Boolean(duplicateArtifact),
}));
