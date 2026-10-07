import assert from 'node:assert/strict';
import test from 'node:test';

import { CgibsConnector, type CgibsSourceState } from '../src/modules/collection/cgibs.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { legacyPdfFixture } from './doe-sp-legacy.pdf-fixtures.js';
import {
  CGIBS,
  bookletsHtml,
  communiqueDetailHtml,
  communiquesHtml,
  dereHtml,
  emptyContainer,
  guidesHtml,
  jointActsHtml,
  jointTechnicalActsHtml,
  newsHtml,
  operationalNewsDetailHtml,
  pdf,
  portariasHtml,
  regulationsHtml,
  resolutionsHtml,
  splitPaymentHtml,
  technicalIndexHtml,
  zip,
} from './cgibs.fixtures.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function portal(options: { failPath?: string; generation?: number } = {}) {
  let fileRequests = 0;
  const pages = new Map<string, string>([
    ['/resolucoes', resolutionsHtml],
    ['/regulamentos', regulationsHtml],
    ['/portarias', portariasHtml],
    ['/atos-conjuntos', jointActsHtml],
    ['/atos-tecnicos-conjuntos', jointTechnicalActsHtml],
    ['/comunicados-oficiais', communiquesHtml],
    ['/documentos-tecnicos', technicalIndexHtml],
    ['/declaracao-de-regimes-especificos-dere', dereHtml],
    ['/split-payment', splitPaymentHtml],
    ['/guias', guidesHtml],
    ['/cartilhas', bookletsHtml],
    ['/noticias', newsHtml],
    ['/comunicado-oficial-01-2025', communiqueDetailHtml],
    ['/noticia-atualizacao-xsd-dere', operationalNewsDetailHtml],
  ]);

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString(), CGIBS);
    if (options.failPath && url.pathname === options.failPath) {
      return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } });
    }
    const page = pages.get(url.pathname);
    if (page !== undefined) return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (/\/upload\/arquivos\//.test(url.pathname)) {
      fileRequests += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const generation = options.generation ?? 1;
      const tag = `"${url.pathname}-g${generation}"`;
      if (headers['if-none-match'] === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      const isZip = url.pathname.endsWith('.zip');
      const bytes = isZip ? zip(url.pathname + '-g' + generation) : pdf(url.pathname + '-g' + generation);
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': isZip ? 'application/zip' : 'application/pdf',
          etag: tag,
        },
      });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;

  return { fetch: fetchImpl, getFileRequests: () => fileRequests };
}

test('collects all official families, deduplicates the same Resolution PDF and captures page-only communication', async () => {
  const fake = portal();
  const result = await new CgibsConnector({ fetch: fake.fetch }).collect(CONTEXT);

  assert.equal(result.partialFailures?.length ?? 0, 0);
  assert.ok(result.publications.length >= 12);
  const resolution6 = result.publications.filter((item) =>
    item.actNumber === '6/2026' && item.actType === 'RESOLUÇÃO CGIBS',
  );
  assert.equal(resolution6.length, 1, 'the Regulation rediscovery must not duplicate Resolution 6');

  const communication = result.publications.find((item) => item.actNumber === '01/2025');
  assert.ok(communication);
  assert.equal(communication.files?.length ?? 0, 0);

  const dere120 = result.publications.filter((item) =>
    item.metadata?.officialVersion === '1.2.0' && /DeRE|Leiautes|XSD/.test(item.title),
  );
  assert.ok(dere120.length >= 2);

  const normalized = result.publications.map((publication) => normalizePublication({
    sourceId: CONTEXT.sourceId,
    publication,
  }));
  const duplicateIdentities = [...normalized.reduce((groups, item, index) => {
    const key = item.identityHash;
    groups.set(key, [...(groups.get(key) ?? []), result.publications[index]!.title + ' @ ' + result.publications[index]!.officialUrl]);
    return groups;
  }, new Map<string, string[]>()).entries()].filter(([, members]) => members.length > 1);
  assert.equal(
    new Set(normalized.map((item) => item.identityHash)).size,
    normalized.length,
    'duplicate CGIBS identities: ' + JSON.stringify(duplicateIdentities),
  );
});

test('immediate replay reuses file checkpoint and performs no file downloads', async () => {
  const firstPortal = portal();
  const first = await new CgibsConnector({
    fetch: firstPortal.fetch,
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  assert.ok(firstPortal.getFileRequests() > 0);

  const state = first.checkpoint!.state as unknown as CgibsSourceState;
  const replayPortal = portal();
  const replay = await new CgibsConnector({
    fetch: replayPortal.fetch,
    readState: async () => state,
    now: () => new Date('2026-09-23T12:05:00Z'),
  }).collect(CONTEXT);

  assert.equal(replayPortal.getFileRequests(), 0);
  assert.equal(replay.publications.length, first.publications.length);
  assert.equal(
    (replay.metadata as { cgibs: { reusedCheckpointCount: number } }).cgibs.reusedCheckpointCount,
    Object.keys(state.items).length,
  );
  const firstHashes = first.publications.map((p) => normalizePublication({ sourceId: CONTEXT.sourceId, publication: p }).contentHash).sort();
  const replayHashes = replay.publications.map((p) => normalizePublication({ sourceId: CONTEXT.sourceId, publication: p }).contentHash).sort();
  assert.deepEqual(replayHashes, firstHashes);
});

test('real file-byte change after recheck changes only corresponding content hash', async () => {
  const firstPortal = portal({ generation: 1 });
  const first = await new CgibsConnector({
    fetch: firstPortal.fetch,
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const state = first.checkpoint!.state as unknown as CgibsSourceState;

  const changedPortal = portal({ generation: 2 });
  const changed = await new CgibsConnector({
    fetch: changedPortal.fetch,
    readState: async () => state,
    revisitAfterMs: 0,
    maxRechecksPerRun: 100,
    now: () => new Date('2026-09-23T13:00:00Z'),
  }).collect(CONTEXT);
  assert.ok(changedPortal.getFileRequests() > 0);

  const firstByKey = new Map(first.publications.map((p) => [
    p.externalId ?? p.officialUrl,
    normalizePublication({ sourceId: CONTEXT.sourceId, publication: p }).contentHash,
  ]));
  const changedByKey = new Map(changed.publications.map((p) => [
    p.externalId ?? p.officialUrl,
    normalizePublication({ sourceId: CONTEXT.sourceId, publication: p }).contentHash,
  ]));

  const changedKeys = [...changedByKey].filter(([key, hash]) => firstByKey.get(key) !== hash).map(([key]) => key);
  assert.ok(changedKeys.length > 0);
  assert.ok(changedKeys.every((key) => key.includes('/upload/arquivos/')));
});

test('one unavailable seed produces partial failure while successful seeds remain usable', async () => {
  const fake = portal({ failPath: '/portarias' });
  const result = await new CgibsConnector({ fetch: fake.fetch }).collect(CONTEXT);
  assert.ok(result.publications.length > 0);
  assert.ok((result.partialFailures?.length ?? 0) >= 1);
  assert.ok(result.partialFailures?.some((failure) => failure.itemReference?.endsWith('/portarias')));
});

test('all unavailable seeds produce SOURCE_UNAVAILABLE instead of SUCCESS_NO_RESULTS', async () => {
  const fetchImpl = (async () => new Response('down', {
    status: 503,
    headers: { 'content-type': 'text/html' },
  })) as typeof fetch;
  await assert.rejects(
    new CgibsConnector({ fetch: fetchImpl }).collect(CONTEXT),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CGIBS_ALL_SEEDS_FAILED');
      assert.equal((error as { kind?: string }).kind, 'SOURCE_UNAVAILABLE');
      return true;
    },
  );
});

test('successful empty source returns zero publications without marking source unavailable', async () => {
  const fetchImpl = (async () => new Response(emptyContainer, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })) as typeof fetch;
  const result = await new CgibsConnector({ fetch: fetchImpl }).collect(CONTEXT);
  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures?.length ?? 0, 0);
  assert.equal((result.metadata as { cgibs: { seedsSucceeded: number } }).cgibs.seedsSucceeded, 12);
});

// Issue: the CGIBS listing drives the derived identity (family, document
// family, version read from the title, restricted-production scope) while the
// origin is the stable file path. A reworded listing therefore asked
// persistence to move an origin to a new identity, which it refuses:
// "Publication origin is already linked to another publication identity."
const LEGACY_KEY = 'CGIBS|DOC|TECHNICAL_DOCUMENTS|MANUAL_LEGADO|SEM_VERSAO|GERAL';

/**
 * A file-anchored document that carries a derived identityKey, i.e. one the
 * listing text defines rather than a numbered act with a strong identity.
 * That is the shape the production conflict has (a versioned manual).
 */
function fileOrigin(publications: Array<{ externalId?: string; officialUrl: string; identityKey?: string }>): string {
  const match = publications.find(
    (p) => (p.externalId ?? p.officialUrl).includes('/upload/arquivos/') && p.identityKey !== undefined,
  );
  assert.ok(match, 'fixture must expose a file-anchored document with a derived identity');
  return match.externalId ?? match.officialUrl;
}

test('an origin keeps the identity it already owns when the listing would change it', async () => {
  const baseline = await new CgibsConnector({
    fetch: portal().fetch,
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const origin = fileOrigin(baseline.publications);
  const derived = baseline.publications.find((p) => (p.externalId ?? p.officialUrl) === origin)!.identityKey;
  assert.ok(derived && derived !== LEGACY_KEY);

  const kept = await new CgibsConnector({
    fetch: portal().fetch,
    readPersistedOrigins: async () => ({ identityKeys: { [origin]: LEGACY_KEY }, linked: new Set([origin]) }),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);

  const publication = kept.publications.find((p) => (p.externalId ?? p.officialUrl) === origin)!;
  assert.equal(publication.identityKey, LEGACY_KEY);
  assert.equal(
    normalizePublication({ sourceId: CONTEXT.sourceId, publication }).identityBasis.sourceKey,
    LEGACY_KEY,
    'the persisted identity is what reaches the database, so the write no longer conflicts',
  );
  assert.equal((publication.metadata as { normativeKey?: string }).normativeKey, LEGACY_KEY);
  assert.equal((kept.metadata as { cgibs: { keptIdentityCount: number } }).cgibs.keptIdentityCount, 1);

  // Every other origin still takes its derived identity.
  for (const other of kept.publications) {
    if ((other.externalId ?? other.officialUrl) === origin) continue;
    assert.notEqual(other.identityKey, LEGACY_KEY);
  }
});

test('the checkpoint carries the identity forward, so a replay never re-derives it', async () => {
  const first = await new CgibsConnector({
    fetch: portal().fetch,
    readPersistedOrigins: async () => {
      const seeded = await new CgibsConnector({ fetch: portal().fetch, now: () => new Date('2026-09-23T12:00:00Z') }).collect(CONTEXT);
      const seededOrigin = fileOrigin(seeded.publications);
      return { identityKeys: { [seededOrigin]: LEGACY_KEY }, linked: new Set([seededOrigin]) };
    },
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const origin = fileOrigin(first.publications);
  const state = first.checkpoint!.state as unknown as CgibsSourceState;
  assert.equal(state.items[origin]!.identityKey, LEGACY_KEY, 'checkpoint remembers the owned identity');

  // The database is no longer consulted: the checkpoint alone keeps it stable.
  const replay = await new CgibsConnector({
    fetch: portal().fetch,
    readState: async () => state,
    now: () => new Date('2026-09-23T12:05:00Z'),
  }).collect(CONTEXT);
  assert.equal(replay.publications.find((p) => (p.externalId ?? p.officialUrl) === origin)!.identityKey, LEGACY_KEY);
});

test('a brand-new origin still takes the identity derived from the listing', async () => {
  const run = await new CgibsConnector({
    fetch: portal().fetch,
    readPersistedOrigins: async () => ({ identityKeys: {}, linked: new Set<string>() }),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  assert.equal((run.metadata as { cgibs: { keptIdentityCount: number } }).cgibs.keptIdentityCount, 0);
  for (const publication of run.publications) {
    assert.ok(publication.identityKey === undefined || publication.identityKey.startsWith('CGIBS|'));
  }
});

// The committee publishes its acts as files, so without extraction a CGIBS
// publication carried a title and a link and no body: unreadable in the
// Acervo and invisible to content search.
function readablePortal() {
  const base = portal();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString(), CGIBS);
    if (/\/upload\/arquivos\/.*\.pdf$/i.test(url.pathname)) {
      const body = legacyPdfFixture({ text: `Texto oficial de ${url.pathname}` });
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'application/pdf' } });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return base.fetch(input, init);
  }) as typeof fetch;
  return fetchImpl;
}

test('a file-anchored act carries the text of its PDF', async () => {
  const run = await new CgibsConnector({
    fetch: readablePortal(),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);

  const withPdf = run.publications.filter((p) => (p.externalId ?? p.officialUrl).endsWith('.pdf'));
  assert.ok(withPdf.length > 0, 'fixture must publish PDF acts');
  for (const publication of withPdf) {
    assert.match(publication.content ?? '', /Texto oficial de/, `${publication.externalId} must carry its text`);
  }
  const state = run.checkpoint!.state as unknown as CgibsSourceState;
  for (const key of Object.keys(state.items)) {
    assert.ok(state.items[key]!.contentExtraction, 'every read file records how it was read');
  }
});

// Regression: the text comes from the downloaded bytes, so a run that reused
// the checkpoint had no text to send while the content hash covers the text.
// Re-emitting would have alternated between a body and no body, writing an
// empty version every other run.
test('an unchanged file is left alone instead of re-emitted without its text', async () => {
  const first = await new CgibsConnector({
    fetch: readablePortal(),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const state = first.checkpoint!.state as unknown as CgibsSourceState;
  const linked = new Set(Object.keys(state.items));

  const replay = await new CgibsConnector({
    fetch: readablePortal(),
    readState: async () => state,
    readPersistedOrigins: async () => ({ identityKeys: {}, linked }),
    now: () => new Date('2026-09-23T12:05:00Z'),
  }).collect(CONTEXT);

  const cgibs = (replay.metadata as { cgibs: { skippedUnchangedCount: number } }).cgibs;
  assert.equal(cgibs.skippedUnchangedCount, linked.size, 'every settled file is skipped');
  for (const publication of replay.publications) {
    assert.ok(
      !(publication.externalId ?? publication.officialUrl).endsWith('.pdf'),
      'no PDF act is re-emitted, so none can lose its body',
    );
  }
});

// An origin the database does not hold yet must be emitted even when its
// bytes are unchanged, otherwise a document that never landed never would.
test('an unchanged file whose origin was never persisted is still emitted', async () => {
  const first = await new CgibsConnector({
    fetch: readablePortal(),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const state = first.checkpoint!.state as unknown as CgibsSourceState;

  const replay = await new CgibsConnector({
    fetch: readablePortal(),
    readState: async () => state,
    readPersistedOrigins: async () => ({ identityKeys: {}, linked: new Set<string>() }),
    now: () => new Date('2026-09-23T12:05:00Z'),
  }).collect(CONTEXT);

  assert.equal((replay.metadata as { cgibs: { skippedUnchangedCount: number } }).cgibs.skippedUnchangedCount, 0);
  assert.equal(replay.publications.length, first.publications.length);
});

// The catalog collected before text extraction existed must gain its body,
// so a known file with no recorded extraction is fetched once regardless of
// the revisit window.
test('a file collected before extraction existed is read once, outside the revisit window', async () => {
  const first = await new CgibsConnector({
    fetch: readablePortal(),
    now: () => new Date('2026-09-23T12:00:00Z'),
  }).collect(CONTEXT);
  const legacyState: CgibsSourceState = {
    items: Object.fromEntries(
      Object.entries((first.checkpoint!.state as unknown as CgibsSourceState).items).map(([key, value]) => {
        const { contentExtraction: _dropped, ...withoutText } = value;
        return [key, withoutText];
      }),
    ),
  };

  const backfill = await new CgibsConnector({
    fetch: readablePortal(),
    readState: async () => legacyState,
    readPersistedOrigins: async () => ({ identityKeys: {}, linked: new Set(Object.keys(legacyState.items)) }),
    // Well inside the 24h window: only the missing text justifies the fetch.
    now: () => new Date('2026-09-23T12:05:00Z'),
  }).collect(CONTEXT);

  const cgibs = backfill.metadata as { cgibs: { recheckedKnownCount: number; skippedUnchangedCount: number } };
  assert.ok(cgibs.cgibs.recheckedKnownCount > 0, 'missing text forces a recheck');
  assert.equal(cgibs.cgibs.skippedUnchangedCount, 0, 'nothing is settled yet, so nothing is skipped');
  const pdfs = backfill.publications.filter((p) => (p.externalId ?? p.officialUrl).endsWith('.pdf'));
  assert.ok(pdfs.length > 0);
  for (const publication of pdfs) assert.match(publication.content ?? '', /Texto oficial de/);
});
