import assert from 'node:assert/strict';
import test from 'node:test';

import { SpedClient } from '../src/modules/collection/sped.client.js';

test('downloads and hashes official files and supports conditional 304', async () => {
  let conditionalSeen = false;
  const client = new SpedClient({
    origin: 'https://sped.rfb.gov.br',
    pathPrefix: '/',
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['if-none-match'] === '"v1"') {
        conditionalSeen = true;
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }
      return new Response(new TextEncoder().encode('%PDF-1.7\nsped'), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="nota.pdf"',
          etag: '"v1"',
        },
      });
    }) as typeof fetch,
  });

  const first = await client.downloadFile('https://sped.rfb.gov.br/arquivo/download/1', new AbortController().signal);
  assert.equal(first.status, 'DOWNLOADED');
  if (first.status === 'DOWNLOADED') {
    assert.match(first.rawSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.filename, 'nota.pdf');
  }
  const second = await client.downloadFile('https://sped.rfb.gov.br/arquivo/download/1', new AbortController().signal, { etag: '"v1"' });
  assert.equal(second.status, 'NOT_MODIFIED');
  assert.equal(conditionalSeen, true);
});

test('rejects cross-origin redirects and treats transient HTTP failures as retryable', async () => {
  const redirect = new SpedClient({
    fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://example.com/file.pdf' } })) as typeof fetch,
  });
  await assert.rejects(
    redirect.getHtml('https://www.gov.br/sped/pt-br/assuntos/teste', new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SPED_CROSS_ORIGIN_REDIRECT');
      return true;
    },
  );

  const unavailable = new SpedClient({
    fetch: (async () => new Response('down', { status: 503, headers: { 'content-type': 'text/html' } })) as typeof fetch,
  });
  await assert.rejects(
    unavailable.getHtml('https://www.gov.br/sped/pt-br/assuntos/teste', new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    },
  );
});
