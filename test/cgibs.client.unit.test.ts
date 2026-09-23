import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { CgibsClient } from '../src/modules/collection/cgibs.client.js';

const PAGE = 'https://www.cgibs.gov.br/resolucoes';
const FILE = 'https://www.cgibs.gov.br/upload/arquivos/202604/resolucao.pdf';

test('accepts official www/non-www redirects and rejects external redirects', async () => {
  let count = 0;
  const client = new CgibsClient({
    fetch: (async () => {
      count += 1;
      if (count === 1) return new Response(null, { status: 302, headers: { location: 'https://cgibs.gov.br/resolucoes' } });
      return new Response('<!doctype html><html><body>Resoluções</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as typeof fetch,
  });
  const result = await client.getHtml(PAGE, new AbortController().signal);
  assert.equal(result.url, 'https://cgibs.gov.br/resolucoes');

  const external = new CgibsClient({
    fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://example.com/file' } })) as typeof fetch,
  });
  await assert.rejects(
    external.getHtml(PAGE, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CGIBS_CROSS_ORIGIN_REDIRECT');
      return true;
    },
  );
});

test('downloads official bytes and calculates SHA-256 for PDF and ZIP', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\nCGIBS');
  const pdfClient = new CgibsClient({
    fetch: (async () => new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="resolucao.pdf"',
        etag: '"cgibs-1"',
      },
    })) as typeof fetch,
  });
  const downloaded = await pdfClient.downloadFile(FILE, new AbortController().signal);
  assert.equal(downloaded.status, 'DOWNLOADED');
  if (downloaded.status !== 'DOWNLOADED') throw new Error('expected downloaded file');
  assert.equal(downloaded.mimeType, 'application/pdf');
  assert.equal(downloaded.rawSha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(downloaded.filename, 'resolucao.pdf');

  const zipBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const zipClient = new CgibsClient({
    fetch: (async () => new Response(zipBytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as typeof fetch,
  });
  const zipped = await zipClient.downloadFile(
    'https://www.cgibs.gov.br/upload/arquivos/202609/openapi-v1.1.0.zip',
    new AbortController().signal,
  );
  assert.equal(zipped.status, 'DOWNLOADED');
  if (zipped.status !== 'DOWNLOADED') throw new Error('expected downloaded zip');
  assert.equal(zipped.mimeType, 'application/zip');
});

test('uses conditional validators and returns NOT_MODIFIED on 304', async () => {
  let headers: Record<string, string> = {};
  const client = new CgibsClient({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(null, { status: 304, headers: { etag: '"same"' } });
    }) as typeof fetch,
  });
  const result = await client.downloadFile(FILE, new AbortController().signal, {
    etag: '"same"',
    lastModified: 'Mon, 21 Sep 2026 12:00:00 GMT',
  });
  assert.equal(result.status, 'NOT_MODIFIED');
  assert.equal(headers['if-none-match'], '"same"');
  assert.equal(headers['if-modified-since'], 'Mon, 21 Sep 2026 12:00:00 GMT');
});

test('rejects HTML intermediary instead of accepting it as a file', async () => {
  const client = new CgibsClient({
    fetch: (async () => new Response('<!doctype html><html><body>erro</body></html>', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as typeof fetch,
  });
  await assert.rejects(
    client.downloadFile(FILE, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CGIBS_HTML_INSTEAD_OF_FILE');
      return true;
    },
  );
});

for (const status of [408, 425, 429, 500, 503]) {
  test(`treats HTTP ${status} as retryable source failure`, async () => {
    const client = new CgibsClient({
      fetch: (async () => new Response('temporary', {
        status,
        headers: { 'content-type': 'text/html', 'retry-after': '7' },
      })) as typeof fetch,
    });
    await assert.rejects(
      client.getHtml(PAGE, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { retryable?: boolean }).retryable, true);
        assert.equal((error as { httpStatus?: number }).httpStatus, status);
        return true;
      },
    );
  });
}

test('distinguishes a successful empty page from unavailable source', async () => {
  const client = new CgibsClient({
    fetch: (async () => new Response('<!doctype html><html><body><main>Nenhuma publicação.</main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch,
  });
  const page = await client.getHtml(PAGE, new AbortController().signal);
  assert.match(page.html, /Nenhuma publicação/);
});
