import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { ConnectorError, type ConnectorErrorKind } from './connector.error.js';

/**
 * Client for the legacy DOE-SP archive of Imprensa Oficial
 * (https://www.imprensaoficial.com.br, 1891 – 06/2023). The portal is an
 * ASP.NET WebForms site: pages redirect between result views and keep an
 * ASP.NET session cookie, so redirects are followed manually (same origin
 * only) with a per-client cookie jar. No authentication, no robots.txt.
 */
export const DOE_SP_LEGACY_ORIGIN = 'https://www.imprensaoficial.com.br';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_REDIRECTS = 6;
const USER_AGENT = 'Tribusca/1.0 (+official-source-monitoring)';

export interface DoeSpLegacyClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxHtmlBytes?: number;
  maxPdfBytes?: number;
  /** Minimum spacing between the start of two requests. 0 = none (tests). */
  minRequestIntervalMs?: number;
}

export interface DoeSpLegacyHtml {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

export interface DoeSpLegacyPdf {
  url: string;
  bytes: Uint8Array;
  rawSha256: string;
  sizeBytes: number;
}

function failure(
  code: string,
  kind: ConnectorErrorKind,
  retryable: boolean,
  options: { httpStatus?: number; retryAfterSeconds?: number; metadata?: Record<string, unknown> } = {},
): ConnectorError {
  return new ConnectorError(code, {
    code,
    kind,
    retryable,
    ...(options.httpStatus !== undefined ? { httpStatus: options.httpStatus } : {}),
    ...(options.retryAfterSeconds !== undefined ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  });
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<');
}

export class DoeSpLegacyClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxHtmlBytes: number;
  readonly #maxPdfBytes: number;
  readonly #minRequestIntervalMs: number;
  #nextRequestAt = 0;
  readonly #cookies = new Map<string, string>();
  requestCount = 0;
  downloadedBytes = 0;

  constructor(options: DoeSpLegacyClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
    this.#maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
    this.#minRequestIntervalMs = options.minRequestIntervalMs ?? 0;
  }

  #cookieHeader(): string | undefined {
    if (!this.#cookies.size) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #storeCookies(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';', 1)[0]!;
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async #send(url: URL, init: { method: 'GET' | 'POST'; body?: string; contentType?: string; accept: string }, signal: AbortSignal): Promise<Response> {
    if (url.origin !== DOE_SP_LEGACY_ORIGIN) {
      throw failure('DOE_SP_LEGACY_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, { metadata: { origin: url.origin } });
    }
    if (signal.aborted) throw failure('DOE_SP_LEGACY_CANCELLED', 'CANCELLED', false);
    if (this.#minRequestIntervalMs > 0) {
      const wait = this.#nextRequestAt - Date.now();
      if (wait > 0) {
        try {
          await delay(wait, undefined, { signal });
        } catch {
          throw failure('DOE_SP_LEGACY_CANCELLED', 'CANCELLED', false);
        }
      }
      this.#nextRequestAt = Date.now() + this.#minRequestIntervalMs;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    this.requestCount += 1;
    const cookie = this.#cookieHeader();
    try {
      const response = await this.#fetch(url.toString(), {
        method: init.method,
        redirect: 'manual',
        signal: AbortSignal.any([signal, controller.signal]),
        headers: {
          accept: init.accept,
          'user-agent': USER_AGENT,
          ...(cookie ? { cookie } : {}),
          ...(init.contentType ? { 'content-type': init.contentType } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      this.#storeCookies(response);
      return response;
    } catch (error) {
      if (signal.aborted) throw failure('DOE_SP_LEGACY_CANCELLED', 'CANCELLED', false);
      if (controller.signal.aborted) {
        throw failure('DOE_SP_LEGACY_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
      }
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
      throw failure('DOE_SP_LEGACY_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: {
          path: url.pathname,
          cause: error instanceof Error ? error.name : 'unknown',
          ...(typeof cause?.code === 'string' ? { causeCode: cause.code } : {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #checkStatus(response: Response, path: string): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const retryAfter = DEFAULT_RETRY_AFTER_SECONDS;
    if (response.status === 429) {
      throw failure('DOE_SP_LEGACY_RATE_LIMITED', 'RATE_LIMITED', true, { httpStatus: 429, retryAfterSeconds: retryAfter });
    }
    if (response.status === 408 || response.status === 425 || response.status >= 500) {
      throw failure('DOE_SP_LEGACY_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, {
        httpStatus: response.status, retryAfterSeconds: retryAfter, metadata: { path },
      });
    }
    throw failure('DOE_SP_LEGACY_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status, metadata: { path } });
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('DOE_SP_LEGACY_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > limit) throw failure('DOE_SP_LEGACY_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      this.downloadedBytes += total;
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch { /* ignore */ }
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted) throw failure('DOE_SP_LEGACY_CANCELLED', 'CANCELLED', false);
      throw failure('DOE_SP_LEGACY_BODY_READ_FAILED', 'NETWORK_ERROR', true);
    } finally {
      reader.releaseLock();
    }
  }

  /** Follows same-origin redirects (GET) and returns the final response. */
  async #follow(start: URL, first: Response, signal: AbortSignal, accept: string): Promise<{ url: URL; response: Response }> {
    let url = start;
    let response = first;
    for (let hop = 0; response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (!location || hop >= MAX_REDIRECTS) {
        throw failure('DOE_SP_LEGACY_REDIRECT_LOOP', 'SOURCE_UNAVAILABLE', true, { metadata: { path: url.pathname } });
      }
      url = new URL(location, url);
      response = await this.#send(url, { method: 'GET', accept }, signal);
    }
    return { url, response };
  }

  async getHtml(pathOrUrl: string, signal: AbortSignal): Promise<DoeSpLegacyHtml> {
    const start = new URL(pathOrUrl, DOE_SP_LEGACY_ORIGIN);
    const accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
    const { url, response } = await this.#follow(start, await this.#send(start, { method: 'GET', accept }, signal), signal, accept);
    await this.#checkStatus(response, url.pathname);
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    return { url: url.toString(), html: new TextDecoder('utf-8', { fatal: false }).decode(bytes) };
  }

  /** AjaxPro call (`text/plain` body with CRLF-separated `name=value` lines). */
  async postAjax(path: string, body: string, signal: AbortSignal): Promise<string> {
    const url = new URL(path, DOE_SP_LEGACY_ORIGIN);
    const response = await this.#send(url, { method: 'POST', body, contentType: 'text/plain; charset=utf-8', accept: '*/*' }, signal);
    await this.#checkStatus(response, url.pathname);
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  /** Page PDF served by GatewayPDF.aspx; held in memory only. */
  async downloadPdf(pathOrUrl: string, signal: AbortSignal): Promise<DoeSpLegacyPdf> {
    const start = new URL(pathOrUrl, DOE_SP_LEGACY_ORIGIN);
    const accept = 'application/pdf,*/*;q=0.5';
    const { url, response } = await this.#follow(start, await this.#send(start, { method: 'GET', accept }, signal), signal, accept);
    await this.#checkStatus(response, url.pathname);
    const bytes = await this.#readBytes(response, this.#maxPdfBytes, signal);
    if (!bytes.length) throw failure('DOE_SP_LEGACY_EMPTY_PDF', 'FETCH_ERROR', true);
    if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw failure(
        looksLikeHtml(bytes) ? 'DOE_SP_LEGACY_HTML_INSTEAD_OF_PDF' : 'DOE_SP_LEGACY_INVALID_PDF',
        looksLikeHtml(bytes) ? 'SOURCE_UNAVAILABLE' : 'FETCH_ERROR',
        true,
        { metadata: { path: url.pathname } },
      );
    }
    return {
      url: url.toString(),
      bytes,
      rawSha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
    };
  }
}
