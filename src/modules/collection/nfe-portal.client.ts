import { createHash } from 'node:crypto';

import { ConnectorError } from './connector.error.js';

const PORTAL_ORIGIN = 'https://www.nfe.fazenda.gov.br';
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 96 * 1024 * 1024;

export interface NfePortalHttpResult {
  url: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

export interface NfePortalHtmlResult
  extends NfePortalHttpResult {
  html: string;
}

export interface NfePortalDownload
  extends NfePortalHttpResult {
  bytes: Uint8Array;
  rawSha256: string;
  filename?: string;
}

export interface NfePortalClientOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  userAgent?: string;
}

function retryAfterSeconds(
  response: Response,
): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;

  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return numeric;
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(
      0,
      Math.ceil((date - Date.now()) / 1000),
    );
  }

  return undefined;
}

function decodeHtml(buffer: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', {
    fatal: false,
  }).decode(buffer);

  if (
    utf8.includes('\uFFFD') &&
    !/<meta[^>]+charset\s*=\s*["']?utf-?8/i.test(utf8)
  ) {
    try {
      return new TextDecoder('windows-1252', {
        fatal: false,
      }).decode(buffer);
    } catch {
      return utf8;
    }
  }

  return utf8;
}

function isPortalHost(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname.toLowerCase() ===
      'www.nfe.fazenda.gov.br'
  );
}

function responseError(
  response: Response,
  url: string,
): ConnectorError {
  const retryable =
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;

  const kind =
    response.status === 429
      ? 'RATE_LIMITED'
      : response.status >= 500
        ? 'SOURCE_UNAVAILABLE'
        : 'HTTP_ERROR';

  return new ConnectorError(
    `Portal NF-e returned HTTP ${response.status} for ${url}`,
    {
      kind,
      code:
        response.status === 429
          ? 'NFE_PORTAL_RATE_LIMITED'
          : response.status >= 500
            ? 'NFE_PORTAL_UNAVAILABLE'
            : 'NFE_PORTAL_HTTP_ERROR',
      retryable,
      httpStatus: response.status,
      ...(retryAfterSeconds(response) !== undefined
        ? {
            retryAfterSeconds:
              retryAfterSeconds(response)!,
          }
        : {}),
      metadata: {
        url,
        statusText: response.statusText,
      },
    },
  );
}

function contentDispositionFilename(
  value: string | null,
): string | undefined {
  if (!value) return undefined;

  const utf8 =
    /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      return utf8;
    }
  }

  const simple =
    /filename\s*=\s*["']?([^;"']+)/i.exec(value)?.[1];
  return simple?.trim();
}

async function boundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const length = Number.parseInt(
    response.headers.get('content-length') ?? '',
    10,
  );

  if (
    Number.isFinite(length) &&
    length > maxBytes
  ) {
    throw new ConnectorError(
      'Portal NF-e response exceeds configured maximum size',
      {
        kind: 'PROCESSING_ERROR',
        code: 'NFE_PORTAL_BODY_TOO_LARGE',
        retryable: false,
        metadata: {
          contentLength: length,
          maxBytes,
          url: response.url,
        },
      },
    );
  }

  const bytes = new Uint8Array(
    await response.arrayBuffer(),
  );

  if (bytes.byteLength > maxBytes) {
    throw new ConnectorError(
      'Portal NF-e response exceeds configured maximum size',
      {
        kind: 'PROCESSING_ERROR',
        code: 'NFE_PORTAL_BODY_TOO_LARGE',
        retryable: false,
        metadata: {
          sizeBytes: bytes.byteLength,
          maxBytes,
          url: response.url,
        },
      },
    );
  }

  return bytes;
}

function looksLikeChallenge(
  html: string,
  finalUrl: string,
): boolean {
  const normalized = html
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const path = new URL(finalUrl).pathname.toLowerCase();

  return (
    /recaptcha|g-recaptcha|captcha/.test(normalized) &&
    !/notas tecnicas|informes tecnicos|esquemas xml|manuais|diversos/.test(
      normalized,
    )
  ) || (
    path.includes('consultarecaptcha.aspx') &&
    !/notas tecnicas|informes tecnicos|esquemas xml|manuais|diversos/.test(
      normalized,
    )
  );
}

function looksLikeMaintenance(html: string): boolean {
  const normalized = html
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return (
    normalized.includes('sistema em manutencao') ||
    normalized.includes('manutencao programada') ||
    normalized.includes('servico temporariamente indisponivel')
  );
}

export class NfePortalClient {
  readonly #fetch: typeof fetch;
  readonly #maxBodyBytes: number;
  readonly #userAgent: string;
  readonly #cookies = new Map<string, string>();

  constructor(
    options: NfePortalClientOptions = {},
  ) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxBodyBytes =
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#userAgent =
      options.userAgent ??
      'RadarFiscal/0.1 (+https://github.com/fabiojuniort-cyber/radar-fiscal-backend; Portal NF-e connector)';
  }

  #cookieHeader(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  #captureCookies(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const match = /^([^=;\s]+)=([^;]*)/.exec(raw);
      if (!match?.[1]) continue;

      if (match[2] === '') {
        this.#cookies.delete(match[1]);
      } else {
        this.#cookies.set(match[1], match[2] ?? '');
      }
    }
  }

  async #request(
    inputUrl: string,
    accept: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = new URL(inputUrl);

    if (!isPortalHost(current)) {
      throw new ConnectorError(
        'Portal NF-e request attempted outside official origin',
        {
          kind: 'FETCH_ERROR',
          code: 'NFE_PORTAL_UNEXPECTED_ORIGIN',
          retryable: false,
          metadata: {
            url: current.toString(),
          },
        },
      );
    }

    for (
      let hop = 0;
      hop <= MAX_REDIRECTS;
      hop += 1
    ) {
      let response: Response;

      try {
        const cookie = this.#cookieHeader();

        response = await this.#fetch(
          current.toString(),
          {
            method: 'GET',
            redirect: 'manual',
            signal,
            headers: {
              Accept: accept,
              'Accept-Language': 'pt-BR,pt;q=0.9',
              'User-Agent': this.#userAgent,
              ...(cookie ? { Cookie: cookie } : {}),
            },
          },
        );
      } catch (error) {
        if (signal.aborted) throw error;

        throw new ConnectorError(
          'Portal NF-e network request failed',
          {
            kind: 'NETWORK_ERROR',
            code: 'NFE_PORTAL_NETWORK_ERROR',
            retryable: true,
            metadata: {
              url: current.toString(),
            },
            cause: error,
          },
        );
      }

      this.#captureCookies(response);

      if (
        response.status < 300 ||
        response.status >= 400
      ) {
        return response;
      }

      const location =
        response.headers.get('location');

      if (!location) {
        return response;
      }

      const target = new URL(location, current);

      if (!isPortalHost(target)) {
        await response.body?.cancel();

        throw new ConnectorError(
          'Portal NF-e redirected outside official origin',
          {
            kind: 'FETCH_ERROR',
            code: 'NFE_PORTAL_UNEXPECTED_REDIRECT',
            retryable: false,
            httpStatus: response.status,
            metadata: {
              from: current.toString(),
              to: target.toString(),
            },
          },
        );
      }

      await response.body?.cancel();
      current = target;
    }

    throw new ConnectorError(
      'Portal NF-e redirect limit exceeded',
      {
        kind: 'FETCH_ERROR',
        code: 'NFE_PORTAL_REDIRECT_LOOP',
        retryable: true,
        metadata: {
          url: inputUrl,
          maxRedirects: MAX_REDIRECTS,
        },
      },
    );
  }

  async fetchHtml(
    url: string,
    signal: AbortSignal,
  ): Promise<NfePortalHtmlResult> {
    const response = await this.#request(
      url,
      'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      signal,
    );

    if (!response.ok) {
      throw responseError(response, url);
    }

    const bytes = await boundedBytes(
      response,
      Math.min(this.#maxBodyBytes, 8 * 1024 * 1024),
    );
    const html = decodeHtml(bytes);
    const finalUrl = response.url || url;

    if (looksLikeMaintenance(html)) {
      throw new ConnectorError(
        'Portal NF-e is under maintenance',
        {
          kind: 'SOURCE_UNAVAILABLE',
          code: 'NFE_PORTAL_MAINTENANCE',
          retryable: true,
          metadata: {
            url: finalUrl,
          },
        },
      );
    }

    if (looksLikeChallenge(html, finalUrl)) {
      throw new ConnectorError(
        'Portal NF-e returned an anti-bot challenge',
        {
          kind: 'SOURCE_UNAVAILABLE',
          code: 'NFE_PORTAL_CHALLENGE',
          retryable: true,
          metadata: {
            url: finalUrl,
          },
        },
      );
    }

    return {
      html,
      url: finalUrl,
      ...(response.headers.get('content-type')
        ? {
            contentType:
              response.headers.get('content-type')!,
          }
        : {}),
      ...(response.headers.get('etag')
        ? { etag: response.headers.get('etag')! }
        : {}),
      ...(response.headers.get('last-modified')
        ? {
            lastModified:
              response.headers.get('last-modified')!,
          }
        : {}),
    };
  }

  async download(
    url: string,
    signal: AbortSignal,
  ): Promise<NfePortalDownload> {
    const response = await this.#request(
      url,
      'application/pdf,application/zip,application/octet-stream,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*;q=0.1',
      signal,
    );

    if (!response.ok) {
      throw responseError(response, url);
    }

    const bytes = await boundedBytes(
      response,
      this.#maxBodyBytes,
    );

    const contentType =
      response.headers.get('content-type') ??
      undefined;

    if (
      /text\/html|application\/xhtml\+xml/i.test(
        contentType ?? '',
      )
    ) {
      const html = decodeHtml(bytes);

      if (looksLikeMaintenance(html)) {
        throw new ConnectorError(
          'Portal NF-e returned maintenance HTML instead of a document',
          {
            kind: 'SOURCE_UNAVAILABLE',
            code: 'NFE_PORTAL_MAINTENANCE',
            retryable: true,
            metadata: {
              url: response.url || url,
            },
          },
        );
      }

      if (looksLikeChallenge(html, response.url || url)) {
        throw new ConnectorError(
          'Portal NF-e returned an anti-bot challenge instead of a document',
          {
            kind: 'SOURCE_UNAVAILABLE',
            code: 'NFE_PORTAL_CHALLENGE',
            retryable: true,
            metadata: {
              url: response.url || url,
            },
          },
        );
      }

      throw new ConnectorError(
        'Portal NF-e returned HTML instead of the expected document',
        {
          kind: 'FETCH_ERROR',
          code: 'NFE_PORTAL_INVALID_DOWNLOAD',
          retryable: true,
          metadata: {
            url: response.url || url,
            contentType,
          },
        },
      );
    }

    return {
      bytes,
      rawSha256: createHash('sha256')
        .update(bytes)
        .digest('hex'),
      url: response.url || url,
      ...(contentType ? { contentType } : {}),
      ...(contentDispositionFilename(
        response.headers.get('content-disposition'),
      )
        ? {
            filename: contentDispositionFilename(
              response.headers.get('content-disposition'),
            )!,
          }
        : {}),
      ...(response.headers.get('etag')
        ? { etag: response.headers.get('etag')! }
        : {}),
      ...(response.headers.get('last-modified')
        ? {
            lastModified:
              response.headers.get('last-modified')!,
          }
        : {}),
    };
  }
}
