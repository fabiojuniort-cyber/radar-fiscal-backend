import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

const SPED_ORIGIN = 'https://sped.rfb.gov.br';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 160 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface SpedClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxHtmlBytes?: number;
  maxFileBytes?: number;
}

export interface SpedHtmlResponse {
  url: string;
  html: string;
  contentType: string;
}

export interface SpedDownloadedFile {
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

export interface SpedNotModifiedFile {
  status: 'NOT_MODIFIED';
  url: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export type SpedFileResponse = SpedDownloadedFile | SpedNotModifiedFile;

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
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

function cleanContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) {
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at)
    ? Math.max(0, Math.ceil((at - Date.now()) / 1000))
    : undefined;
}

function decodeFilenameStar(value: string): string | undefined {
  const match = /^UTF-8''(.+)$/i.exec(value.trim());
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = /(?:^|;)\s*filename\*=([^;]+)/i.exec(value)?.[1];
  const decoded = star ? decodeFilenameStar(star) : undefined;
  if (decoded) return decoded.replace(/[\\/]/g, '_').trim() || undefined;
  const normal = /(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  const filename = (normal?.[1] ?? normal?.[2])?.trim();
  return filename ? filename.replace(/[\\/]/g, '_') : undefined;
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

function sniffMimeType(
  bytes: Uint8Array,
  header: string,
  filename?: string,
): string | undefined {
  const lowerName = filename?.toLowerCase() ?? '';
  if (bytes.length >= 5 && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-') {
    return 'application/pdf';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2]!) &&
    [0x04, 0x06, 0x08].includes(bytes[3]!)
  ) {
    if (lowerName.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (lowerName.endsWith('.jar')) return 'application/java-archive';
    return 'application/zip';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1
  ) {
    if (lowerName.endsWith('.xls')) return 'application/vnd.ms-excel';
    if (lowerName.endsWith('.doc')) return 'application/msword';
    if (lowerName.endsWith('.msi')) return 'application/x-msi';
    return header || 'application/octet-stream';
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return lowerName.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/octet-stream';
  }
  const prefix = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 512)))
    .trimStart();
  if (prefix.startsWith('<?xml') || /^<[A-Za-z_][\w:.-]*(?:\s|>)/.test(prefix)) {
    if (lowerName.endsWith('.xsd')) return 'application/xml';
    return 'application/xml';
  }
  if (lowerName.endsWith('.csv')) return 'text/csv';
  if (lowerName.endsWith('.txt')) return 'text/plain';
  if (lowerName.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lowerName.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lowerName.endsWith('.doc')) return 'application/msword';
  if (lowerName.endsWith('.xsd') || lowerName.endsWith('.xml')) return 'application/xml';
  if (header && header !== 'application/octet-stream' && header !== 'binary/octet-stream') return header;
  return lowerName ? 'application/octet-stream' : undefined;
}

function rejectUnexpectedHtml(url: string, html: string): void {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (/service unavailable|internal server error|erro interno|erro no servidor|gateway timeout|bad gateway/.test(text)) {
    throw failure('SPED_ERROR_PAGE', 'SOURCE_UNAVAILABLE', true, { metadata: { url } });
  }
}

export class SpedClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxHtmlBytes: number;
  readonly #maxFileBytes: number;

  constructor(options: SpedClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer');
    if (!Number.isSafeInteger(this.#maxRedirects) || this.#maxRedirects < 0 || this.#maxRedirects > 10) throw new RangeError('maxRedirects must be between 0 and 10');
    if (!Number.isSafeInteger(this.#maxHtmlBytes) || this.#maxHtmlBytes < 1) throw new RangeError('maxHtmlBytes must be positive');
    if (!Number.isSafeInteger(this.#maxFileBytes) || this.#maxFileBytes < 1) throw new RangeError('maxFileBytes must be positive');
  }

  close(): void {}

  async #singleRequest(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Response> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      return await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: combined,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/pdf,application/zip,application/xml,text/xml,text/plain,text/csv,application/octet-stream,*/*;q=0.5',
          'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
          ...extraHeaders,
        },
      });
    } catch (error) {
      if (signal.aborted) throw failure('SPED_CANCELLED', 'CANCELLED', false);
      if (controller.signal.aborted) {
        throw failure('SPED_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, {
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        });
      }
      const cause = error instanceof Error && 'cause' in error && error.cause && typeof error.cause === 'object'
        ? error.cause as Record<string, unknown>
        : undefined;
      throw failure('SPED_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: {
          cause: error instanceof Error ? error.name : 'unknown',
          causeCode: typeof cause?.code === 'string' ? cause.code : undefined,
          causeMessage: typeof cause?.message === 'string' ? cause.message : undefined,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<{ response: Response; url: string }> {
    const initial = new URL(url, SPED_ORIGIN);
    if (initial.origin.toLowerCase() !== SPED_ORIGIN.toLowerCase()) {
      throw failure('SPED_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, { metadata: { url: initial.toString() } });
    }
    const seen = new Set<string>();
    let current = initial.toString();
    for (let redirects = 0; ; redirects += 1) {
      if (seen.has(current)) throw failure('SPED_REDIRECT_LOOP', 'SOURCE_UNAVAILABLE', true);
      seen.add(current);
      const response = await this.#singleRequest(current, signal, extraHeaders);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      if (redirects >= this.#maxRedirects) {
        try { await response.body?.cancel(); } catch {}
        throw failure('SPED_TOO_MANY_REDIRECTS', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      }
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch {}
      if (!location) throw failure('SPED_REDIRECT_WITHOUT_LOCATION', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      const next = new URL(location, current);
      if (next.origin.toLowerCase() !== SPED_ORIGIN.toLowerCase()) {
        throw failure('SPED_CROSS_ORIGIN_REDIRECT', 'SOURCE_UNAVAILABLE', false, {
          httpStatus: response.status,
          metadata: { from: current, to: next.toString() },
        });
      }
      current = next.toString();
    }
  }

  async #checkStatus(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    try { await response.body?.cancel(); } catch {}
    const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
    if (response.status === 408 || response.status === 425) {
      throw failure('SPED_TRANSIENT_HTTP_ERROR', 'HTTP_ERROR', true, { httpStatus: response.status, retryAfterSeconds: retryAfter });
    }
    if (response.status === 429) {
      throw failure('SPED_RATE_LIMITED', 'RATE_LIMITED', true, { httpStatus: 429, retryAfterSeconds: retryAfter });
    }
    if (response.status >= 500) {
      throw failure('SPED_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status, retryAfterSeconds: retryAfter });
    }
    throw failure('SPED_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status });
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch {}
      throw failure('SPED_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
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
        if (total > limit) throw failure('SPED_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch {}
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted) throw failure('SPED_CANCELLED', 'CANCELLED', false);
      throw failure('SPED_BODY_READ_FAILED', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    } finally {
      reader.releaseLock();
    }
  }

  async getHtml(url: string, signal: AbortSignal): Promise<SpedHtmlResponse> {
    const { response, url: finalUrl } = await this.#request(url, signal);
    await this.#checkStatus(response);
    const contentType = cleanContentType(response.headers.get('content-type'));
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      try { await response.body?.cancel(); } catch {}
      throw failure('SPED_INVALID_HTML_CONTENT_TYPE', 'FETCH_ERROR', true, { metadata: { contentType, finalUrl } });
    }
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    rejectUnexpectedHtml(finalUrl, html);
    return { url: finalUrl, html, contentType };
  }

  async downloadFile(
    url: string,
    signal: AbortSignal,
    conditional: { etag?: string; lastModified?: string } = {},
  ): Promise<SpedFileResponse> {
    const headers: Record<string, string> = {};
    if (conditional.etag) headers['if-none-match'] = conditional.etag;
    if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;
    const { response, url: finalUrl } = await this.#request(url, signal, headers);
    if (response.status === 304) {
      try { await response.body?.cancel(); } catch {}
      return {
        status: 'NOT_MODIFIED',
        url: finalUrl,
        ...(response.headers.get('etag') ? { sourceEtag: response.headers.get('etag')! } : {}),
        ...(response.headers.get('last-modified') ? { sourceLastModified: response.headers.get('last-modified')! } : {}),
      };
    }
    await this.#checkStatus(response);
    const headerContentType = cleanContentType(response.headers.get('content-type'));
    const filename = contentDispositionFilename(response.headers.get('content-disposition')) ?? filenameFromUrl(finalUrl);
    const bytes = await this.#readBytes(response, this.#maxFileBytes, signal);
    if (!bytes.length) throw failure('SPED_EMPTY_FILE', 'FETCH_ERROR', true);
    if (headerContentType === 'text/html' || headerContentType === 'application/xhtml+xml' || looksLikeHtml(bytes)) {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
      rejectUnexpectedHtml(finalUrl, html);
      throw failure('SPED_HTML_INSTEAD_OF_FILE', 'SOURCE_UNAVAILABLE', true);
    }
    const mimeType = sniffMimeType(bytes, headerContentType, filename);
    if (!mimeType) {
      throw failure('SPED_UNSUPPORTED_FILE_TYPE', 'FETCH_ERROR', false, {
        metadata: { contentType: headerContentType, filename: filename ?? null, finalUrl },
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
