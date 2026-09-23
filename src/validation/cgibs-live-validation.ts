import { CgibsConnector, type CgibsSourceState } from '../modules/collection/cgibs.connector.js';

const sourceId = '00000000-0000-4000-8000-00000000c91b';

const tracedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  const startedAt = Date.now();
  console.log('CGIBS_HTTP_START=' + url);
  try {
    const response = await fetch(input, init);
    console.log('CGIBS_HTTP_DONE=' + JSON.stringify({
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      contentLength: response.headers.get('content-length'),
      contentType: response.headers.get('content-type'),
    }));
    return response;
  } catch (error) {
    console.error('CGIBS_HTTP_ERROR=' + JSON.stringify({
      url,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
};

function asciiUpper(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function context(runId: string) {
  return {
    sourceId,
    runId,
    attemptId: runId.replace(/.$/, 'a'),
    signal: new AbortController().signal,
  };
}

function requireGate(publications: Awaited<ReturnType<CgibsConnector['collect']>>['publications'], label: string, predicate: (title: string, metadata: Record<string, unknown>) => boolean): void {
  const matches = publications.filter((item) => predicate(asciiUpper(item.title), item.metadata ?? {}));
  if (!matches.length) throw new Error('CGIBS live gate missing: ' + label);
  console.log('CGIBS_LIVE_GATE_' + label.replace(/[^A-Z0-9]+/gi, '_').toUpperCase() + '=' + JSON.stringify(matches.map((item) => ({
    title: item.title,
    actType: item.actType,
    actNumber: item.actNumber,
    publishedAt: item.publishedAt?.toISOString().slice(0, 10),
    officialUrl: item.officialUrl,
    externalId: item.externalId,
    files: item.files?.map((file) => ({
      url: file.url,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      rawSha256: file.rawSha256,
    })) ?? [],
    metadata: item.metadata,
  }))));
}

const first = await new CgibsConnector({
  fetch: tracedFetch,
  maxRechecksPerRun: 100,
  maxDetailPagesPerRun: 200,
}).collect(context('10000000-0000-4000-8000-000000000001'));

const familyCounts = new Map<string, number>();
let fileCount = 0;
let validShaCount = 0;
for (const publication of first.publications) {
  const family = String(publication.metadata?.family ?? 'UNKNOWN');
  familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  for (const file of publication.files ?? []) {
    fileCount += 1;
    if (file.rawSha256 && /^[a-f0-9]{64}$/.test(file.rawSha256)) validShaCount += 1;
  }
}

console.log('CGIBS_LIVE_FIRST=' + JSON.stringify({
  publicationCount: first.publications.length,
  fileCount,
  validShaCount,
  partialFailureCount: first.partialFailures?.length ?? 0,
  partialFailures: first.partialFailures ?? [],
  familyCounts: Object.fromEntries([...familyCounts.entries()].sort()),
  metadata: first.metadata,
}));

requireGate(first.publications, 'RESOLUTION_2_2026', (_title, metadata) =>
  String(metadata.normativeKey ?? '') === 'CGIBS|ACT|RESOLUCAO_CGIBS|2_2026',
);
requireGate(first.publications, 'RESOLUTION_3_2026', (_title, metadata) =>
  String(metadata.normativeKey ?? '') === 'CGIBS|ACT|RESOLUCAO_CGIBS|3_2026',
);
requireGate(first.publications, 'RESOLUTION_6_2026', (_title, metadata) =>
  String(metadata.normativeKey ?? '') === 'CGIBS|ACT|RESOLUCAO_CGIBS|6_2026',
);
requireGate(first.publications, 'RESOLUTION_18_2026', (_title, metadata) =>
  String(metadata.normativeKey ?? '') === 'CGIBS|ACT|RESOLUCAO_CGIBS|18_2026',
);
requireGate(first.publications, 'PORTARIA', (title, metadata) =>
  title.includes('PORTARIA') || String(metadata.family ?? '') === 'PORTARIAS',
);
requireGate(first.publications, 'JOINT_ACT', (title, metadata) =>
  title.includes('ATO CONJUNTO') || String(metadata.family ?? '') === 'JOINT_ACTS',
);
requireGate(first.publications, 'JOINT_TECHNICAL_ACT', (title, metadata) =>
  title.includes('ATO TECNICO CONJUNTO') || String(metadata.family ?? '') === 'JOINT_TECHNICAL_ACTS',
);
requireGate(first.publications, 'DERE_1_2_0', (title, metadata) =>
  title.includes('DERE') && String(metadata.officialVersion ?? '') === '1.2.0',
);
requireGate(first.publications, 'DERE_XSD', (title, metadata) =>
  title.includes('XSD') &&
  String(metadata.listingOrPageUrl ?? '').includes('declaracao-de-regimes-especificos-dere'),
);
requireGate(first.publications, 'NOTA_ORIENTATIVA_2026_001', (title, metadata) =>
  (title.includes('NOTA ORIENTATIVA') && title.includes('2026')) ||
  String(metadata.documentFamily ?? '').includes('2026.001'),
);
requireGate(first.publications, 'SPLIT_PAYMENT', (title) => title.includes('SPLIT PAYMENT'));
requireGate(first.publications, 'OPENAPI_1_1_0', (title, metadata) =>
  title.includes('OPENAPI') && String(metadata.officialVersion ?? '') === '1.1.0',
);

if (!fileCount || validShaCount !== fileCount) {
  throw new Error(`CGIBS live file SHA gate failed: ${validShaCount}/${fileCount}`);
}
if ((first.partialFailures?.length ?? 0) > 0) {
  throw new Error('CGIBS live collection returned partial failures.');
}

const state = first.checkpoint?.state as unknown as CgibsSourceState;
if (!state || !Object.keys(state.items).length) throw new Error('CGIBS live checkpoint is empty.');

const replay = await new CgibsConnector({
  fetch: tracedFetch,
  readState: async () => state,
  maxRechecksPerRun: 100,
  maxDetailPagesPerRun: 200,
}).collect(context('10000000-0000-4000-8000-000000000002'));

const replayMeta = (replay.metadata as { cgibs?: Record<string, unknown> } | undefined)?.cgibs ?? {};
console.log('CGIBS_LIVE_REPLAY=' + JSON.stringify({
  publicationCount: replay.publications.length,
  partialFailureCount: replay.partialFailures?.length ?? 0,
  metadata: replay.metadata,
}));

if ((replay.partialFailures?.length ?? 0) > 0) throw new Error('CGIBS replay returned partial failures.');
if (Number(replayMeta.downloadedCount ?? -1) !== 0) throw new Error('CGIBS replay downloaded known files.');
if (replay.publications.length !== first.publications.length) throw new Error('CGIBS replay publication inventory changed unexpectedly.');

console.log('CGIBS_LIVE_OK=1');
