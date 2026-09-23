import assert from 'node:assert/strict';
import test from 'node:test';

import { CgibsConnector, type CgibsSourceState } from '../src/modules/collection/cgibs.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
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
  assert.equal(new Set(normalized.map((item) => item.identityHash)).size, normalized.length);
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
