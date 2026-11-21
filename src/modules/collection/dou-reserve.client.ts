import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'htmlparser2';
import { ConnectorError } from './connector.error.js';

export const DOU_OPEN_DATA_INDEX = 'https://www.in.gov.br/acesso-a-informacao/dados-abertos/base-de-dados';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;

export type DouReserveSection = '01' | '03';
export interface DouReservePackage { filename: string; officialUrl: string }

function reserveError(code: string, httpStatus?: number): ConnectorError {
  return new ConnectorError(code, {
    code, kind: 'SOURCE_UNAVAILABLE', retryable: false,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

function officialUrl(href: string, base: string): URL | undefined {
  try {
    const url = new URL(href, base);
    if (url.protocol === 'https:' &&
        (url.hostname === 'in.gov.br' || url.hostname.endsWith('.in.gov.br')) &&
        !url.username && !url.password && !url.port && !url.hash) return url;
  } catch { /* Invalid or untrusted links never become requests. */ }
  return undefined;
}

export class DouReserveClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, { signal, redirect: 'manual' });
      } catch {
        signal.throwIfAborted();
        throw reserveError('DOU_RESERVE_NETWORK_ERROR');
      }
      if (response.status === 200) return response;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      const target = location && officialUrl(location, url);
      if (response.status < 300 || response.status >= 400 || !target) {
        throw reserveError('DOU_RESERVE_HTTP_ERROR', response.status);
      }
      url = target.href;
    }
    throw reserveError('DOU_RESERVE_REDIRECT_LIMIT');
  }

  async index(months: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, DouReservePackage>> {
    const packages = new Map<string, DouReservePackage>();
    for (const month of new Set(months)) {
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
      if (!match) throw reserveError('DOU_RESERVE_INVALID_MONTH');
      const [, year, number] = match;
      const url = new URL(DOU_OPEN_DATA_INDEX);
      url.searchParams.set('ano', year!);
      url.searchParams.set('mes', MONTHS[Number(number) - 1]!);
      for (const [key, pkg] of await this.indexMonth(url, `${number}${year}`, signal)) {
        packages.set(key, pkg);
      }
    }
    return packages;
  }

  private async indexMonth(indexUrl: URL, monthAndYear: string, signal: AbortSignal): Promise<ReadonlyMap<string, DouReservePackage>> {
    const response = await this.request(indexUrl.href, signal);
    const documents = new Map<string, DouReservePackage>();
    const conflicts = new Set<string>();
    let anchor: { href: string; label: string } | undefined;
    const parser = new Parser({
      onopentag(name, attrs) {
        if (name === 'a' && attrs.href) anchor = { href: attrs.href, label: '' };
      },
      ontext(text) { if (anchor) anchor.label += text; },
      onclosetag(name) {
        if (name !== 'a' || !anchor) return;
        const { href, label } = anchor;
        anchor = undefined;
        const url = officialUrl(href, response.url || indexUrl.href);
        if (!url) return;
        // The official index may use a Liferay document identifier in href.
        const names = [label.trim(), url.pathname.split('/').at(-1) ?? ''];
        const match = names.map(value => /^(S0[13]((?:0[1-9]|1[0-2])\d{4})(?:_Atualizado(?:[01]\d|2[0-3])[0-5]\d[0-5]\d)?\.zip)$/i.exec(value)).find(Boolean);
        if (!match || match[2] !== monthAndYear) return;
        const filename = match[1]!;
        const key = filename.slice(0, 9).toUpperCase();
        const previous = documents.get(key);
        if (previous && previous.officialUrl !== url.href) {
          const oldIsUpdated = /_atualizado/i.test(previous.filename);
          const newIsUpdated = /_atualizado/i.test(filename);
          if (oldIsUpdated === newIsUpdated) { conflicts.add(key); return; }
          if (oldIsUpdated) return;
        }
        documents.set(key, { filename, officialUrl: url.href });
      },
    });
    const decoder = new TextDecoder();
    let total = 0;
    try {
      for await (const chunk of this.body(response, MAX_INDEX_BYTES)) {
        signal.throwIfAborted();
        total += chunk.byteLength;
        if (total > MAX_INDEX_BYTES) throw reserveError('DOU_RESERVE_INDEX_TOO_LARGE');
        parser.write(decoder.decode(chunk, { stream: true }));
      }
      parser.end(decoder.decode());
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ConnectorError) throw error;
      throw reserveError('DOU_RESERVE_INVALID_INDEX');
    }
    for (const key of conflicts) documents.delete(key);
    return documents;
  }

  private body(response: Response, maxBytes: number): Readable {
    const length = response.headers.get('content-length');
    if (!response.body || (length && Number(length) > maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw reserveError('DOU_RESERVE_INVALID_BODY');
    }
    return Readable.fromWeb(response.body);
  }

  async withPackage<T>(
    pkg: DouReservePackage,
    signal: AbortSignal,
    use: (path: string, rawSha256: string, bytes: number) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'dou-reserve-'))
      .catch(() => { throw reserveError('DOU_RESERVE_TEMP_UNAVAILABLE'); });
    const path = join(dir, 'monthly.zip');
    try {
      const response = await this.request(pkg.officialUrl, signal);
      const hash = createHash('sha256');
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > MAX_PACKAGE_BYTES) return done(reserveError('DOU_RESERVE_PACKAGE_TOO_LARGE'));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(this.body(response, MAX_PACKAGE_BYTES), meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ConnectorError) throw error;
        throw reserveError('DOU_RESERVE_PACKAGE_READ_FAILED');
      }
      return await use(path, hash.digest('hex'), bytes);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 2 })
        .catch(() => { throw reserveError('DOU_RESERVE_TEMP_CLEANUP_FAILED'); });
    }
  }
}

export function douReservePackageKey(date: string, section: DouReserveSection): string {
  return `S${section}${date.slice(5, 7)}${date.slice(0, 4)}`;
}
