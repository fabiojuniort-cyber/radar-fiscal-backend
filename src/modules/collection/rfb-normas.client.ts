import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

export const RFB_NORMAS_ALLOWED_ORIGINS = new Set([
  'https://normas.receita.fazenda.gov.br',
  'https://normasinternet2.receita.fazenda.gov.br',
]);

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HTML_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface RfbNormasClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxHtmlBytes?: number;
  maxFileBytes?: number;
}

export interface RfbHtmlResponse {
  status: 'OK';
  url: string;
  html: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export interface RfbOptionalMissingResponse {
  status: 'NOT_AVAILABLE';
  url: string;
  httpStatus: number;
}

export type RfbOptionalHtmlResponse = RfbHtmlResponse | RfbOptionalMissingResponse;

export interface RfbJsonResponse {
  status: 'OK';
  url: string;
  payload: unknown;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export type RfbOptionalJsonResponse = RfbJsonResponse | RfbOptionalMissingResponse;

export interface RfbDownloadedFile {
  status: 'DOWNLOADED';
  url: string;
  bytes: Uint8Array;
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  filename?: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export interface RfbNotModifiedFile {
  status: 'NOT_MODIFIED';
  url: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export type RfbFileResponse = RfbDownloadedFile | RfbNotModifiedFile;

function failure(
  code: string,
  kind: ConstructorParameters<typeof ConnectorError>[1]['kind'],
  retryable: boolean,
  options: {
    httpStatus?: number;
    retryAfterSeconds?: number;
    metadata?: Record<string, unknown>;
  } = {},
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

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.ceil((parsed - Date.now()) / 1000)) : undefined;
}

function cleanContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function normalizedPageText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function rejectIntermediary(html: string): void {
  const text = normalizedPageText(html);
  if (/server error|runtime error|erro no servidor|internal server error|service unavailable/.test(text)) {
    throw failure('RFB_NORMAS_ERROR_PAGE', 'SOURCE_UNAVAILABLE', true);
  }
  if (/captcha|nao sou um robo|não sou um robô/.test(text)) {
    throw failure('RFB_NORMAS_CAPTCHA', 'SOURCE_UNAVAILABLE', true);
  }
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (star) {
    try {
      const decoded = decodeURIComponent(star).replace(/[\\/]/g, '_').trim();
      if (decoded) return decoded;
    } catch { /* ignore */ }
  }
  const normal = /(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  const filename = (normal?.[1] ?? normal?.[2])?.trim();
  return filename ? filename.replace(/[\\/]/g, '_') : undefined;
}

function sniffMime(bytes: Uint8Array, header: string, filename: string | undefined, url: string): string {
  if (bytes.length >= 5 && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-') {
    return 'application/pdf';
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return 'application/zip';
  }
  const lower = (filename ?? url).toLowerCase().split(/[?#]/, 1)[0] ?? '';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.xml')) return 'application/xml';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (header && header !== 'application/octet-stream') return header;
  return 'application/octet-stream';
}

export class RfbNormasClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxHtmlBytes: number;
  readonly #maxFileBytes: number;

  constructor(options: RfbNormasClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async #singleRequest(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    timer.unref();
    try {
      return await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any([signal, timeout.signal]),
        headers: {
          accept: 'text/html,application/xhtml+xml,application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
          'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
          ...headers,
        },
      });
    } catch (error) {
      if (signal.aborted) throw failure('RFB_NORMAS_CANCELLED', 'CANCELLED', false);
      if (timeout.signal.aborted) {
        throw failure('RFB_NORMAS_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, {
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        });
      }
      throw failure('RFB_NORMAS_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: { cause: error instanceof Error ? error.name : 'unknown' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(
    url: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<{ response: Response; url: string }> {
    const initial = new URL(url);
    if (!RFB_NORMAS_ALLOWED_ORIGINS.has(initial.origin.toLowerCase())) {
      throw failure('RFB_NORMAS_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, {
        metadata: { url: initial.toString() },
      });
    }

    let current = initial.toString();
    const seen = new Set<string>();
    for (let redirects = 0; ; redirects += 1) {
      if (seen.has(current)) throw failure('RFB_NORMAS_REDIRECT_LOOP', 'SOURCE_UNAVAILABLE', true);
      seen.add(current);
      const response = await this.#singleRequest(current, signal, headers);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      if (redirects >= this.#maxRedirects) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw failure('RFB_NORMAS_TOO_MANY_REDIRECTS', 'SOURCE_UNAVAILABLE', true);
      }
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (!location) throw failure('RFB_NORMAS_REDIRECT_WITHOUT_LOCATION', 'SOURCE_UNAVAILABLE', true);
      const next = new URL(location, current);
      if (!RFB_NORMAS_ALLOWED_ORIGINS.has(next.origin.toLowerCase())) {
        throw failure('RFB_NORMAS_CROSS_ORIGIN_REDIRECT', 'SOURCE_UNAVAILABLE', false, {
          metadata: { location: next.toString() },
        });
      }
      current = next.toString();
    }
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('RFB_NORMAS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
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
        if (total > limit) throw failure('RFB_NORMAS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, total);
    } finally {
      reader.releaseLock();
    }
  }

  async #checkedHtml(
    url: string,
    signal: AbortSignal,
    optional: boolean,
  ): Promise<RfbOptionalHtmlResponse> {
    const { response, url: finalUrl } = await this.#request(url, signal);
    if (optional && [400, 404, 410].includes(response.status)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { status: 'NOT_AVAILABLE', url: finalUrl, httpStatus: response.status };
    }
    if (!(response.status >= 200 && response.status < 300)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
      if (response.status === 429) {
        throw failure('RFB_NORMAS_RATE_LIMITED', 'RATE_LIMITED', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        throw failure('RFB_NORMAS_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      throw failure('RFB_NORMAS_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status });
    }
    const contentType = cleanContentType(response.headers.get('content-type'));
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml' && contentType !== '') {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('RFB_NORMAS_INVALID_HTML_CONTENT_TYPE', 'FETCH_ERROR', true, {
        metadata: { contentType },
      });
    }
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    rejectIntermediary(html);
    return {
      status: 'OK',
      url: finalUrl,
      html,
      ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
    };
  }

  async getHtml(url: string, signal: AbortSignal): Promise<RfbHtmlResponse> {
    const result = await this.#checkedHtml(url, signal, false);
    if (result.status !== 'OK') throw failure('RFB_NORMAS_REQUIRED_HTML_MISSING', 'SOURCE_UNAVAILABLE', true);
    return result;
  }

  async getOptionalHtml(url: string, signal: AbortSignal): Promise<RfbOptionalHtmlResponse> {
    return this.#checkedHtml(url, signal, true);
  }

  async #checkedJson(
    url: string,
    signal: AbortSignal,
    optional: boolean,
  ): Promise<RfbOptionalJsonResponse> {
    const { response, url: finalUrl } = await this.#request(url, signal, {
      accept: 'application/json',
    });

    if (optional && [400, 403, 404, 410].includes(response.status)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { status: 'NOT_AVAILABLE', url: finalUrl, httpStatus: response.status };
    }

    if (!(response.status >= 200 && response.status < 300)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
      if (response.status === 429) {
        throw failure('RFB_NORMAS_RATE_LIMITED', 'RATE_LIMITED', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        throw failure('RFB_NORMAS_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      throw failure('RFB_NORMAS_JSON_HTTP_ERROR', 'HTTP_ERROR', false, {
        httpStatus: response.status,
      });
    }

    const contentType = cleanContentType(response.headers.get('content-type'));
    if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('RFB_NORMAS_INVALID_JSON_CONTENT_TYPE', 'FETCH_ERROR', true, {
        metadata: { contentType },
      });
    }

    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    if (!bytes.length) {
      throw failure('RFB_NORMAS_EMPTY_JSON', 'FETCH_ERROR', true);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    } catch {
      throw failure('RFB_NORMAS_INVALID_JSON', 'FETCH_ERROR', true);
    }

    return {
      status: 'OK',
      url: finalUrl,
      payload,
      ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
    };
  }

  async getJson(url: string, signal: AbortSignal): Promise<RfbJsonResponse> {
    const result = await this.#checkedJson(url, signal, false);
    if (result.status !== 'OK') {
      throw failure('RFB_NORMAS_REQUIRED_JSON_MISSING', 'SOURCE_UNAVAILABLE', true);
    }
    return result;
  }

  async getOptionalJson(url: string, signal: AbortSignal): Promise<RfbOptionalJsonResponse> {
    return this.#checkedJson(url, signal, true);
  }

  async downloadFile(
    url: string,
    signal: AbortSignal,
    conditional: { etag?: string; lastModified?: string } = {},
  ): Promise<RfbFileResponse> {
    const headers: Record<string, string> = {};
    if (conditional.etag) headers['if-none-match'] = conditional.etag;
    if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;
    const { response, url: finalUrl } = await this.#request(url, signal, headers);
    if (response.status === 304) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return {
        status: 'NOT_MODIFIED',
        url: finalUrl,
        ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
        ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
      };
    }
    if (!(response.status >= 200 && response.status < 300)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw failure('RFB_NORMAS_FILE_HTTP_ERROR', response.status === 429 ? 'RATE_LIMITED' : 'FETCH_ERROR', retryable, {
        httpStatus: response.status,
        ...(retryable
          ? { retryAfterSeconds: retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS }
          : {}),
      });
    }
    const bytes = await this.#readBytes(response, this.#maxFileBytes, signal);
    if (!bytes.length) throw failure('RFB_NORMAS_EMPTY_FILE', 'FETCH_ERROR', true);
    const contentType = cleanContentType(response.headers.get('content-type'));
    const filename = contentDispositionFilename(response.headers.get('content-disposition'));
    const head = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
      .trimStart().toLowerCase();
    if (contentType === 'text/html' || head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw failure('RFB_NORMAS_HTML_INSTEAD_OF_FILE', 'FETCH_ERROR', true);
    }
    return {
      status: 'DOWNLOADED',
      url: finalUrl,
      bytes,
      rawSha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      mimeType: sniffMime(bytes, contentType, filename, finalUrl),
      ...(filename ? { filename } : {}),
      ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
    };
  }
}
