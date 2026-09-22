// static-outbound-ip validation redeploy 2026-09-22
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Parser } from 'htmlparser2';

const ORIGIN = 'https://sped.rfb.gov.br';
const roots = [
  ['HOME', '/'],
  ['EFD_ICMS_IPI', '/item/show/274'],
  ['EFD_CONTRIBUICOES', '/item/show/268'],
  ['EFD_REINF', '/item/show/1196'],
  ['DERE_NEWS', '/item/show/7950'],
] as const;

interface LinkInfo {
  href: string;
  text: string;
}

function directHttp(url: string, timeoutMs = 10_000): Promise<{ status?: number; location?: string; body?: string; error?: string; code?: string }> {
  return new Promise((resolve) => {
    const request = http.get(url, {
      family: 4,
      timeout: timeoutMs,
      headers: {
        'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
        accept: 'text/html,*/*;q=0.5',
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        if (total >= 32_768) return;
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on('end', () => {
        resolve({
          ...(response.statusCode !== undefined ? { status: response.statusCode } : {}),
          ...(response.headers.location ? { location: response.headers.location } : {}),
          body: Buffer.concat(chunks).toString('utf8').slice(0, 32_768),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('HTTP_TIMEOUT')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    });
  });
}

function directHttps(url: string, timeoutMs = 10_000): Promise<{ status?: number; body?: string; error?: string; code?: string }> {
  return new Promise((resolve) => {
    const request = https.get(url, {
      family: 4,
      timeout: timeoutMs,
      headers: {
        'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
        accept: 'text/html,application/json,*/*;q=0.5',
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        if (total >= 32_768) return;
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on('end', () => {
        resolve({
          ...(response.statusCode !== undefined ? { status: response.statusCode } : {}),
          body: Buffer.concat(chunks).toString('utf8').slice(0, 32_768),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('HTTPS_TIMEOUT')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    });
  });
}

function tcpProbe(address: string, port = 443, timeoutMs = 8_000): Promise<{ ok: boolean; error?: string; code?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port, family: 4 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'TCP_TIMEOUT' });
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
    });
  });
}

async function networkDiagnostic(): Promise<void> {
  let addresses: Array<{ address: string; family: number }> = [];
  try {
    addresses = await lookup('sped.rfb.gov.br', { all: true });
  } catch (error) {
    console.log('SPED_DNS=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  console.log('SPED_DNS=' + JSON.stringify({ addresses }));
  for (const entry of addresses.filter((entry) => entry.family === 4)) {
    console.log('SPED_TCP=' + JSON.stringify({ address: entry.address, port: 443, ...(await tcpProbe(entry.address, 443)) }));
    console.log('SPED_TCP=' + JSON.stringify({ address: entry.address, port: 80, ...(await tcpProbe(entry.address, 80)) }));
  }
  const egress = await directHttps('https://api.ipify.org?format=json');
  console.log('SPED_EGRESS=' + JSON.stringify(egress));
  const plainPortal = await directHttp('http://sped.rfb.gov.br/');
  console.log('SPED_HTTP_DIRECT=' + JSON.stringify({
    status: plainPortal.status,
    location: plainPortal.location,
    error: plainPortal.error,
    code: plainPortal.code,
    bytes: plainPortal.body ? Buffer.byteLength(plainPortal.body) : 0,
    hasSped: plainPortal.body ? /SPED|Sistema Público de Escrituração Digital/i.test(plainPortal.body) : false,
  }));
  for (const path of [
    '/item/show/274',
    '/item/show/268',
    '/item/show/1196',
    '/item/show/7950',
    '/arquivo/show/8016',
    '/destaques/show/7',
  ]) {
    const probe = await directHttp('http://sped.rfb.gov.br' + path);
    console.log('SPED_HTTP_PATH=' + JSON.stringify({
      path,
      status: probe.status,
      location: probe.location,
      error: probe.error,
      code: probe.code,
      bytes: probe.body ? Buffer.byteLength(probe.body) : 0,
      bodyHead: probe.body?.replace(/\s+/g, ' ').slice(0, 240) ?? null,
    }));
  }
  const directPortal = await directHttps(ORIGIN + '/');
  console.log('SPED_HTTPS_DIRECT=' + JSON.stringify({
    status: directPortal.status,
    error: directPortal.error,
    code: directPortal.code,
    bytes: directPortal.body ? Buffer.byteLength(directPortal.body) : 0,
    hasSped: directPortal.body ? /SPED|Sistema Público de Escrituração Digital/i.test(directPortal.body) : false,
  }));
}

async function fetchHtml(path: string): Promise<{ url: string; html: string; status: number; contentType: string }> {
  const response = await fetch(new URL(path, ORIGIN), {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.5',
    },
  });
  const html = await response.text();
  return {
    url: response.url,
    html,
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
  };
}

function extractLinks(html: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  let current: { href: string; text: string } | undefined;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name.toLowerCase() === 'a' && attrs.href) current = { href: attrs.href, text: '' };
    },
    ontext(text) {
      if (current) current.text += text;
    },
    onclosetag(name) {
      if (name.toLowerCase() === 'a' && current) {
        const text = current.text.replace(/\s+/g, ' ').trim();
        try {
          const url = new URL(current.href, ORIGIN);
          if (url.origin === ORIGIN) links.push({ href: url.pathname + url.search, text });
        } catch {}
        current = undefined;
      }
    },
  }, { decodeEntities: true });
  parser.end(html);
  return links;
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const k = key(value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

await networkDiagnostic();

const keyword = /(guia|manual|nota|orienta|leiaute|layout|xsd|schema|tabela|validador|pva|pge|download|destaque|dere|regimes espec|arquivo)/i;
const output: Record<string, unknown> = {};

for (const [name, path] of roots) {
  try {
    const page = await fetchHtml(path);
    const links = unique(extractLinks(page.html), link => `${link.href}|${link.text}`);
    const summary = {
      status: page.status,
      finalUrl: page.url,
      bytes: Buffer.byteLength(page.html),
      contentType: page.contentType,
      itemShowLinks: links.filter(link => /\/item\/show\/\d+/.test(link.href) && keyword.test(link.text)).slice(0, 120),
      archiveLinks: links.filter(link => /\/arquivo\/(?:show|download)\/\d+/.test(link.href)).slice(0, 80),
      destaqueLinks: links.filter(link => /\/destaques\/show\/\d+/.test(link.href)).slice(0, 40),
      interestingLinks: links.filter(link => keyword.test(link.text) || keyword.test(link.href)).slice(0, 160),
    };
    output[name] = summary;
    console.log('SPED_PAGE=' + JSON.stringify({ name, ...summary }));
  } catch (error) {
    const cause =
      error instanceof Error &&
      'cause' in error &&
      error.cause &&
      typeof error.cause === 'object'
        ? error.cause as Record<string, unknown>
        : undefined;
    const failed = {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : typeof error,
      causeCode: typeof cause?.code === 'string' ? cause.code : undefined,
      causeMessage: typeof cause?.message === 'string' ? cause.message : undefined,
      causeAddress: typeof cause?.address === 'string' ? cause.address : undefined,
      causePort: typeof cause?.port === 'number' ? cause.port : undefined,
    };
    output[name] = failed;
    console.log('SPED_PAGE=' + JSON.stringify({ name, ...failed }));
  }
}

console.log('SPED_LIVE_DIAG_DONE=' + JSON.stringify({
  generatedAt: new Date().toISOString(),
  pages: Object.keys(output),
}));
