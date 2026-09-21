import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import http from 'node:http';

const CONFAZ_ORIGIN = 'https://www.confaz.fazenda.gov.br';
const PORT = Number(process.env.PORT ?? '8080');
const TOKEN = process.env.RELAY_BEARER_TOKEN;
const TIMEOUT_MS = Number(
  process.env.RELAY_UPSTREAM_TIMEOUT_MS ?? '20000',
);

if (!TOKEN) {
  console.error('RELAY_BEARER_TOKEN is required');
  process.exit(1);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match?.[1] && safeEqual(match[1], TOKEN));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function allowedTarget(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined;
  }

  const target = new URL(path, CONFAZ_ORIGIN);
  if (
    target.origin !== CONFAZ_ORIGIN ||
    (target.pathname !== '/' &&
      !target.pathname.startsWith('/legislacao/'))
  ) {
    return undefined;
  }

  return target;
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (!authorized(request)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }

  const requestUrl = new URL(
    request.url ?? '/',
    'http://relay.internal',
  );

  if (
    request.method !== 'GET' ||
    requestUrl.pathname !== '/fetch'
  ) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }

  const target = allowedTarget(
    requestUrl.searchParams.get('path'),
  );

  if (!target) {
    sendJson(response, 400, {
      error: 'destination_not_allowed',
    });
    return;
  }

  const startedAt = Date.now();

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent':
          'RadarFiscal/0.1 (CONFAZ source-specific egress relay)',
        Accept:
          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    });

    const headers = {
      'cache-control': 'no-store',
      'x-radar-origin-url': upstream.url,
    };

    for (const name of [
      'content-type',
      'etag',
      'last-modified',
    ]) {
      const value = upstream.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }

    response.writeHead(upstream.status, headers);

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(response);
    } else {
      response.end();
    }

    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        event: 'upstream_response',
        path: target.pathname,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    const timeout = error?.name === 'TimeoutError';
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        event: 'upstream_error',
        path: target.pathname,
        kind: timeout ? 'timeout' : 'network_error',
        code: error?.cause?.code,
        durationMs: Date.now() - startedAt,
      }),
    );

    if (!response.headersSent) {
      sendJson(response, timeout ? 504 : 502, {
        error: timeout
          ? 'upstream_timeout'
          : 'upstream_unavailable',
      });
    } else {
      response.destroy();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'relay_started',
      port: PORT,
      origin: CONFAZ_ORIGIN,
    }),
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
