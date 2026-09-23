import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

export const CGIBS_ORIGIN = 'https://www.cgibs.gov.br';
export const CGIBS_BASE_URL = CGIBS_ORIGIN + '/';

const ALLOWED_ORIGINS = new Set(['https://www.cgibs.gov.br', 'https://cgibs.gov.br']);
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HTML_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface CgibsClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxHtmlBytes?: number;
  maxFileBytes?: number;
}

export interface CgibsHtmlResponse {
  url: string;
  html: string;
  contentType: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export interface CgibsDownloadedFile {
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

export interface CgibsNotModifiedFile {
  status: 'NOT_MODIFIED';
  url: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export type CgibsFileResponse = CgibsDownloadedFile | CgibsNotModifiedFile;

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
  if (/^\d+$/.test(raw.trim())) {
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

function cleanContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
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

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

function mimeFromExtension(filenameOrUrl: string): string | undefined {
  const path = filenameOrUrl.toLowerCase().split(/[?#]/, 1)[0] ?? '';
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.zip')) return 'application/zip';
  if (path.endsWith('.xml')) return 'application/xml';
  if (path.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (path.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (path.endsWith('.json')) return 'application/json';
  return undefined;
}

function sniffMimeType(bytes: Uint8Array, header: string, filename: string | undefined, url: string): string | undefined {
  if (bytes.length >= 5 && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  const byName = mimeFromExtension(filename ?? url);
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]!) && [0x04, 0x06, 0x08].includes(bytes[3]!)) {
    return byName ?? 'application/zip';
  }
  const prefix = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart();
  if (prefix.startsWith('<?xml')) return 'application/xml';
  if (/^(?:\{|\[)/.test(prefix) && (header.includes('json') || byName === 'application/json')) return 'application/json';
  if (
    header === 'application/pdf' ||
    header === 'application/zip' ||
    header === 'application/x-zip-compressed' ||
    header === 'application/xml' ||
    header === 'text/xml' ||
    header === 'application/json' ||
    header.includes('officedocument')
  ) return header;
  return byName;
}

function normalizedPageText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function rejectIntermediary(html: string): void {
  const text = normalizedPageText(html);
  if (/server error|runtime error|erro no servidor|internal server error|service unavailable/.test(text)) {
    throw failure('CGIBS_ERROR_PAGE', 'SOURCE_UNAVAILABLE', true);
  }
  if (/captcha|nao sou um robo|não sou um robô/.test(text)) {
    throw failure('CGIBS_CAPTCHA', 'SOURCE_UNAVAILABLE', true);
  }
}

export class CgibsClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxHtmlBytes: number;
  readonly #maxFileBytes: number;

  constructor(options: CgibsClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async #singleRequest(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    try {
      return await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.any([signal, controller.signal]),
        headers: {
          accept: 'text/html,application/xhtml+xml,application/pdf,application/zip,application/xml,application/json,application/octet-stream;q=0.8,*/*;q=0.5',
          'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
          ...headers,
        },
      });
    } catch (error) {
      if (signal.aborted) throw failure('CGIBS_CANCELLED', 'CANCELLED', false);
      if (controller.signal.aborted) {
        throw failure('CGIBS_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
      }
      throw failure('CGIBS_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: { cause: error instanceof Error ? error.name : 'unknown' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<{ response: Response; url: string }> {
    const initial = new URL(url, CGIBS_BASE_URL);
    if (!ALLOWED_ORIGINS.has(initial.origin.toLowerCase())) {
      throw failure('CGIBS_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, { metadata: { url: initial.toString() } });
    }

    let current = initial.toString();
    const seen = new Set<string>();
    for (let redirects = 0; ; redirects += 1) {
      if (seen.has(current)) throw failure('CGIBS_REDIRECT_LOOP', 'SOURCE_UNAVAILABLE', true);
      seen.add(current);
      const response = await this.#singleRequest(current, signal, headers);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      if (redirects >= this.#maxRedirects) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw failure('CGIBS_TOO_MANY_REDIRECTS', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      }
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (!location) throw failure('CGIBS_REDIRECT_WITHOUT_LOCATION', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      const next = new URL(location, current);
      if (!ALLOWED_ORIGINS.has(next.origin.toLowerCase())) {
        throw failure('CGIBS_CROSS_ORIGIN_REDIRECT', 'SOURCE_UNAVAILABLE', false, {
          httpStatus: response.status,
          metadata: { location: next.toString() },
        });
      }
      current = next.toString();
    }
  }

  async #checkStatus(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
    if (response.status === 429) throw failure('CGIBS_RATE_LIMITED', 'RATE_LIMITED', true, { httpStatus: 429, retryAfterSeconds: retryAfter });
    if (response.status === 408 || response.status === 425 || response.status >= 500) {
      throw failure('CGIBS_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status, retryAfterSeconds: retryAfter });
    }
    throw failure('CGIBS_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status });
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('CGIBS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
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
        if (total > limit) throw failure('CGIBS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch { /* ignore */ }
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted) throw failure('CGIBS_CANCELLED', 'CANCELLED', false);
      throw failure('CGIBS_BODY_READ_FAILED', 'NETWORK_ERROR', true);
    } finally {
      reader.releaseLock();
    }
  }

  async getHtml(url: string, signal: AbortSignal): Promise<CgibsHtmlResponse> {
    const { response, url: finalUrl } = await this.#request(url, signal);
    await this.#checkStatus(response);
    const contentType = cleanContentType(response.headers.get('content-type'));
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('CGIBS_INVALID_HTML_CONTENT_TYPE', 'FETCH_ERROR', true, { metadata: { contentType } });
    }
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    rejectIntermediary(html);
    return {
      url: finalUrl,
      html,
      contentType,
      ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
    };
  }

  async downloadFile(
    url: string,
    signal: AbortSignal,
    conditional: { etag?: string; lastModified?: string } = {},
  ): Promise<CgibsFileResponse> {
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
    await this.#checkStatus(response);
    const headerContentType = cleanContentType(response.headers.get('content-type'));
    const filename = contentDispositionFilename(response.headers.get('content-disposition'));
    const bytes = await this.#readBytes(response, this.#maxFileBytes, signal);
    if (!bytes.length) throw failure('CGIBS_EMPTY_FILE', 'FETCH_ERROR', true);
    if (headerContentType === 'text/html' || headerContentType === 'application/xhtml+xml' || looksLikeHtml(bytes)) {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
      rejectIntermediary(html);
      throw failure('CGIBS_HTML_INSTEAD_OF_FILE', 'SOURCE_UNAVAILABLE', true);
    }
    const mimeType = sniffMimeType(bytes, headerContentType, filename, finalUrl);
    if (!mimeType) {
      throw failure('CGIBS_UNSUPPORTED_FILE_TYPE', 'FETCH_ERROR', false, {
        metadata: { contentType: headerContentType, filename: filename ?? null, url: finalUrl },
      });
    }
    return {
      status: 'DOWNLOADED',
      url: finalUrl,
      bytes,
      rawSha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      mimeType,
      ...(filename ? { filename } : {}),
      ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
    };
  }
}
