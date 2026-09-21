import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

const PORTAL_ORIGIN = 'https://www.nfe.fazenda.gov.br';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 96 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface NfeEncatClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
  maxHtmlBytes?: number;
  maxFileBytes?: number;
}

export interface NfeEncatListingResponse {
  url: string;
  html: string;
  contentType: string;
}

export interface NfeEncatDownloadedFile {
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

export interface NfeEncatNotModifiedFile {
  status: 'NOT_MODIFIED';
  url: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

export type NfeEncatFileResponse = NfeEncatDownloadedFile | NfeEncatNotModifiedFile;

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
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function cleanContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
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

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head);
}

function sniffMimeType(bytes: Uint8Array, header: string, filename?: string): string | undefined {
  const lowerName = filename?.toLowerCase() ?? '';
  if (bytes.length >= 5 && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]!) && [0x04, 0x06, 0x08].includes(bytes[3]!)) return 'application/zip';
  const prefix = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 256))).trimStart();
  if (prefix.startsWith('<?xml') || /^<[A-Za-z_][\w:.-]*(?:\s|>)/.test(prefix)) {
    if (header.includes('xml') || lowerName.endsWith('.xml') || prefix.startsWith('<?xml')) return 'application/xml';
  }
  if (header === 'application/pdf' || header === 'application/zip' || header === 'application/x-zip-compressed' || header === 'application/xml' || header === 'text/xml') return header;
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.zip')) return 'application/zip';
  if (lowerName.endsWith('.xml')) return 'application/xml';
  return undefined;
}

function normalizedPageText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function rejectPortalIntermediary(url: string, html: string): void {
  if (/\/consultaRecaptcha\.aspx(?:\/|$|\?)/i.test(url)) {
    throw failure('NFE_ENCAT_CAPTCHA', 'SOURCE_UNAVAILABLE', true);
  }
  const rawLower = html.toLowerCase();
  const text = normalizedPageText(html).toLowerCase();
  if (/g-recaptcha|grecaptcha|recaptcha|\bcaptcha\b/i.test(rawLower)) {
    throw failure('NFE_ENCAT_CAPTCHA', 'SOURCE_UNAVAILABLE', true);
  }
  if (/server error in ['\/]? application|runtime error|erro no servidor|internal server error|the resource cannot be found/i.test(text)) {
    throw failure('NFE_ENCAT_ERROR_PAGE', 'SOURCE_UNAVAILABLE', true);
  }
  if (/cookies? (?:de sessao )?(?:nao|não) (?:estao|estão) habilitad|session cookies? (?:are )?not enabled/i.test(text)) {
    throw failure('NFE_ENCAT_COOKIE_INTERMEDIARY', 'SOURCE_UNAVAILABLE', true);
  }
}

export class NfeEncatClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxHtmlBytes: number;
  readonly #maxFileBytes: number;
  readonly #cookies = new Map<string, string>();

  constructor(options: NfeEncatClientOptions = {}) {
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

  close(): void {
    this.#cookies.clear();
  }

  #captureCookies(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : []);
    for (const value of values) {
      const first = value.split(';', 1)[0]?.trim();
      if (!first) continue;
      const separator = first.indexOf('=');
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      const cookieValue = first.slice(separator + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
      if (!cookieValue || /^(?:deleted|null)$/i.test(cookieValue)) this.#cookies.delete(name);
      else this.#cookies.set(name, cookieValue);
    }
  }

  #cookieHeader(): string | undefined {
    if (!this.#cookies.size) return undefined;
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async #singleRequest(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Response> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const cookie = this.#cookieHeader();
      const response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: combined,
        headers: {
          accept: 'text/html,application/xhtml+xml,application/pdf,application/zip,application/xml;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5',
          'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        },
      });
      this.#captureCookies(response);
      return response;
    } catch (error) {
      if (signal.aborted) throw failure('NFE_ENCAT_CANCELLED', 'CANCELLED', false);
      if (controller.signal.aborted) throw failure('NFE_ENCAT_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
      throw failure('NFE_ENCAT_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: { cause: error instanceof Error ? error.name : 'unknown' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: string, signal: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<{ response: Response; url: string }> {
    const initial = new URL(url);
    if (initial.origin.toLowerCase() !== PORTAL_ORIGIN.toLowerCase()) throw failure('NFE_ENCAT_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false);
    const seen = new Set<string>();
    let current = initial.toString();
    for (let redirects = 0; ; redirects += 1) {
      if (seen.has(current)) throw failure('NFE_ENCAT_REDIRECT_LOOP', 'SOURCE_UNAVAILABLE', true);
      seen.add(current);
      const response = await this.#singleRequest(current, signal, extraHeaders);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      if (redirects >= this.#maxRedirects) {
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw failure('NFE_ENCAT_TOO_MANY_REDIRECTS', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      }
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (!location) throw failure('NFE_ENCAT_REDIRECT_WITHOUT_LOCATION', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status });
      const next = new URL(location, current);
      if (next.origin.toLowerCase() !== PORTAL_ORIGIN.toLowerCase()) throw failure('NFE_ENCAT_CROSS_ORIGIN_REDIRECT', 'SOURCE_UNAVAILABLE', false, { httpStatus: response.status });
      current = next.toString();
    }
  }

  async #checkStatus(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
    if (response.status === 408 || response.status === 425) {
      throw failure('NFE_ENCAT_TRANSIENT_HTTP_ERROR', 'HTTP_ERROR', true, { httpStatus: response.status, retryAfterSeconds: retryAfter });
    }
    if (response.status === 429) {
      throw failure('NFE_ENCAT_RATE_LIMITED', 'RATE_LIMITED', true, { httpStatus: 429, retryAfterSeconds: retryAfter });
    }
    if (response.status >= 500) {
      throw failure('NFE_ENCAT_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, { httpStatus: response.status, retryAfterSeconds: retryAfter });
    }
    throw failure('NFE_ENCAT_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status });
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('NFE_ENCAT_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
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
        if (total > limit) throw failure('NFE_ENCAT_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch { /* ignore */ }
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted) throw failure('NFE_ENCAT_CANCELLED', 'CANCELLED', false);
      throw failure('NFE_ENCAT_BODY_READ_FAILED', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
    } finally {
      reader.releaseLock();
    }
  }

  async getListing(url: string, signal: AbortSignal): Promise<NfeEncatListingResponse> {
    const { response, url: finalUrl } = await this.#request(url, signal);
    await this.#checkStatus(response);
    const contentType = cleanContentType(response.headers.get('content-type'));
    if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('NFE_ENCAT_INVALID_LISTING_CONTENT_TYPE', 'FETCH_ERROR', true, { metadata: { contentType } });
    }
    const bytes = await this.#readBytes(response, this.#maxHtmlBytes, signal);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    rejectPortalIntermediary(finalUrl, html);
    return { url: finalUrl, html, contentType };
  }

  async downloadFile(
    url: string,
    signal: AbortSignal,
    conditional: { etag?: string; lastModified?: string } = {},
  ): Promise<NfeEncatFileResponse> {
    const requestHeaders: Record<string, string> = {};
    if (conditional.etag) requestHeaders['if-none-match'] = conditional.etag;
    if (conditional.lastModified) requestHeaders['if-modified-since'] = conditional.lastModified;
    const { response, url: finalUrl } = await this.#request(url, signal, requestHeaders);
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
    if (!bytes.length) throw failure('NFE_ENCAT_EMPTY_FILE', 'FETCH_ERROR', true);
    if (headerContentType === 'text/html' || headerContentType === 'application/xhtml+xml' || looksLikeHtml(bytes)) {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
      rejectPortalIntermediary(finalUrl, html);
      throw failure('NFE_ENCAT_HTML_INSTEAD_OF_FILE', 'SOURCE_UNAVAILABLE', true);
    }
    const mimeType = sniffMimeType(bytes, headerContentType, filename);
    if (!mimeType) throw failure('NFE_ENCAT_UNSUPPORTED_FILE_TYPE', 'FETCH_ERROR', false, { metadata: { contentType: headerContentType, filename: filename ?? null } });
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
