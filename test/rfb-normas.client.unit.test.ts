import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { RfbNormasClient } from '../src/modules/collection/rfb-normas.client.js';

const SEARCH = 'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action';
const FILE = 'https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=90001';

test('reads official HTML and rejects cross-origin navigation', async () => {
  const client = new RfbNormasClient({
    fetch: (async () => new Response('<!doctype html><html><body>Normas</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch,
  });
  const page = await client.getHtml(SEARCH, new AbortController().signal);
  assert.equal(page.status, 'OK');
  assert.match(page.html, /Normas/);

  await assert.rejects(
    client.getHtml('https://example.com/not-official', new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'RFB_NORMAS_CROSS_ORIGIN_REQUEST');
      return true;
    },
  );
});

test('optional representation distinguishes unavailable from source failure', async () => {
  const unavailable = new RfbNormasClient({
    fetch: (async () => new Response('missing', { status: 404 })) as typeof fetch,
  });
  const missing = await unavailable.getOptionalHtml(SEARCH, new AbortController().signal);
  assert.equal(missing.status, 'NOT_AVAILABLE');

  const down = new RfbNormasClient({
    fetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
  });
  await assert.rejects(
    down.getOptionalHtml(SEARCH, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});

test('downloads official file with SHA-256 and honors conditional 304', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nconsulta');
  let calls = 0;
  const client = new RfbNormasClient({
    fetch: (async (_input, init) => {
      calls += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === '"file-v1"') {
        return new Response(null, { status: 304, headers: { etag: '"file-v1"' } });
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          etag: '"file-v1"',
          'content-disposition': 'attachment; filename="consulta.pdf"',
        },
      });
    }) as typeof fetch,
  });

  const first = await client.downloadFile(FILE, new AbortController().signal);
  assert.equal(first.status, 'DOWNLOADED');
  if (first.status !== 'DOWNLOADED') throw new Error('expected download');
  assert.equal(first.rawSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.filename, 'consulta.pdf');

  const replay = await client.downloadFile(FILE, new AbortController().signal, { etag: '"file-v1"' });
  assert.equal(replay.status, 'NOT_MODIFIED');
  assert.equal(calls, 2);
});

for (const status of [408, 425, 429, 500, 503]) {
  test(`HTTP ${status} is retryable for required source pages`, async () => {
    const client = new RfbNormasClient({
      fetch: (async () => new Response('temporary', { status })) as typeof fetch,
    });
    await assert.rejects(
      client.getHtml(SEARCH, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { retryable?: boolean }).retryable, true);
        return true;
      },
    );
  });
}
