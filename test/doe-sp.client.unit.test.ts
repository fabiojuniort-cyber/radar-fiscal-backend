import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import {
  DOE_SP_PDF_API,
  DOE_SP_SEARCH_API,
  DoeSpClient,
  normalizeDoeSpApiUrl,
  publicationPageUrl,
} from '../src/modules/collection/doe-sp.client.js';
import { authPdfEnvelope, pdfBytes } from './doe-sp.fixtures.js';

const signal = new AbortController().signal;

function respond(response: () => Response): typeof fetch {
  return (async () => response()) as typeof fetch;
}

function isError(code: string, kind?: string) {
  return (error: unknown) => error instanceof ConnectorError && error.code === code && (kind === undefined || error.kind === kind);
}

test('DOE-SP client maps HTTP failures to Motor error kinds', async () => {
  const unavailable = new DoeSpClient({ fetch: respond(() => new Response('x', { status: 503 })) });
  await assert.rejects(unavailable.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), isError('DOE_SP_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE'));

  const limited = new DoeSpClient({ fetch: respond(() => new Response('x', { status: 429, headers: { 'retry-after': '120' } })) });
  await assert.rejects(limited.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), (error: unknown) =>
    error instanceof ConnectorError && error.kind === 'RATE_LIMITED' && error.retryAfterSeconds === 120);

  const badRequest = new DoeSpClient({ fetch: respond(() => new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } })) });
  await assert.rejects(badRequest.getJson(DOE_SP_SEARCH_API, 'v2/publications/x', {}, signal), isError('DOE_SP_HTTP_ERROR', 'HTTP_ERROR'));

  const html = new DoeSpClient({ fetch: respond(() => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) });
  await assert.rejects(html.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), isError('DOE_SP_HTML_INSTEAD_OF_JSON', 'SOURCE_UNAVAILABLE'));

  const broken = new DoeSpClient({ fetch: respond(() => new Response('{"items":', { status: 200, headers: { 'content-type': 'application/json' } })) });
  await assert.rejects(broken.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), isError('DOE_SP_INVALID_JSON', 'FETCH_ERROR'));

  const network = new DoeSpClient({ fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(network.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), isError('DOE_SP_NETWORK_ERROR', 'NETWORK_ERROR'));
});

test('DOE-SP client enforces its own timeout and honours cancellation', async () => {
  // Like a real socket, a pending request keeps the event loop alive.
  const hanging = ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const keepAlive = setTimeout(() => undefined, 60_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(new DOMException('aborted', 'AbortError'));
    });
  })) as typeof fetch;
  const client = new DoeSpClient({ fetch: hanging, timeoutMs: 30 });
  await assert.rejects(client.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal), isError('DOE_SP_REQUEST_TIMEOUT', 'NETWORK_ERROR'));

  const controller = new AbortController();
  const pending = new DoeSpClient({ fetch: hanging, timeoutMs: 10_000 }).getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, isError('DOE_SP_CANCELLED', 'CANCELLED'));
});

test('DOE-SP client refuses hosts outside the official APIs', async () => {
  const client = new DoeSpClient({ fetch: respond(() => new Response('{}')) });
  await assert.rejects(client.getJson('https://example.org/', 'x', {}, signal), isError('DOE_SP_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR'));
});

test('DOE-SP client: 404 is data only when explicitly allowed (editions/status)', async () => {
  const client = new DoeSpClient({ fetch: respond(() => new Response('{"status":404}', { status: 404, headers: { 'content-type': 'application/json' } })) });
  const response = await client.getJson(DOE_SP_PDF_API, 'v1/editions/status/2026-09-20', {}, signal, { allowNotFound: true });
  assert.equal(response.status, 404);
  assert.equal(response.body, null);
  await assert.rejects(client.getJson(DOE_SP_PDF_API, 'v1/editions/status/2026-09-20', {}, signal), isError('DOE_SP_HTTP_ERROR'));
});

test('DOE-SP client decodes the authenticated PDF and hashes the PDF bytes', async () => {
  const envelope = authPdfEnvelope('70413500-3dd4-4b9b-a88a-08df0495b6f6');
  const client = new DoeSpClient({ fetch: respond(() => new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json; charset=utf-8' } })) });
  const file = await client.downloadAuthenticatedPdf('2026.09.03.1.1.28.3.214.2102360', signal);
  const bytes = pdfBytes('auth 70413500-3dd4-4b9b-a88a-08df0495b6f6');
  assert.equal(file.rawSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(file.sizeBytes, bytes.byteLength);
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.name, '70413500-3dd4-4b9b-a88a-08df0495b6f6.pdf');

  const notPdf = new DoeSpClient({ fetch: respond(() => new Response(JSON.stringify({ name: 'x.pdf', content: Buffer.from('hello').toString('base64') }), { headers: { 'content-type': 'application/json' } })) });
  await assert.rejects(notPdf.downloadAuthenticatedPdf('1.2.3', signal), isError('DOE_SP_INVALID_AUTHENTICATED_PDF', 'FETCH_ERROR'));
});

test('DOE-SP authenticated PDF envelope may exceed generic JSON cap but decoded file cap still applies', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(512, 0x41)]);
  const envelope = { name: 'large.pdf', content: bytes.toString('base64') };
  const body = JSON.stringify(envelope);
  assert.ok(Buffer.byteLength(body) > 64);

  const client = new DoeSpClient({
    fetch: respond(() => new Response(body, { headers: { 'content-type': 'application/json' } })),
    maxJsonBytes: 64,
    maxFileBytes: 1024,
  });

  await assert.rejects(
    client.getJson(DOE_SP_SEARCH_API, 'v2/journals', {}, signal),
    isError('DOE_SP_RESPONSE_TOO_LARGE', 'FETCH_ERROR'),
  );

  const file = await client.downloadAuthenticatedPdf('2025.05.06.1.1.27.1.203.1057223', signal);
  assert.equal(file.sizeBytes, bytes.byteLength);
  assert.equal(file.rawSha256, createHash('sha256').update(bytes).digest('hex'));

  const capped = new DoeSpClient({
    fetch: respond(() => new Response(body, { headers: { 'content-type': 'application/json' } })),
    maxJsonBytes: 64,
    maxFileBytes: 64,
  });
  await assert.rejects(
    capped.downloadAuthenticatedPdf('2025.05.06.1.1.27.1.203.1057223', signal),
    isError('DOE_SP_RESPONSE_TOO_LARGE', 'FETCH_ERROR'),
  );
});

test('DOE-SP client downloads attachments and rejects HTML error pages', async () => {
  const ok = new DoeSpClient({ fetch: respond(() => new Response(pdfBytes('anexo'), { headers: { 'content-type': 'application/pdf' } })) });
  const file = await ok.downloadAttachment('ede64d5b-2bdc-4c9b-bfd3-841a1c69eded', 'Anexo.pdf', signal);
  assert.equal(file.mimeType, 'application/pdf');
  assert.match(file.url, /downloadattachment\/ede64d5b-2bdc-4c9b-bfd3-841a1c69eded$/);

  const html = new DoeSpClient({ fetch: respond(() => new Response('<html><body>erro</body></html>', { headers: { 'content-type': 'text/html' } })) });
  await assert.rejects(html.downloadAttachment('ede64d5b-2bdc-4c9b-bfd3-841a1c69eded', 'Anexo.pdf', signal), isError('DOE_SP_HTML_INSTEAD_OF_FILE'));
});

test('DOE-SP URLs: canonical page URL and https normalisation of API links', () => {
  assert.equal(
    publicationPageUrl('executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-43-de-3-de-setembro-de-2026-20260903112832142102360'),
    'https://doe.sp.gov.br/executivo/secretaria-da-fazenda-e-planejamento/portaria-sre-43-de-3-de-setembro-de-2026-20260903112832142102360',
  );
  assert.equal(
    normalizeDoeSpApiUrl('http://do-api-publication-pdf.doe.sp.gov.br/v1/editions/2d9ae845-29b5-4e1f-bae8-a3a532cbae7f'),
    'https://do-api-publication-pdf.doe.sp.gov.br/v1/editions/2d9ae845-29b5-4e1f-bae8-a3a532cbae7f',
  );
});
