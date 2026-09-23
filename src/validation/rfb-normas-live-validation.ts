import { RfbNormasConnector } from '../modules/collection/rfb-normas.connector.js';

const sourceId = '00000000-0000-4000-8000-00000000f8b0';
let requestCount = 0;

const tracedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  const startedAt = Date.now();
  requestCount += 1;
  console.log('RFB_NORMAS_HTTP_START=' + url);
  try {
    const response = await fetch(input, init);
    console.log('RFB_NORMAS_HTTP_DONE=' + JSON.stringify({
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
    }));
    return response;
  } catch (error) {
    console.error('RFB_NORMAS_HTTP_ERROR=' + JSON.stringify({
      url,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
};

const result = await new RfbNormasConnector({
  fetch: tracedFetch,
  readState: async () => ({
    bootstrap: { complete: true, month: '2026-09', page: 1 },
    files: {},
  }),
  lookbackDays: 7,
  now: () => new Date(),
}).collect({
  sourceId,
  runId: '10000000-0000-4000-8000-000000000001',
  attemptId: '20000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
});

const metadata = (result.metadata as { rfbNormas?: Record<string, unknown> } | undefined)?.rfbNormas ?? {};
const acts = result.publications.map((publication) => ({
  title: publication.title,
  agency: publication.agency,
  actType: publication.actType,
  actNumber: publication.actNumber,
  publishedAt: publication.publishedAt?.toISOString().slice(0, 10),
  externalId: publication.externalId,
  officialUrl: publication.officialUrl,
  category: publication.metadata?.captureCategory,
  reason: publication.metadata?.captureReason,
  representations: (publication.metadata?.rfbNormas as Record<string, unknown> | undefined)?.representations,
  files: publication.files?.map(file => ({
    url: file.url,
    rawSha256: file.rawSha256,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType,
  })) ?? [],
}));

console.log('RFB_NORMAS_LIVE_RESULT=' + JSON.stringify({
  publicationCount: result.publications.length,
  partialFailureCount: result.partialFailures?.length ?? 0,
  partialFailures: result.partialFailures ?? [],
  metadata,
  acts,
  requestCount,
}));

if ((result.partialFailures?.length ?? 0) > 0) {
  throw new Error('RFB Normas live validation returned partial failures.');
}

const filtering = (metadata.filtering ?? {}) as Record<string, unknown>;
const discovered = Number(filtering.discoveredCount ?? 0);
const included = Number(filtering.includedCount ?? 0);
const excluded = Number(filtering.excludedCount ?? 0);
if (discovered < 1) throw new Error('RFB Normas live search discovered no acts in the configured lookback.');
if (discovered !== included + excluded) {
  throw new Error('RFB Normas live filtering counters do not reconcile.');
}
if (!result.publications.some(p => p.agency === 'COSIT' && p.actType === 'SOLUÇÃO DE CONSULTA')) {
  console.log('RFB_NORMAS_LIVE_NOTE=no COSIT solution found in current 7-day window');
}

for (const publication of result.publications) {
  const representations =
    (publication.metadata?.rfbNormas as { representations?: Record<string, Record<string, unknown>> } | undefined)?.representations;
  const original = representations?.original;
  if (!original || original.available !== true || typeof original.normalizedHash !== 'string') {
    throw new Error('Included act is missing a hashed original representation: ' + publication.externalId);
  }
}

console.log('RFB_NORMAS_LIVE_OK=1');
