import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser } from 'htmlparser2';
import { ConnectorError } from './connector.error.js';
import { isDouEdition, type DouEditionInventory } from './dou-coverage.js';

export const DOU_OPEN_DATA_INDEX = 'https://www.in.gov.br/acesso-a-informacao/dados-abertos/base-de-dados';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;

export type DouReserveSection = '01' | '03';
export interface DouReservePackage { filename: string; officialUrl: string }
const packageName = /^S0[13]((?:0[1-9]|1[0-2])\d{4})(?:_Atualizado(?:[01]\d|2[0-3])[0-5]\d[0-5]\d)?\.zip$/i;
const packagePath = /^\/documents\/\d+\/\d+\/([^/]+)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

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

function documentFilename(url: URL | undefined): string | undefined {
  if (!url || (url.hostname !== 'www.in.gov.br' && url.hostname !== 'in.gov.br')) return undefined;
  const pathName = packagePath.exec(url.pathname)?.[1];
  if (!pathName) return undefined;
  try {
    const filename = decodeURIComponent(pathName);
    return packageName.test(filename) ? filename : undefined;
  } catch { return undefined; }
}

export class DouReserveClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(url: string, signal: AbortSignal, mayRedirect?: (target: URL) => boolean): Promise<Response> {
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
      if (response.status < 300 || response.status >= 400 || !target || (mayRedirect && !mayRedirect(target))) {
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
    const candidates = new Map<string, [Map<string, DouReservePackage | null>, Map<string, DouReservePackage | null>]>();
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
        const filenameFromPath = documentFilename(url);
        if (!url || !filenameFromPath) return;
        const filenameFromLabel = label.trim();
        const names = [filenameFromPath, filenameFromLabel].filter(name => packageName.test(name));
        const conflict = !packageName.test(filenameFromLabel) || filenameFromPath.toUpperCase() !== filenameFromLabel.toUpperCase();
        for (const filename of names) {
          if (packageName.exec(filename)?.[1] !== monthAndYear) continue;
          const key = filename.slice(0, 9).toUpperCase();
          const ranks = candidates.get(key) ?? [new Map(), new Map()];
          const rank = ranks[/_atualizado/i.test(filename) ? 1 : 0];
          rank.set(url.href, conflict || rank.get(url.href) === null ? null : { filename, officialUrl: url.href });
          candidates.set(key, ranks);
        }
      },
    });
    await this.readHtml(response, parser, signal);
    const documents = new Map<string, DouReservePackage>();
    for (const [key, [monthly, updated]] of candidates) {
      const best = updated.size ? updated : monthly;
      const candidate = best.values().next().value;
      if (best.size === 1 && candidate) documents.set(key, candidate);
    }
    return documents;
  }

  private async readHtml(response: Response, parser: Parser, signal: AbortSignal): Promise<void> {
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
  }

  async editions(date: string, signal: AbortSignal): Promise<DouEditionInventory> {
    const result: DouEditionInventory = {};
    const portalDate = date.split('-').reverse().join('-');
    for (const section of ['DO1', 'DO3'] as const) {
      const regular = await this.editionPage(section, portalDate, signal);
      if (!regular) continue;
      result[section] = regular.counts;
      const extraSection = `${section}E` as const;
      if (regular.hasExtra === false) result[extraSection] = {};
      if (regular.hasExtra === true) {
        const extra = await this.editionPage(extraSection, portalDate, signal);
        if (extra && Object.keys(extra.counts).length) result[extraSection] = extra.counts;
      }
    }
    return result;
  }

  private async editionPage(section: 'DO1' | 'DO3' | 'DO1E' | 'DO3E', date: string, signal: AbortSignal) {
    try {
      const url = new URL('https://www.in.gov.br/leiturajornal');
      url.searchParams.set('secao', section.toLowerCase());
      url.searchParams.set('data', date);
      const response = await this.request(url.href, signal);
      let params = '';
      let reading = false;
      let scripts = 0;
      const parser = new Parser({
        onopentag(name, attrs) {
          if (name === 'script' && attrs.id === 'params' && attrs.type === 'application/json') {
            reading = true;
            scripts++;
          }
        },
        ontext(text) { if (reading) params += text; },
        onclosetag(name) { if (name === 'script') reading = false; },
      });
      await this.readHtml(response, parser, signal);
      if (scripts !== 1) return undefined;
      const payload = JSON.parse(params);
      const expectedSection = section.endsWith('E') ? new RegExp(`^${section.slice(0, 3)}(?:E|_EXTRA_[A-Z]+)$`) : new RegExp(`^${section}$`);
      if (payload?.dateUrl !== date || !String(payload.section).split(',').every(value => expectedSection.test(value)) ||
          !Array.isArray(payload.jsonArray) || payload.jsonArray.length > 5000) return undefined;
      const counts: Record<string, number> = {};
      for (const item of payload.jsonArray) {
        if (!expectedSection.test(String(item?.pubName)) || typeof item.editionNumber !== 'string' ||
            !isDouEdition(item.editionNumber)) return undefined;
        counts[item.editionNumber] = (counts[item.editionNumber] ?? 0) + 1;
      }
      return { counts, hasExtra: payload.typeNormDay?.[`${section}E`] };
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
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
    const url = officialUrl(pkg.officialUrl, DOU_OPEN_DATA_INDEX);
    const matches = (target: URL | undefined) => documentFilename(target)?.toUpperCase() === pkg.filename.toUpperCase();
    if (!url || !matches(url)) throw reserveError('DOU_RESERVE_INVALID_PACKAGE_URL');
    const dir = await mkdtemp(join(tmpdir(), 'dou-reserve-'))
      .catch(() => { throw reserveError('DOU_RESERVE_TEMP_UNAVAILABLE'); });
    const path = join(dir, 'monthly.zip');
    try {
      const response = await this.request(url.href, signal, matches);
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
