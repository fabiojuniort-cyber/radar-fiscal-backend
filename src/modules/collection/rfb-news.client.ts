import { ConnectorError } from './connector.error.js';

export const RFB_NEWS_ORIGIN = 'https://www.gov.br';
export const RFB_NEWS_LIST_URL =
  'https://www.gov.br/receitafederal/pt-br/assuntos/noticias/ultimas-noticias';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface RfbNewsClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxHtmlBytes?: number;
}

export interface RfbNewsHtmlResponse {
  url: string;
  html: string;
  sourceEtag?: string;
  sourceLastModified?: string;
}

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
    ...(options.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: options.retryAfterSeconds }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.ceil((parsed - Date.now()) / 1_000))
    : undefined;
}

function assertAllowedUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin.toLowerCase() !== RFB_NEWS_ORIGIN) {
    throw failure('RFB_NEWS_CROSS_ORIGIN_REQUEST', 'PROCESSING_ERROR', false, {
      metadata: { url: url.toString() },
    });
  }
  return url;
}

function rejectIntermediary(html: string): void {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (/captcha|nao sou um robo|access denied|forbidden/.test(text)) {
    throw failure('RFB_NEWS_INTERMEDIARY_BLOCK', 'SOURCE_UNAVAILABLE', true, {
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
    });
  }
  if (/internal server error|service unavailable|erro no servidor/.test(text)) {
    throw failure('RFB_NEWS_ERROR_PAGE', 'SOURCE_UNAVAILABLE', true, {
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
    });
  }
}

export class RfbNewsClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxHtmlBytes: number;

  constructor(options: RfbNewsClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  }

  async getHtml(url: string, signal: AbortSignal): Promise<RfbNewsHtmlResponse> {
    const requested = assertAllowedUrl(url);
    signal.throwIfAborted();

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    timer.unref();

    let response: Response;
    try {
      response = await this.#fetch(requested, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.any([signal, timeout.signal]),
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'user-agent': 'Tribusca/1.0 (+official-source-monitoring)',
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw failure('RFB_NEWS_CANCELLED', 'CANCELLED', false);
      }
      if (timeout.signal.aborted) {
        throw failure('RFB_NEWS_REQUEST_TIMEOUT', 'NETWORK_ERROR', true, {
          retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        });
      }
      throw failure('RFB_NEWS_NETWORK_ERROR', 'NETWORK_ERROR', true, {
        retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
        metadata: {
          cause: error instanceof Error ? error.name : 'unknown',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    const finalUrl = assertAllowedUrl(response.url || requested.toString()).toString();

    if (!(response.status >= 200 && response.status < 300)) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      const retryAfter = retryAfterSeconds(response) ?? DEFAULT_RETRY_AFTER_SECONDS;
      if (response.status === 429) {
        throw failure('RFB_NEWS_RATE_LIMITED', 'RATE_LIMITED', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      if (response.status === 408 || response.status === 425 || response.status >= 500) {
        throw failure('RFB_NEWS_SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', true, {
          httpStatus: response.status,
          retryAfterSeconds: retryAfter,
        });
      }
      throw failure('RFB_NEWS_HTTP_ERROR', 'HTTP_ERROR', false, {
        httpStatus: response.status,
      });
    }

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase();
    if (
      contentType &&
      contentType !== 'text/html' &&
      contentType !== 'application/xhtml+xml'
    ) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('RFB_NEWS_INVALID_CONTENT_TYPE', 'FETCH_ERROR', true, {
        metadata: { contentType },
      });
    }

    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength &&
      /^\d+$/.test(declaredLength) &&
      Number(declaredLength) > this.#maxHtmlBytes
    ) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw failure('RFB_NEWS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxHtmlBytes) {
      throw failure('RFB_NEWS_RESPONSE_TOO_LARGE', 'FETCH_ERROR', false);
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    rejectIntermediary(html);

    return {
      url: finalUrl,
      html,
      ...(response.headers.get('etag')
        ? { sourceEtag: response.headers.get('etag')! }
        : {}),
      ...(response.headers.get('last-modified')
        ? { sourceLastModified: response.headers.get('last-modified')! }
        : {}),
    };
  }

  getListing(signal: AbortSignal): Promise<RfbNewsHtmlResponse> {
    return this.getHtml(RFB_NEWS_LIST_URL, signal);
  }
}
