import { createHash } from 'node:crypto';

import { ConnectorError, type ConnectorErrorKind } from './connector.error.js';

/**
 * Client for the official JSON APIs used by the DOE-SP portal
 * (https://doe.sp.gov.br, Prodesp). Both hosts are public and require no
 * authentication. There is no ETag/Last-Modified support, so incremental
 * behaviour is implemented with checkpoints, not conditional requests.
 */
export const DOE_SP_PORTAL_ORIGIN = 'https://doe.sp.gov.br';
export const DOE_SP_SEARCH_API = 'https://do-api-web-search.doe.sp.gov.br/';
export const DOE_SP_PDF_API = 'https://do-api-publication-pdf.doe.sp.gov.br/';

const ALLOWED_ORIGINS = new Set([
  'https://do-api-web-search.doe.sp.gov.br',
  'https://do-api-publication-pdf.doe.sp.gov.br',
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface DoeSpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxJsonBytes?: number;
  maxFileBytes?: number;
}

export interface DoeSpJsonResponse {
  url: string;
  status: number;
  body: unknown;
  rawSha256: string;
  sizeBytes: number;
}

export interface DoeSpDownloadedFile {
  url: string;
  bytes: Uint8Array;
  rawSha256: string;
  sizeBytes: number;
  mimeType: string;
  name?: string;
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

export function sniffDoeSpFileMime(bytes: Uint8Array, header: string, name?: string): string | undefined {
  if (bytes.length >= 5 && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  const lower = (name ?? '').toLowerCase();
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return 'application/zip';
  }
  if (header && header !== 'application/octet-stream' && header !== 'text/html') return header;
  if (lower.endsWith('.pdf')) return undefined; // declared PDF without PDF magic: reject
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.txt')) return 'text/plain';
  return undefined;
}

/** The API returns absolute URLs with http://; always use https. */
export function normalizeDoeSpApiUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.toString();
}

export class DoeSpClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxJsonBytes: number;
  readonly #maxFileBytes: number;
  requestCount = 0;
  downloadedBytes = 0;

  constructor(options: DoeSpClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async #request(url: string, signal: AbortSignal, accept: string): Promise<Response> {
    const parsed = new URL(url);
    if (!ALLOWED_ORIGINS.has(parsed.origin)) {
      throw failure('DOE_SP_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, { metadata: { origin: parsed.origin } });
    }
    if (signal.aborted) throw failure('DOE_SP_CANCELLED', 'CANCELLED', false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    this.requestCount += 1;
    try {
      const response = await this.#fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
        headers: {
          accept,
          'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
        },
      });
      return response;
    } catch (error) {
      if (signal.aborted) throw failure('DOE_SP_CANCELLED', 'CANCELLED', false);
      if (controller.signal.aborted) {
        throw failure('DOE_SP_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, { retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS });
      }
      const failureCause = error instanceof Error
        ? (error as Error & { cause?: { name?: unknown; code?: unknown; message?: unknown; address?: unknown; port?: unknown } }).cause
        : undefined;
      throw failure('DOE_SP_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: {
          url: parsed.toString(),
          cause: error instanceof Error ? error.name : 'unknown',
          ...(typeof failureCause?.name === 'string' ? { causeName: failureCause.name } : {}),
          ...(typeof failureCause?.code === 'string' ? { causeCode: failureCause.code } : {}),
          ...(typeof failureCause?.message === 'string' ? { causeMessage: failureCause.message } : {}),
          ...(typeof failureCause?.address === 'string' ? { causeAddress: failureCause.address } : {}),
          ...(typeof failureCause?.port === 'number' ? { causePort: failureCause.port } : {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #checkStatus(response: Response, allowNotFound: boolean): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    if (allowNotFound && response.status === 404) return;
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
    if (response.status === 429) {
      throw failure('DOE_SP_RATE_LIMITED', 'RATE_LIMITED', true, { httpStatus: 429, retryAfterSeconds: retryAfter });
    }
    if (response.status === 408 || response.status === 425 || response.status >= 500) {
      throw failure('DOE_SP_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, {
        httpStatus: response.status,
        retryAfterSeconds: retryAfter,
      });
    }
    throw failure('DOE_SP_HTTP_ERROR', 'HTTP_ERROR', false, { httpStatus: response.status });
  }

  async #readBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('DOE_SP_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
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
        if (total > limit) throw failure('DOE_SP_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
        chunks.push(next.value);
      }
      this.downloadedBytes += total;
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch { /* ignore */ }
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted) throw failure('DOE_SP_CANCELLED', 'CANCELLED', false);
      throw failure('DOE_SP_BODY_READ_FAILED', 'NETWORK_ERROR', true);
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * GET a JSON document. `allowNotFound` returns a 404 as a regular response
   * (the editions/status endpoint answers 404 for dates without editions).
   */
  async getJson(
    base: string,
    path: string,
    params: Record<string, string> = {},
    signal: AbortSignal,
    options: { allowNotFound?: boolean } = {},
  ): Promise<DoeSpJsonResponse> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await this.#request(url.toString(), signal, 'application/json');
    await this.#checkStatus(response, options.allowNotFound === true);
    const contentType = cleanContentType(response.headers.get('content-type'));
    const bytes = await this.#readBytes(response, this.#maxJsonBytes, signal);
    if (response.status === 404) {
      return { url: url.toString(), status: 404, body: null, rawSha256: sha256(bytes), sizeBytes: bytes.byteLength };
    }
    if (contentType !== 'application/json' && contentType !== 'application/problem+json') {
      throw failure(
        looksLikeHtml(bytes) ? 'DOE_SP_HTML_INSTEAD_OF_JSON' : 'DOE_SP_INVALID_CONTENT_TYPE',
        'SOURCE_UNAVAILABLE',
        true,
        { metadata: { contentType } },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw failure('DOE_SP_INVALID_JSON', 'FETCH_ERROR', true, { metadata: { url: url.toString() } });
    }
    return { url: url.toString(), status: response.status, body, rawSha256: sha256(bytes), sizeBytes: bytes.byteLength };
  }

  /** Binary download of a publication attachment. */
  async downloadAttachment(attachmentId: string, name: string | undefined, signal: AbortSignal): Promise<DoeSpDownloadedFile> {
    const url = attachmentUrl(attachmentId);
    const response = await this.#request(url, signal, 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5');
    await this.#checkStatus(response, false);
    const header = cleanContentType(response.headers.get('content-type'));
    const bytes = await this.#readBytes(response, this.#maxFileBytes, signal);
    if (!bytes.length) throw failure('DOE_SP_EMPTY_FILE', 'FETCH_ERROR', true);
    if (header === 'text/html' || looksLikeHtml(bytes)) throw failure('DOE_SP_HTML_INSTEAD_OF_FILE', 'SOURCE_UNAVAILABLE', true);
    const mimeType = sniffDoeSpFileMime(bytes, header, name);
    if (!mimeType) {
      throw failure('DOE_SP_UNSUPPORTED_FILE_TYPE', 'FETCH_ERROR', false, { metadata: { contentType: header } });
    }
    return {
      url,
      bytes,
      rawSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mimeType,
      ...(name ? { name } : {}),
    };
  }

  /**
   * Authenticated per-publication PDF. The API returns
   * `{ name, content: <base64 PDF>, contentType }`; the SHA-256 is computed
   * over the decoded PDF bytes (the official file), not the JSON envelope.
   */
  async downloadAuthenticatedPdf(authCode: string, signal: AbortSignal): Promise<DoeSpDownloadedFile> {
    const response = await this.getJson(DOE_SP_SEARCH_API, authenticatedPdfPath(authCode), {}, signal);
    const body = response.body as Record<string, unknown> | null;
    const content = typeof body?.content === 'string' ? body.content : undefined;
    if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
      throw failure('DOE_SP_INVALID_AUTHENTICATED_PDF', 'FETCH_ERROR', false);
    }
    const bytes = new Uint8Array(Buffer.from(content, 'base64'));
    if (bytes.length < 5 || new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw failure('DOE_SP_INVALID_AUTHENTICATED_PDF', 'FETCH_ERROR', false);
    }
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    return {
      url: response.url,
      bytes,
      rawSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mimeType: 'application/pdf',
      ...(name ? { name } : {}),
    };
  }
}

export function attachmentUrl(attachmentId: string): string {
  return new URL('v2/publications/attachment/downloadattachment/' + encodeURIComponent(attachmentId), DOE_SP_SEARCH_API).toString();
}

export function authenticatedPdfPath(authCode: string): string {
  return 'v2/authentication/download/' + encodeURIComponent(authCode);
}

export function authenticatedPdfUrl(authCode: string): string {
  return new URL(authenticatedPdfPath(authCode), DOE_SP_SEARCH_API).toString();
}

export function publicationPageUrl(slug: string): string {
  const clean = slug.replace(/^\/+/, '');
  return DOE_SP_PORTAL_ORIGIN + '/' + clean.split('/').map(encodeURIComponent).join('/');
}
