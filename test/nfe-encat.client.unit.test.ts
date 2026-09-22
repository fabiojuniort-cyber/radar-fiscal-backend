import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { NfeEncatClient } from '../src/modules/collection/nfe-encat.client.js';

const LISTING = 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=';
const FILE = 'https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=abc%3D';
const HTML = '<!doctype html><html><body><p class="tituloSessao">Documentos vigentes</p></body></html>';

function cookieFrom(init?: RequestInit): string {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.cookie ?? '';
}

test('follows ASP.NET cookie redirect, keeps AspxAutoDetectCookieSupport and ASP.NET_SessionId', async () => {
  const requests: Array<{ url: string; cookie: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, cookie: cookieFrom(init) });
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `${LISTING}&AspxAutoDetectCookieSupport=1`,
          'set-cookie': 'AspxAutoDetectCookieSupport=1; path=/; HttpOnly',
        },
      });
    }
    if (requests.length === 2) {
      return new Response(HTML, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'ASP.NET_SessionId=session123; path=/; HttpOnly',
        },
      });
    }
    const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');
    return new Response(pdf, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="nota.pdf"',
      },
    });
  }) as typeof fetch;

  const client = new NfeEncatClient({ fetch: fetchImpl });
  const listing = await client.getListing(LISTING, new AbortController().signal);
  assert.match(listing.url, /AspxAutoDetectCookieSupport=1/);
  assert.match(requests[1]?.cookie ?? '', /AspxAutoDetectCookieSupport=1/);
  const file = await client.downloadFile(FILE, new AbortController().signal);
  assert.equal(file.status, 'DOWNLOADED');
  assert.match(requests[2]?.cookie ?? '', /AspxAutoDetectCookieSupport=1/);
  assert.match(requests[2]?.cookie ?? '', /ASP.NET_SessionId=session123/);
});

test('detects redirect loops instead of treating them as empty source', async () => {
  const client = new NfeEncatClient({
    fetch: (async (input: string | URL | Request) => new Response(null, {
      status: 302,
      headers: { location: input.toString() },
    })) as typeof fetch,
  });
  await assert.rejects(
    client.getListing(LISTING, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NFE_ENCAT_REDIRECT_LOOP');
      return true;
    },
  );
});

test('rejects captcha/intermediary HTML for listings and files', async () => {
  const captcha = '<!doctype html><html><body><div class="g-recaptcha">captcha</div></body></html>';
  const listingClient = new NfeEncatClient({
    fetch: (async () => new Response(captcha, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch,
  });
  await assert.rejects(
    listingClient.getListing(LISTING, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NFE_ENCAT_CAPTCHA');
      return true;
    },
  );

  const fileClient = new NfeEncatClient({
    fetch: (async () => new Response(captcha, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })) as typeof fetch,
  });
  await assert.rejects(
    fileClient.downloadFile(FILE, new AbortController().signal),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NFE_ENCAT_CAPTCHA');
      return true;
    },
  );
});

test('downloads official bytes, validates type and calculates SHA-256', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nRadar Fiscal');
  const client = new NfeEncatClient({
    fetch: (async () => new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename*=UTF-8''NT%202026.009.pdf",
        etag: '"abc"',
        'last-modified': 'Mon, 21 Sep 2026 12:00:00 GMT',
      },
    })) as typeof fetch,
  });
  const result = await client.downloadFile(FILE, new AbortController().signal);
  assert.equal(result.status, 'DOWNLOADED');
  if (result.status !== 'DOWNLOADED') throw new Error('expected downloaded file');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.filename, 'NT 2026.009.pdf');
  assert.equal(result.sizeBytes, bytes.byteLength);
  assert.equal(result.rawSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.sourceEtag, '"abc"');
});

test('uses conditional validators and accepts 304 only as a file checkpoint result', async () => {
  let seenHeaders: Record<string, string> = {};
  const client = new NfeEncatClient({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(null, {
        status: 304,
        headers: { etag: '"same"' },
      });
    }) as typeof fetch,
  });
  const result = await client.downloadFile(FILE, new AbortController().signal, {
    etag: '"same"',
    lastModified: 'Mon, 21 Sep 2026 12:00:00 GMT',
  });
  assert.equal(result.status, 'NOT_MODIFIED');
  assert.equal(seenHeaders['if-none-match'], '"same"');
  assert.equal(seenHeaders['if-modified-since'], 'Mon, 21 Sep 2026 12:00:00 GMT');
});

for (const status of [408, 425, 429, 500, 503]) {
  test(`treats HTTP ${status} as retryable source/transport failure`, async () => {
    const client = new NfeEncatClient({
      fetch: (async () => new Response('temporary', {
        status,
        headers: { 'content-type': 'text/html', 'retry-after': '7' },
      })) as typeof fetch,
    });
    await assert.rejects(
      client.getListing(LISTING, new AbortController().signal),
      (error: unknown) => {
        assert.equal((error as { retryable?: boolean }).retryable, true);
        assert.equal((error as { httpStatus?: number }).httpStatus, status);
        return true;
      },
    );
  });
}
