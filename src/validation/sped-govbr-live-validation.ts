import { SpedConnector, type SpedSourceState } from '../modules/collection/sped.connector.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function summary(result: Awaited<ReturnType<SpedConnector['collect']>>) {
  return result.publications.map((publication) => ({
    title: publication.title,
    externalId: publication.externalId,
    identityKey: publication.identityKey,
    publishedAt: publication.publishedAt?.toISOString().slice(0, 10),
    officialUrl: publication.officialUrl,
    module: publication.metadata?.module,
    documentKind: publication.metadata?.documentKind,
    documentFamily: publication.metadata?.documentFamily,
    documentNumber: publication.metadata?.documentNumber,
    officialVersion: publication.metadata?.officialVersion,
    revisionKind: publication.metadata?.revisionKind,
    sourceCreatedAt: publication.metadata?.sourceCreatedAt,
    fileCount: publication.files?.length ?? 0,
    files: (publication.files ?? []).map((file) => ({
      url: file.url,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      rawSha256: file.rawSha256,
      etag: file.sourceEtag,
      lastModified: file.sourceLastModified,
    })),
  }));
}

function gateChecks(publications: ReturnType<typeof summary>) {
  const matches = (regex: RegExp) =>
    publications.filter((publication) =>
      regex.test(
        [
          publication.title,
          publication.documentFamily,
          publication.documentNumber,
          publication.officialVersion,
        ].filter(Boolean).join(' '),
      ),
    );

  return {
    efdIcsmIpiGuide324: matches(/EFD.*ICMS.*IPI.*3\.2\.4|GUIA.*3\.2\.4/i),
    efdContribNt11: matches(/(?:NOTA T[EÉ]CNICA|NT).*11[\/_ -]?2026|NT 11\/2026/i),
    efdContribNt12: matches(/(?:NOTA T[EÉ]CNICA|NT).*12[\/_ -]?2026|NT 12\/2026/i),
    reinfTechnical: publications.filter((publication) =>
      publication.module === 'EFD_REINF' &&
      ['TECHNICAL_NOTE', 'XSD_SCHEMA', 'LAYOUT'].includes(String(publication.documentKind)),
    ),
    dere120: publications.filter((publication) =>
      publication.module === 'DERE' &&
      /1\.2\.0/.test(
        [
          publication.title,
          publication.documentFamily,
          publication.officialVersion,
        ].filter(Boolean).join(' '),
      ),
    ),
  };
}

function assertFiles(publications: ReturnType<typeof summary>): void {
  const bad = publications
    .flatMap((publication) =>
      publication.files.map((file) => ({ publication: publication.title, ...file })),
    )
    .filter((file) =>
      !file.url.startsWith('https://www.gov.br/sped/pt-br/') ||
      !/^[a-f0-9]{64}$/.test(file.rawSha256 ?? '') ||
      !Number.isSafeInteger(file.sizeBytes) ||
      (file.sizeBytes ?? 0) <= 0,
    );

  if (bad.length > 0) {
    console.error('SPED_GOVBR_BAD_FILES=' + JSON.stringify(bad));
    throw new Error('One or more gov.br files failed URL/hash/size validation.');
  }
}

const first = await new SpedConnector({
  maxCrawlDepth: 8,
  maxPagesPerModule: 1000,
  revisitAfterMs: 24 * 60 * 60 * 1000,
  maxRechecksPerRun: 32,
}).collect(CONTEXT);

const publications = summary(first);
const gates = gateChecks(publications);

console.error('SPED_GOVBR_LIVE_FIRST=' + JSON.stringify({
  metadata: first.metadata?.sped,
  partialFailureCount: first.partialFailures?.length ?? 0,
  publicationCount: publications.length,
  fileCount: publications.reduce((sum, publication) => sum + publication.files.length, 0),
}));

const gateEvidence = Object.fromEntries(
  Object.entries(gates).map(([key, values]) => [
    key,
    values.map((value) => ({
      title: value.title,
      officialUrl: value.officialUrl,
      documentFamily: value.documentFamily,
      documentNumber: value.documentNumber,
      officialVersion: value.officialVersion,
      sourceCreatedAt: value.sourceCreatedAt,
      files: value.files.map((file) => ({
        url: file.url,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        rawSha256: file.rawSha256,
      })),
    })),
  ]),
);
console.error('SPED_GOVBR_LIVE_GATES=' + JSON.stringify(gateEvidence));

assertFiles(publications);

const missing = Object.entries(gates)
  .filter(([, values]) => values.length === 0)
  .map(([key]) => key);

if (missing.length > 0) {
  throw new Error('Missing required gov.br SPED gates: ' + missing.join(', '));
}

if ((first.partialFailures?.length ?? 0) > 0) {
  throw new Error('Live gov.br collection returned partial failures.');
}

const state = first.checkpoint?.state as SpedSourceState | undefined;
if (!state) throw new Error('Live gov.br collection did not return checkpoint state.');

const second = await new SpedConnector({
  maxCrawlDepth: 8,
  maxPagesPerModule: 1000,
  revisitAfterMs: 24 * 60 * 60 * 1000,
  maxRechecksPerRun: 32,
  readState: async () => state,
}).collect({
  ...CONTEXT,
  runId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
});

console.error('SPED_GOVBR_LIVE_REPLAY=' + JSON.stringify({
  metadata: second.metadata?.sped,
  partialFailures: second.partialFailures ?? [],
  publicationCount: second.publications.length,
  skippedKnownDocumentCount:
    (second.metadata?.sped as { skippedKnownDocumentCount?: number } | undefined)
      ?.skippedKnownDocumentCount ?? 0,
}));

if (second.publications.length !== 0) {
  throw new Error('Immediate replay was not idempotent.');
}
if ((second.metadata?.sped as { downloadedCount?: number } | undefined)?.downloadedCount !== 0) {
  throw new Error('Immediate replay redownloaded files.');
}
if ((second.partialFailures?.length ?? 0) > 0) {
  throw new Error('Immediate replay returned partial failures.');
}

console.error('SPED_GOVBR_LIVE_OK=1');
