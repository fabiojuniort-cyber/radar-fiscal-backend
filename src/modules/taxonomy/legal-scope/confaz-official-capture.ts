/**
 * TAX13-R8-02: direct, pinned-IP official HTTPS transport.
 * No caller-supplied fetch, headers, proxy, HTML or response bytes.
 * The returned data is evidence of this TLS connection, NOT an attestation
 * of legal effectiveness. Collector signing keys live outside this module.
 */
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';
import type {TLSSocket} from 'node:tls';

export const CONFAZ_CAPTURE_HOST = 'www.confaz.fazenda.gov.br';
export const CONFAZ_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const HTTPS_TIMEOUT_MS = 15000;
const maxAllowedUrl = 2048;

export interface OfficialConfazCapture {
  requestUrl: string;
  finalUrl: string;
  redirectChain: string[];
  httpStatus: 200;
  collectedAt: string;
  startedAt: string;
  collectorIdentity: string;
  remoteIpv4: string;
  tlsPeerCertificateSha256: string;
  rawBytes: Buffer;
  rawSha256: string;
}

export function validateOfficialConfazUrl(value: string): URL {
  if (!value || value.length > maxAllowedUrl || /[\\\\\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('TAX13_R802_INVALID_OFFICIAL_URL');
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('TAX13_R802_INVALID_OFFICIAL_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== CONFAZ_CAPTURE_HOST ||
      url.username || url.password || url.port || url.hash ||
      url.href !== value || !url.pathname.startsWith('/legislacao/')) {
    throw new Error('TAX13_R802_UNAUTHORIZED_OFFICIAL_URL');
  }
  return url;
}

/** Intentionally IPv4-only: reject ambiguity and all special/non-global ranges. */
export function assertPublicIpv4(address: string): void {
  if (isIP(address) !== 4) throw new Error('TAX13_R802_UNSUPPORTED_ADDRESS');
  const a = address.split('.').map(Number);
  const first = a[0]!, second = a[1]!, third = a[2]!;
  if (first === 0 || first === 10 || first === 127 || first >= 224 ||
      first === 169 && second === 254 ||
      first === 172 && second >= 16 && second <= 31 ||
      first === 192 && (second === 168 || second === 0 ||
        second === 88 && third === 99 || second === 0 && third === 2) ||
      first === 100 && second >= 64 && second <= 127 ||
      first === 198 && (second === 18 || second === 19 || second === 51 && third === 100) ||
      first === 203 && second === 0 && third === 113 ||
      first === 192 && second === 0 && third === 0 ||
      first === 255) {
    throw new Error('TAX13_R802_NON_PUBLIC_IP');
  }
}

export function validateOfficialRedirect(location: string, previous: string): string {
  if (!location || /[\u0000-\u001f\u007f]/.test(location)) {
    throw new Error('TAX13_R802_BAD_REDIRECT');
  }
  const next = new URL(location, previous);
  validateOfficialConfazUrl(next.href);
  return next.href;
}

async function resolvePinnedPublicIpv4(hostname: string): Promise<string> {
  if (hostname !== CONFAZ_CAPTURE_HOST) throw new Error('TAX13_R802_DNS_HOST_DENIED');
  const addresses = await lookup(hostname, {all: true, family: 4, verbatim: true});
  if (!addresses.length) throw new Error('TAX13_R802_DNS_UNAVAILABLE');
  for (const ip of addresses) assertPublicIpv4(ip.address);
  return addresses[0]!.address;
}

interface Hop {
  status: number;
  location?: string;
  rawBytes: Buffer;
  remoteIpv4: string;
  tlsPeerCertificateSha256: string;
}

async function singleHop(url: URL): Promise<Hop> {
  const ip = await resolvePinnedPublicIpv4(url.hostname);
  return new Promise<Hop>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, family: 4, autoSelectFamily: false,
      servername: url.hostname, rejectUnauthorized: true, timeout: HTTPS_TIMEOUT_MS,
      lookup: (_host, _opts, cb) => cb(null, ip, 4),
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-encoding': 'identity',
        'user-agent': 'TriBusca-TAX13-R802-official-collector/1.0'
      }
    }, async res => {
      try {
        const status = res.statusCode ?? 0;
        const peer = res.socket as TLSSocket;
        if (!peer.authorized || peer.remoteAddress !== ip ||
            !peer.getPeerCertificate(true)?.raw) {
          throw new Error('TAX13_R802_TLS_PEER_UNVERIFIED');
        }
        if (res.headers['content-encoding'] &&
            res.headers['content-encoding'] !== 'identity') {
          throw new Error('TAX13_R802_ENCODED_BODY_DENIED');
        }
        if (status === 200) {
          const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
          if (!/^text\/html(?:\s*;|\s*$)|^application\/xhtml\+xml(?:\s*;|\s*$)/.test(contentType) ||
              /charset\s*=\s*(?!["']?utf-8["']?\s*(?:;|$))/i.test(contentType)) {
            throw new Error('TAX13_R802_UNSUPPORTED_CONTENT_TYPE');
          }
        } else if (![301,302,303,307,308].includes(status)) {
          throw new Error('TAX13_R802_SOURCE_UNAVAILABLE_' + status);
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(declared) || declared < 0 ||
            declared > CONFAZ_CAPTURE_MAX_BYTES) {
          throw new Error('TAX13_R802_SIZE_LIMIT');
        }
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of res) {
          const piece = Buffer.isBuffer(part) ? part : Buffer.from(part);
          size += piece.byteLength;
          if (size > CONFAZ_CAPTURE_MAX_BYTES) {
            res.destroy();
            throw new Error('TAX13_R802_SIZE_LIMIT');
          }
          parts.push(piece);
        }
        if (declared && declared !== size) throw new Error('TAX13_R802_TRUNCATED_BODY');
        const certHash = createHash('sha256')
          .update(peer.getPeerCertificate(true).raw).digest('hex');
        resolve({
          status, location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
          rawBytes: Buffer.concat(parts), remoteIpv4: ip,
          tlsPeerCertificateSha256: certHash
        });
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.on('timeout', () => req.destroy(new Error('TAX13_R802_SOURCE_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

/** No live fetch in fixture utilities: only this function can produce a capture. */
export async function captureOfficialConfazHttps(
  requestedUrl: string, collectorIdentity: string
): Promise<OfficialConfazCapture> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(collectorIdentity)) {
    throw new Error('TAX13_R802_COLLECTOR_ID_REQUIRED');
  }
  const start = validateOfficialConfazUrl(requestedUrl).href;
  const startedAt = new Date().toISOString();
  const seen = new Set<string>();
  const chain: string[] = [];
  let next = start;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (seen.has(next)) throw new Error('TAX13_R802_REDIRECT_LOOP');
    seen.add(next);
    chain.push(next);
    const result = await singleHop(validateOfficialConfazUrl(next));
    if (result.status === 200) {
      if (!result.rawBytes.length) throw new Error('TAX13_R802_EMPTY_OFFICIAL_RESPONSE');
      return {
        requestUrl: start, finalUrl: next, redirectChain: chain,
        httpStatus: 200, startedAt, collectedAt: new Date().toISOString(),
        collectorIdentity, rawBytes: result.rawBytes,
        rawSha256: createHash('sha256').update(result.rawBytes).digest('hex'),
        remoteIpv4: result.remoteIpv4,
        tlsPeerCertificateSha256: result.tlsPeerCertificateSha256
      };
    }
    if (!result.location) throw new Error('TAX13_R802_MISSING_LOCATION');
    next = validateOfficialRedirect(result.location, next);
  }
  throw new Error('TAX13_R802_TOO_MANY_REDIRECTS');
}
