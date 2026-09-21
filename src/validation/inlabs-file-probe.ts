import { setTimeout as delay } from 'node:timers/promises';

import { douCollectionDates, DOU_XML_SECTIONS } from '../modules/collection/dou.connector.js';

const ORIGIN = 'https://inlabs.in.gov.br';
const COOKIE = 'inlabs_session_cookie';

let cookie = '';

function sessionCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .map((value) =>
      value.match(/^inlabs_session_cookie=([^;\s]+)(?:;|$)/)?.[1],
    )
    .find((value) => value !== undefined && value !== 'deleted');
}

function refreshCookie(response: Response): void {
  const value = sessionCookie(response);
  if (value) {
    cookie = `${COOKIE}=${value}`;
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Probe only.
  }
}

async function loginUntilSuccess(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${ORIGIN}/logar.php`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origem: '736372697074',
      },
      body: new URLSearchParams({
        email: process.env.INLABS_EMAIL ?? '',
        password: process.env.INLABS_PASSWORD ?? '',
      }),
    });

    const value = sessionCookie(response);
    const location = response.headers.get('location');

    console.log(
      'INLABS_PROBE_LOGIN=' +
        JSON.stringify({
          attempt,
          status: response.status,
          location: location
            ? new URL(location, ORIGIN).pathname
            : null,
          hasSessionCookie: Boolean(value),
        }),
    );

    await discard(response);

    if (value) {
      cookie = `${COOKIE}=${value}`;
      return;
    }

    await delay(10_000);
  }
}

async function authenticatedGet(
  url: string,
): Promise<{ response: Response; finalUrl: URL; hops: number }> {
  let current = new URL(url);

  for (let hops = 0; hops <= 3; hops += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        cookie,
        origem: '736372697074',
      },
    });

    refreshCookie(response);

    if (!(response.status >= 300 && response.status < 400)) {
      return { response, finalUrl: current, hops };
    }

    const location = response.headers.get('location');
    if (!location) {
      return { response, finalUrl: current, hops };
    }

    const target = new URL(location, current);

    if (target.origin !== ORIGIN) {
      return { response, finalUrl: current, hops };
    }

    await discard(response);
    current = target;
  }

  throw new Error('redirect loop');
}

async function readPrefix(
  response: Response,
  limit = 4096,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();

  try {
    const next = await reader.read();

    if (next.done) {
      return new Uint8Array();
    }

    return next.value.slice(0, limit);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Probe only.
    }
    reader.releaseLock();
  }
}

await loginUntilSuccess();

const dates = douCollectionDates(new Date());

console.log(
  'INLABS_PROBE_DATES=' + JSON.stringify({ dates }),
);

for (const date of dates) {
  const index = await authenticatedGet(
    `${ORIGIN}/index.php?p=${date}`,
  );
  const indexBytes = await readPrefix(index.response, 256 * 1024);
  const indexText = new TextDecoder().decode(indexBytes);

  const listed = DOU_XML_SECTIONS.filter((section) =>
    indexText.includes(`${date}-${section}.zip`),
  );

  console.log(
    'INLABS_PROBE_INDEX=' +
      JSON.stringify({
        date,
        status: index.response.status,
        contentType: index.response.headers.get('content-type'),
        finalPath: index.finalUrl.pathname,
        hops: index.hops,
        maintenance: /manuten/i.test(indexText),
        login: /logar\.php|name\s*=\s*["']password/i.test(indexText),
        listed,
      }),
  );

  for (const section of DOU_XML_SECTIONS) {
    const filename = `${date}-${section}.zip`;
    const result = await authenticatedGet(
      `${ORIGIN}/index.php?p=${date}&dl=${filename}`,
    );
    const bytes = await readPrefix(result.response);
    const text = new TextDecoder().decode(bytes);

    const zip =
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 3 && bytes[3] === 4) ||
        (bytes[2] === 5 && bytes[3] === 6));

    console.log(
      'INLABS_PROBE_FILE=' +
        JSON.stringify({
          date,
          section,
          filename,
          listed: listed.includes(section),
          status: result.response.status,
          contentType: result.response.headers.get('content-type'),
          contentLength: result.response.headers.get('content-length'),
          finalPath: result.finalUrl.pathname,
          hops: result.hops,
          zip,
          html: /<!doctype|<html/i.test(text),
          maintenance: /manuten/i.test(text),
          login: /logar\.php|name\s*=\s*["']password/i.test(text),
          unavailableText:
            /nao encontrado|não encontrado|indispon|sem edicao|sem edição/i.test(
              text,
            ),
        }),
    );
  }
}
