import assert from 'node:assert/strict';
import test from 'node:test';

import { RfbNormasConnector, type RfbNormasSourceState } from '../src/modules/collection/rfb-normas.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import {
  ADE_ORIGINAL,
  IN_MULTIVIGENTE,
  IN_ORIGINAL,
  IN_RELACIONAL,
  IN_VIGENTE,
  OPTIONAL_EMPTY,
  RFB_EMPTY_FIXTURE,
  RFB_SEARCH_FIXTURE,
  SC_ORIGINAL,
  pdfBytes,
} from './rfb-normas.fixtures.js';

const CONTEXT = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
};

function portal(options: { changedVigente?: boolean } = {}) {
  let fileDownloads = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith('/consulta.action')) {
      return new Response(RFB_SEARCH_FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.endsWith('/imprimir.action')) {
      const id = url.searchParams.get('idAto');
      const view = url.searchParams.get('visao');
      if (id === '150001') {
        const body =
          view === 'original' ? IN_ORIGINAL :
          view === 'vigente' ? (options.changedVigente ? IN_VIGENTE.replace('Texto vigente consolidado.', 'Texto vigente consolidado alterado.') : IN_VIGENTE) :
          view === 'anotado' ? IN_MULTIVIGENTE :
          view === 'relacional' ? IN_RELACIONAL :
          OPTIONAL_EMPTY;
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (id === '150002') {
        return new Response(view === 'original' ? SC_ORIGINAL : OPTIONAL_EMPTY, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (id === '150005') {
        return new Response(view === 'original' ? ADE_ORIGINAL : OPTIONAL_EMPTY, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('missing', { status: 404 });
    }
    if (url.pathname.endsWith('/anexoOutros.action')) {
      fileDownloads += 1;
      return new Response(pdfBytes('SC 180'), {
        status: 200,
        headers: { 'content-type': 'application/pdf', etag: '"sc-180-v1"' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { fetch: fetchImpl, fileDownloads: () => fileDownloads };
}

function incrementalState(files: RfbNormasSourceState['files'] = {}): RfbNormasSourceState {
  return {
    bootstrap: { complete: true, month: '2026-09', page: 1 },
    files,
  };
}

test('collects deterministic scope and reports discovered/included/excluded reasons', async () => {
  const fake = portal();
  const result = await new RfbNormasConnector({
    fetch: fake.fetch,
    readState: async () => incrementalState(),
    now: () => new Date('2026-09-23T15:00:00Z'),
    lookbackDays: 7,
  }).collect(CONTEXT);

  assert.equal(result.publications.length, 3);
  const meta = (result.metadata as any).rfbNormas;
  assert.equal(meta.filtering.discoveredCount, 5);
  assert.equal(meta.filtering.includedCount, 3);
  assert.equal(meta.filtering.excludedCount, 2);
  assert.equal(meta.filtering.excludedByReason.PORTARIA_ADMINISTRATIVE, 1);
  assert.equal(meta.filtering.excludedByReason.ADE_LOW_VALUE_CERTIFICATION, 1);
  assert.equal(meta.lookbackDays, 7);

  const instruction = result.publications.find(p => p.actType === 'INSTRUÇÃO NORMATIVA');
  assert.ok(instruction);
  assert.equal(instruction.agency, 'RFB');
  assert.equal(instruction.actNumber, '2344/2026');
  assert.equal(instruction.externalId, '150001');
  assert.equal(instruction.metadata?.sourceRole, 'ENRICHMENT');
  assert.equal((instruction.metadata?.rfbNormas as any).representations.original.normalizedHash.length, 64);

  const sc = result.publications.find(p => p.actType === 'SOLUÇÃO DE CONSULTA');
  assert.ok(sc);
  assert.equal(sc.files?.length, 1);
  assert.equal(fake.fileDownloads(), 1);
});

test('immediate replay reuses known attachments and creates no content hash change', async () => {
  const firstPortal = portal();
  const first = await new RfbNormasConnector({
    fetch: firstPortal.fetch,
    readState: async () => incrementalState(),
    now: () => new Date('2026-09-23T15:00:00Z'),
  }).collect(CONTEXT);

  const state = first.checkpoint!.state as unknown as RfbNormasSourceState;
  const replayPortal = portal({ changedVigente: true });
  const replay = await new RfbNormasConnector({
    fetch: replayPortal.fetch,
    readState: async () => state,
    now: () => new Date('2026-09-23T15:05:00Z'),
  }).collect(CONTEXT);

  assert.equal(replayPortal.fileDownloads(), 0);
  assert.equal(replay.publications.length, first.publications.length);

  const firstInstruction = first.publications.find(p => p.actType === 'INSTRUÇÃO NORMATIVA')!;
  const replayInstruction = replay.publications.find(p => p.actType === 'INSTRUÇÃO NORMATIVA')!;
  const firstNormalized = normalizePublication({ sourceId: CONTEXT.sourceId, publication: firstInstruction });
  const replayNormalized = normalizePublication({ sourceId: CONTEXT.sourceId, publication: replayInstruction });
  assert.equal(firstNormalized.contentHash, replayNormalized.contentHash, 'consolidated representation must not change publication content hash');

  const firstVigente = ((firstInstruction.metadata?.rfbNormas as any).representations.vigente.normalizedHash);
  const replayVigente = ((replayInstruction.metadata?.rfbNormas as any).representations.vigente.normalizedHash);
  assert.notEqual(firstVigente, replayVigente, 'representation hash must detect consolidated change');
});

test('successful empty search returns zero publications, unavailable source throws', async () => {
  const empty = new RfbNormasConnector({
    fetch: (async () => new Response(RFB_EMPTY_FIXTURE, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch,
    readState: async () => incrementalState(),
    now: () => new Date('2026-09-23T15:00:00Z'),
  });
  const result = await empty.collect(CONTEXT);
  assert.equal(result.publications.length, 0);
  assert.equal((result.metadata as any).rfbNormas.filtering.discoveredCount, 0);

  const down = new RfbNormasConnector({
    fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
    readState: async () => incrementalState(),
    now: () => new Date('2026-09-23T15:00:00Z'),
  });
  await assert.rejects(down.collect(CONTEXT));
});

test('bootstrap starts in 2025 and can stop safely on time budget', async () => {
  const seen: string[] = [];
  const connector = new RfbNormasConnector({
    fetch: (async (input) => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith('/consulta.action')) {
        seen.push(url.searchParams.get('dt_inicio') ?? '');
        return new Response(RFB_EMPTY_FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('missing', { status: 404 });
    }) as typeof fetch,
    now: () => new Date('2025-02-10T15:00:00Z'),
  });
  const result = await connector.collect(CONTEXT);
  assert.deepEqual(seen, ['01/01/2025', '01/02/2025']);
  const state = result.checkpoint!.state as unknown as RfbNormasSourceState;
  assert.equal(state.bootstrap.complete, true);
});


test('incremental lookback uses America/Sao_Paulo date at UTC midnight boundary', async () => {
  const searches: URL[] = [];
  const connector = new RfbNormasConnector({
    fetch: (async (input) => {
      const url = new URL(input.toString());
      searches.push(url);
      return new Response(RFB_EMPTY_FIXTURE, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch,
    readState: async () => incrementalState(),
    now: () => new Date('2026-09-24T00:08:45Z'),
    lookbackDays: 7,
  });
  await connector.collect(CONTEXT);
  assert.equal(searches.length, 1);
  assert.equal(searches[0]!.searchParams.get('dt_inicio'), '17/09/2026');
  assert.equal(searches[0]!.searchParams.get('dt_fim'), '23/09/2026');
});
