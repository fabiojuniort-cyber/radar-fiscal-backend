import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { NfeEncatConnector } from '../src/modules/collection/nfe-encat.connector.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';

const SOURCE_ID = '77777777-7777-4777-8777-777777777777';
const CONTEXT = {
  sourceId: SOURCE_ID,
  runId: '88888888-8888-4888-8888-888888888888',
  attemptId: '99999999-9999-4999-8999-999999999999',
  signal: new AbortController().signal,
};
const FIXTURE = new URL('./fixtures/nfe-encat/', import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE), 'utf8');
}

function emptyListing(): string {
  return '<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p></body></html>';
}

function oneNote(token = 'NT2025002V150%3D'): string {
  return `<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p><p><a href="exibirArquivo.aspx?conteudo=${token}"><span class="tituloConteudo">Nota Técnica 2025.002 v.1.50 - Publicada em 03/06/2026</span></a><br>Adequação RTC.</p></body></html>`;
}

function listingFamily(url: string): 'notes' | 'reports' | 'schemas' | 'manuals' | undefined {
  if (url.includes('04BIflQt1aY=')) return 'notes';
  if (url.includes('hXzemuyNHW4=')) return 'reports';
  if (url.includes('BMPFMBoln3w=')) return 'schemas';
  if (url.includes('ndIjl+iEFdE=')) return 'manuals';
  return undefined;
}

function headerRecord(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

test('collects four official families, keeps NT official versions as separate identities and filters other DF-e', async () => {
  const pages = {
    notes: await fixture('technical-notes.html'),
    reports: await fixture('technical-reports.html'),
    schemas: await fixture('schemas.html'),
    manuals: await fixture('manuals.html'),
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) return new Response(pages[family], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.includes('/exibirArquivo.aspx')) {
      const isZip = /SCHEMA/i.test(url);
      const bytes = isZip ? new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) : new TextEncoder().encode('%PDF-1.7\nfixture');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': isZip ? 'application/zip' : 'application/pdf',
          etag: `"${url.length}"`,
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const result = await new NfeEncatConnector({ fetch: fetchImpl }).collect(CONTEXT);
  assert.equal(result.partialFailures?.length ?? 0, 0);
  assert.equal(result.publications.some(publication => /NFGas|NFAg|NFCom/i.test(publication.title)), false);
  assert.ok(result.publications.some(publication => publication.actNumber === '2023.003 v1.30'));
  assert.ok(result.publications.some(publication => publication.actNumber === '2026.009 v1.00'));
  const rtc = result.publications.filter(publication => publication.metadata?.documentFamily === 'NT 2025.002');
  assert.equal(rtc.length, 2);
  const normalized = rtc.map(publication => normalizePublication({ sourceId: SOURCE_ID, publication }));
  assert.notEqual(normalized[0]?.identityHash, normalized[1]?.identityHash);
});

test('uses ETag/Last-Modified checkpoint, keeps content hash stable on 304 and changes it when bytes change for same token', async () => {
  let generation = 1;
  let conditionalSeen = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) {
      return new Response(family === 'notes' ? oneNote() : emptyListing(), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.includes('/exibirArquivo.aspx')) {
      const headers = headerRecord(init);
      if (generation === 2 && headers['if-none-match'] === '"v1"') {
        conditionalSeen = true;
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      const body = new TextEncoder().encode(`%PDF-1.7\ngeneration-${generation}`);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf', etag: generation === 3 ? '"v2"' : '"v1"' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const first = await new NfeEncatConnector({ fetch: fetchImpl }).collect(CONTEXT);
  const firstState = first.checkpoint?.state as { items: Record<string, any> };
  const firstNormalized = normalizePublication({ sourceId: SOURCE_ID, publication: first.publications[0]! });
  generation = 2;
  const second = await new NfeEncatConnector({ fetch: fetchImpl, readState: async () => firstState, revisitAfterMs: 0 }).collect(CONTEXT);
  const secondState = second.checkpoint?.state as { items: Record<string, any> };
  const secondNormalized = normalizePublication({ sourceId: SOURCE_ID, publication: second.publications[0]! });
  assert.equal(conditionalSeen, true);
  assert.equal(firstNormalized.identityHash, secondNormalized.identityHash);
  assert.equal(firstNormalized.contentHash, secondNormalized.contentHash);
  generation = 3;
  const third = await new NfeEncatConnector({ fetch: fetchImpl, readState: async () => secondState, revisitAfterMs: 0 }).collect(CONTEXT);
  const thirdNormalized = normalizePublication({ sourceId: SOURCE_ID, publication: third.publications[0]! });
  assert.equal(firstNormalized.identityHash, thirdNormalized.identityHash);
  assert.notEqual(firstNormalized.contentHash, thirdNormalized.contentHash);
});

test('one document download failure yields partial success material without dropping successful documents', async () => {
  const notes = `<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p>
<p><a href="exibirArquivo.aspx?conteudo=GOOD%3D"><span class="tituloConteudo">Nota Técnica 2026.009 v1.00 - Publicada em 09/09/2026</span></a><br>Boa.</p>
<p><a href="exibirArquivo.aspx?conteudo=BAD%3D"><span class="tituloConteudo">Nota Técnica 2023.003 v1.30 - Publicada em 29/07/2026</span></a><br>Falha.</p></body></html>`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) return new Response(family === 'notes' ? notes : emptyListing(), { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('BAD%3D') || url.includes('BAD=')) return new Response('temporary', { status: 503, headers: { 'content-type': 'text/html' } });
    return new Response(new TextEncoder().encode('%PDF-1.7\ngood'), { status: 200, headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
  const result = await new NfeEncatConnector({ fetch: fetchImpl }).collect(CONTEXT);
  assert.equal(result.publications.length, 1);
  assert.equal(result.publications[0]?.actNumber, '2026.009 v1.00');
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.itemReference, 'BAD=');
});

test('legitimate empty listings are distinct from a source that was not consulted successfully', async () => {
  const emptyFetch = (async () => new Response(emptyListing(), { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const empty = await new NfeEncatConnector({ fetch: emptyFetch }).collect(CONTEXT);
  assert.equal(empty.publications.length, 0);
  assert.equal(empty.partialFailures?.length ?? 0, 0);
  assert.equal((empty.metadata?.nfeEncat as { listingsSucceeded: number }).listingsSucceeded, 4);

  const unavailableFetch = (async () => new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  await assert.rejects(
    new NfeEncatConnector({ fetch: unavailableFetch }).collect(CONTEXT),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NFE_ENCAT_ALL_LISTINGS_FAILED');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});

test('changed schema ZIP under the same official token creates a new content hash without changing identity', async () => {
  let generation = 1;
  const schema = `<!doctype html><html><body><p class="tituloSessao">Versões em uso - Ambiente de Produção</p><p><a href="exibirArquivo.aspx?conteudo=SCHEMA-SAME%3D"><span class="tituloConteudo">Esquema XML NF-e/NFC-e - Pacote 010b - Publicado em 10/09/2026</span></a><br>Pacote oficial.</p></body></html>`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) return new Response(family === 'schemas' ? schema : emptyListing(), { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('/exibirArquivo.aspx')) {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, generation, 2, 3]);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/zip', etag: `"schema-${generation}"` } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const first = await new NfeEncatConnector({ fetch: fetchImpl }).collect(CONTEXT);
  const firstState = first.checkpoint?.state as { items: Record<string, any> };
  const normalizedFirst = normalizePublication({ sourceId: SOURCE_ID, publication: first.publications[0]! });
  generation = 2;
  const second = await new NfeEncatConnector({ fetch: fetchImpl, readState: async () => firstState, revisitAfterMs: 0 }).collect(CONTEXT);
  const normalizedSecond = normalizePublication({ sourceId: SOURCE_ID, publication: second.publications[0]! });

  assert.equal(first.publications[0]?.metadata?.portalFamily, 'SCHEMAS');
  assert.equal(first.publications[0]?.files?.[0]?.mimeType, 'application/zip');
  assert.equal(normalizedFirst.identityHash, normalizedSecond.identityHash);
  assert.notEqual(normalizedFirst.contentHash, normalizedSecond.contentHash);
});


test('reuses a recent validated file checkpoint without redownloading bytes', async () => {
  let fileRequests = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) {
      return new Response(
        family === 'notes' ? oneNote() : emptyListing(),
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }

    if (url.includes('/exibirArquivo.aspx')) {
      fileRequests += 1;
      return new Response(
        new TextEncoder().encode('%PDF-1.7\\ncheckpoint'),
        {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            etag: '"checkpoint-v1"',
          },
        },
      );
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const firstNow = new Date('2026-09-22T00:00:00Z');
  const first = await new NfeEncatConnector({
    fetch: fetchImpl,
    now: () => firstNow,
  }).collect(CONTEXT);
  const state = first.checkpoint?.state as {
    items: Record<string, any>;
  };

  assert.equal(fileRequests, 1);

  const second = await new NfeEncatConnector({
    fetch: fetchImpl,
    now: () => new Date('2026-09-22T01:00:00Z'),
    readState: async () => state,
  }).collect(CONTEXT);

  assert.equal(fileRequests, 1);
  assert.equal(second.publications.length, 1);
  assert.equal(
    (second.metadata?.nfeEncat as { reusedCheckpointCount: number })
      .reusedCheckpointCount,
    1,
  );
  assert.equal(
    (second.metadata?.nfeEncat as { recheckedKnownCount: number })
      .recheckedKnownCount,
    0,
  );
});

test('rechecks stale known files in bounded oldest-first batches', async () => {
  const notes = `<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p>
<p><a href="exibirArquivo.aspx?conteudo=A%3D"><span class="tituloConteudo">Nota Técnica 2026.009 v1.00 - Publicada em 09/09/2026</span></a></p>
<p><a href="exibirArquivo.aspx?conteudo=B%3D"><span class="tituloConteudo">Nota Técnica 2023.003 v1.30 - Publicada em 29/07/2026</span></a></p>
</body></html>`;
  let phase: 'bootstrap' | 'recheck' = 'bootstrap';
  let recheckRequests = 0;

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) {
      return new Response(
        family === 'notes' ? notes : emptyListing(),
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }

    if (url.includes('/exibirArquivo.aspx')) {
      const key = url.includes('A%3D') || url.includes('A=') ? 'A' : 'B';
      const etag = `"${key}-v1"`;

      if (phase === 'recheck') {
        recheckRequests += 1;
        const headers = headerRecord(init);
        assert.equal(headers['if-none-match'], etag);
        return new Response(null, {
          status: 304,
          headers: { etag },
        });
      }

      return new Response(
        new TextEncoder().encode(`%PDF-1.7\\n${key}`),
        {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            etag,
          },
        },
      );
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const first = await new NfeEncatConnector({
    fetch: fetchImpl,
    now: () => new Date('2026-09-20T00:00:00Z'),
  }).collect(CONTEXT);
  const state = first.checkpoint?.state as {
    items: Record<string, any>;
  };

  phase = 'recheck';

  const second = await new NfeEncatConnector({
    fetch: fetchImpl,
    now: () => new Date('2026-09-22T00:00:00Z'),
    readState: async () => state,
    revisitAfterMs: 24 * 60 * 60 * 1_000,
    maxRechecksPerRun: 1,
  }).collect(CONTEXT);

  assert.equal(second.publications.length, 2);
  assert.equal(recheckRequests, 1);
  const metadata = second.metadata?.nfeEncat as {
    reusedCheckpointCount: number;
    recheckedKnownCount: number;
    notModifiedCount: number;
  };
  assert.equal(metadata.reusedCheckpointCount, 1);
  assert.equal(metadata.recheckedKnownCount, 1);
  assert.equal(metadata.notModifiedCount, 1);
});


test('rejects a non-ZIP payload for schema packages', async () => {
  const schema = '<!doctype html><html><body><p class="tituloSessao">Versões em uso - Ambiente de Produção</p><p><a href="exibirArquivo.aspx?conteudo=SCHEMA-PDF%3D"><span class="tituloConteudo">Esquema XML NF-e/NFC-e - Pacote 010b - Publicado em 10/09/2026</span></a><br>Pacote oficial.</p></body></html>';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input.toString();
    const family = listingFamily(url);
    if (family) return new Response(family === 'schemas' ? schema : emptyListing(), { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('/exibirArquivo.aspx')) {
      return new Response(new TextEncoder().encode('%PDF-1.7\\nnot-a-schema-zip'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const result = await new NfeEncatConnector({ fetch: fetchImpl }).collect(CONTEXT);
  assert.equal(result.publications.length, 0);
  assert.equal(result.partialFailures?.length, 1);
  assert.equal(result.partialFailures?.[0]?.code, 'NFE_ENCAT_FILE_TYPE_MISMATCH');
});
