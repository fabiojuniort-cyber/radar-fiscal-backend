import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

const ORIGIN = 'https://inlabs.in.gov.br';
const COOKIE = 'inlabs_session_cookie';
const DEFAULT_RETRY_AFTER_SECONDS = 120;
const MAINTENANCE_RETRY_AFTER_SECONDS = 300;
const MAX_AUTHENTICATED_REDIRECTS = 3;
export type InlabsXmlSection = 'DO1' | 'DO2' | 'DO3' | 'DO1E' | 'DO2E' | 'DO3E';
export type InlabsPdfSection = 'do1' | 'do2' | 'do3';

export interface InlabsCredentials { email: string; password: string }
export interface InlabsClientOptions {
  credentials: () => InlabsCredentials | undefined;
  fetch?: typeof fetch;
  maxArchiveBytes?: number;
}

export type InlabsDownload = {
  status: 'AVAILABLE';
  officialUrl: string;
  filename: string;
  bytes: Uint8Array;
  rawSha256: string;
} | {
  // A 404 is absence at the time of this request, never proof of an empty day.
  status: 'NOT_AVAILABLE';
  officialUrl: string;
  filename: string;
};

function fail(code: string, kind: ConstructorParameters<typeof ConnectorError>[1]['kind'],
  retryable = false, httpStatus?: number, retryAfterSeconds?: number): ConnectorError {
  // Never propagate HTTP bodies, request headers, credentials or low-level causes.
  return new ConnectorError(code, {
    code, kind, retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw fail('INLABS_INVALID_DATE', 'PROCESSING_ERROR');
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : undefined;
}

function checkMaintenance(html: string, response: Response): void {
  const text = html.replace(/<[^>]*>/g, ' ')
    .replace(/&ccedil;/gi, 'c').replace(/&atilde;/gi, 'a')
    .replace(/&aacute;/gi, 'a').replace(/&nbsp;/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  if (/sistema em manutencao programada|o sistema esta passando por manutencao programada/i.test(text)) {
    throw fail('INLABS_MAINTENANCE', 'SOURCE_UNAVAILABLE', true,
      response.status, retryAfter(response) ?? MAINTENANCE_RETRY_AFTER_SECONDS);
  }
}

/** Transport based on the official INLABS scripts, not a registered collection connector.
 * The caller owns timeout/cancellation and retry via the existing collection executor.
 * Create one client per attempt; session cookies live only in private memory.
 */
export class InlabsClient {
  readonly #fetch: typeof fetch;
  readonly #credentials: InlabsClientOptions['credentials'];
  readonly #maxBytes: number;
  #cookie: string | undefined;

  constructor(options: InlabsClientOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#credentials = options.credentials;
    this.#maxBytes = options.maxArchiveBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw fail('INLABS_INVALID_SIZE_LIMIT', 'PROCESSING_ERROR');
    }
  }

  close(): void { this.#cookie = undefined; }

  #sessionCookie(response: Response): string | undefined {
    return response.headers.getSetCookie()
      .map(value => value.match(/^inlabs_session_cookie=([^;\s]+)(?:;|$)/)?.[1])
      .find(value => value !== undefined && value !== 'deleted');
  }

  #refreshSessionCookie(response: Response): void {
    const cookie = this.#sessionCookie(response);
    if (cookie && /^[A-Za-z0-9._~%+-]+$/.test(cookie)) this.#cookie = `${COOKIE}=${cookie}`;
  }

  async #request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    try {
      return await this.#fetch(url, { ...init, redirect: 'manual', signal });
    } catch {
      signal.throwIfAborted();
      throw fail('INLABS_NETWORK_ERROR', 'NETWORK_ERROR', true,
        undefined, DEFAULT_RETRY_AFTER_SECONDS);
    }
  }

  async #discard(response: Response): Promise<void> {
    try { await response.body?.cancel(); } catch { /* Never leak response errors. */ }
  }

  async #checkStatus(response: Response): Promise<void> {
    if (response.status >= 200 && response.status < 300) return;
    await this.#discard(response);
    if (response.status === 401) {
      this.close();
      throw fail('INLABS_AUTH_FAILED', 'FETCH_ERROR', false, 401);
    }
    if (response.status === 403) {
      this.close();
      // A WAF block is not proof that the password is wrong.
      throw fail('INLABS_ACCESS_DENIED', 'SOURCE_UNAVAILABLE', false, 403);
    }
    if (response.status === 429) {
      throw fail('INLABS_RATE_LIMITED', 'RATE_LIMITED', true, 429,
        retryAfter(response) ?? DEFAULT_RETRY_AFTER_SECONDS);
    }
    if (response.status >= 500) {
      throw fail('INLABS_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, response.status,
        retryAfter(response) ?? DEFAULT_RETRY_AFTER_SECONDS);
    }
    throw fail('INLABS_HTTP_ERROR', 'HTTP_ERROR', response.status === 408, response.status);
  }

  async #read(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const size = response.headers.get('content-length');
    if (size && /^\d+$/.test(size) && Number(size) > limit) {
      await this.#discard(response);
      throw fail('INLABS_RESPONSE_TOO_LARGE', 'FETCH_ERROR');
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
        if (total > limit) throw fail('INLABS_RESPONSE_TOO_LARGE', 'FETCH_ERROR');
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, total);
    } catch (error) {
      try { await reader.cancel(); } catch { /* Keep sanitized error. */ }
      signal.throwIfAborted();
      if (error instanceof ConnectorError) throw error;
      throw fail('INLABS_BODY_READ_FAILED', 'NETWORK_ERROR', true,
        undefined, DEFAULT_RETRY_AFTER_SECONDS);
    } finally { reader.releaseLock(); }
  }

  async login(signal: AbortSignal): Promise<void> {
    this.close();
    const credentials = this.#credentials();
    if (!credentials?.email.trim() || !credentials.password) {
      throw fail('INLABS_CREDENTIALS_MISSING', 'FETCH_ERROR');
    }
    const response = await this.#request(`${ORIGIN}/logar.php`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'origem': '736372697074',
      },
      body: new URLSearchParams({ email: credentials.email.trim(), password: credentials.password }),
    }, signal);
    // The official script checks this cookie. The authenticated index must still be
    // verified before interpreting any missing archive as NOT_AVAILABLE.
    const cookie = this.#sessionCookie(response);
    const location = response.headers.get('location');
    if ([301, 302, 303].includes(response.status) && location) {
      let target: URL;
      try { target = new URL(location, ORIGIN); } catch {
        await this.#discard(response);
        throw fail('INLABS_UNEXPECTED_REDIRECT', 'FETCH_ERROR');
      }
      if (target.origin !== ORIGIN || target.pathname !== '/index.php' || target.username || target.password) {
        await this.#discard(response);
        throw fail('INLABS_AUTH_FAILED', 'FETCH_ERROR');
      }
      await this.#discard(response);
    } else {
      await this.#checkStatus(response);
      const html = new TextDecoder().decode(await this.#read(response, 2 * 1024 * 1024, signal));
      checkMaintenance(html, response);
    }
    if (!cookie || !/^[A-Za-z0-9._~%+-]+$/.test(cookie)) {
      throw fail('INLABS_AUTH_FAILED', 'FETCH_ERROR');
    }
    this.#cookie = `${COOKIE}=${cookie}`;
  }

  async #authenticatedGet(url: string, signal: AbortSignal): Promise<Response> {
    if (!this.#cookie) throw fail('INLABS_AUTH_REQUIRED', 'FETCH_ERROR');

    let currentUrl = new URL(url);

    for (let hop = 0; hop <= MAX_AUTHENTICATED_REDIRECTS; hop += 1) {
      const response = await this.#request(currentUrl.toString(), {
        headers: { cookie: this.#cookie, origem: '736372697074' },
      }, signal);

      // requests.Session()/curl -L in the official INLABS examples follow redirects
      // and accept session-cookie rotation. We mirror that behavior only for bounded,
      // same-origin redirects, so credentials/cookies are never forwarded elsewhere.
      this.#refreshSessionCookie(response);

      if (!(response.status >= 300 && response.status < 400)) {
        return response;
      }

      const location = response.headers.get('location');
      if (!location) {
        this.close();
        await this.#discard(response);
        throw fail('INLABS_SESSION_REDIRECT', 'FETCH_ERROR', true,
          response.status, DEFAULT_RETRY_AFTER_SECONDS);
      }

      let target: URL;
      try {
        target = new URL(location, currentUrl);
      } catch {
        this.close();
        await this.#discard(response);
        throw fail('INLABS_UNEXPECTED_REDIRECT', 'FETCH_ERROR', true,
          response.status, DEFAULT_RETRY_AFTER_SECONDS);
      }

      if (
        target.origin !== ORIGIN ||
        target.username ||
        target.password
      ) {
        this.close();
        await this.#discard(response);
        throw fail('INLABS_UNEXPECTED_REDIRECT', 'FETCH_ERROR', false,
          response.status);
      }

      if (
        target.pathname === '/logar.php' ||
        target.pathname === '/acessar.php'
      ) {
        this.close();
        await this.#discard(response);
        throw fail('INLABS_SESSION_REDIRECT', 'FETCH_ERROR', true,
          response.status, DEFAULT_RETRY_AFTER_SECONDS);
      }

      await this.#discard(response);
      currentUrl = target;
    }

    this.close();
    throw fail('INLABS_REDIRECT_LOOP', 'FETCH_ERROR', true,
      undefined, DEFAULT_RETRY_AFTER_SECONDS);
  }

  async readDailyIndex(date: string, signal: AbortSignal): Promise<string> {
    validateDate(date);
    const response = await this.#authenticatedGet(`${ORIGIN}/index.php?p=${date}`, signal);
    await this.#checkStatus(response);
    const html = new TextDecoder().decode(await this.#read(response, 2 * 1024 * 1024, signal));
    checkMaintenance(html, response);
    if (/logar\.php|name\s*=\s*["']password["']/i.test(html)) {
      this.close();
      throw fail('INLABS_AUTH_FAILED', 'FETCH_ERROR');
    }
    if (/requested URL was rejected|access denied|request rejected/i.test(html)) {
      throw fail('INLABS_ACCESS_DENIED', 'SOURCE_UNAVAILABLE');
    }
    // Exact listing/schema discovery is intentionally deferred to authenticated evidence.
    if (!/<(?:html|a|table|div)\b/i.test(html)) {
      throw fail('INLABS_INVALID_INDEX', 'PROCESSING_ERROR');
    }
    return html;
  }

  async downloadXml(date: string, section: InlabsXmlSection, signal: AbortSignal): Promise<InlabsDownload> {
    validateDate(date);
    if (!/^DO[123]E?$/.test(section)) throw fail('INLABS_INVALID_SECTION', 'PROCESSING_ERROR');
    return this.#download(date, `${date}-${section}.zip`, 'ZIP', signal);
  }

  async downloadPdf(date: string, section: InlabsPdfSection, signal: AbortSignal,
    extra?: string): Promise<InlabsDownload> {
    validateDate(date);
    if (!/^do[123]$/.test(section) || (extra !== undefined && !/^[A-Z]$/.test(extra))) {
      throw fail('INLABS_INVALID_SECTION', 'PROCESSING_ERROR');
    }
    const filename = `${date.replaceAll('-', '_')}_ASSINADO_${section}${extra ? `_extra_${extra}` : ''}.pdf`;
    return this.#download(date, filename, 'PDF', signal);
  }

  async #download(date: string, filename: string, kind: 'ZIP' | 'PDF', signal: AbortSignal): Promise<InlabsDownload> {
    const officialUrl = `${ORIGIN}/index.php?${new URLSearchParams({ p: date, dl: filename })}`;
    const response = await this.#authenticatedGet(officialUrl, signal);
    if (response.status === 404) {
      await this.#discard(response);
      // Validate the session independently; login redirects disguised as 404 must not
      // make a failed consultation look like an unpublished edition.
      await this.readDailyIndex(date, signal);
      return { status: 'NOT_AVAILABLE', officialUrl, filename };
    }
    await this.#checkStatus(response);
    const bytes = await this.#read(response, this.#maxBytes, signal);
    const valid = kind === 'PDF' ? new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
      : bytes[0] === 0x50 && bytes[1] === 0x4b &&
        ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
    // Inspect only non-binary responses: a real act may itself discuss maintenance.
    if (!valid) checkMaintenance(new TextDecoder().decode(bytes.subarray(0, 2 * 1024 * 1024)), response);
    const prefix = new TextDecoder().decode(bytes.subarray(0, 1024));
    if (/logar\.php|name\s*=\s*["']password["']/i.test(prefix)) {
      this.close();
      throw fail('INLABS_AUTH_FAILED', 'FETCH_ERROR');
    }
    if (/requested URL was rejected|access denied|request rejected/i.test(prefix)) {
      throw fail('INLABS_ACCESS_DENIED', 'SOURCE_UNAVAILABLE');
    }
    if (!valid) throw fail('INLABS_INVALID_DOWNLOAD', 'PROCESSING_ERROR');
    // Magic validation is transport validation only; ZIP integrity/XML parsing follows
    // in the connector once official samples and decompression limits are established.
    return { status: 'AVAILABLE', officialUrl, filename, bytes,
      rawSha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
