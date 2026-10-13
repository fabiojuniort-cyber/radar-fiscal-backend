import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { executeConnector } from '../src/modules/collection/connector.executor.js';
import { InlabsClient, pageTitle } from '../src/modules/collection/inlabs.client.js';

const signal = () => new AbortController().signal;
const credentials = () => ({ email: 'test@example.invalid', password: 'private-test-value' });
const loginResponse = () => new Response(null, { status: 302,
  headers: { 'set-cookie': 'inlabs_session_cookie=test-session; Secure; HttpOnly; Path=/', location: 'index.php' } });
const zip = Uint8Array.from([80, 75, 5, 6, ...Array<number>(18).fill(0)]);

function stub(responses: Array<Response | Error>, limit?: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new InlabsClient({ credentials,
    ...(limit === undefined ? {} : { maxArchiveBytes: limit }),
    fetch: (async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses.shift();
      assert.ok(next, 'unexpected HTTP request');
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
  });
  return { client, calls };
}

function code(expected: string) {
  return (error: unknown) => error instanceof ConnectorError && error.code === expected;
}

// Synthetic HTML reproducing the text visible in the user's official portal screenshot.
// It is not a downloaded INLABS fixture or proof of the actual HTTP status.
const maintenanceHtml = `<html>${' '.repeat(2048)}<h2>Sistema em Manutenção Programada</h2>
  <p>O sistema está passando por manutenção programada.</p></html>`;

function maintenanceError(error: unknown): boolean {
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, 'INLABS_MAINTENANCE');
  assert.equal(error.kind, 'SOURCE_UNAVAILABLE');
  assert.equal(error.retryable, true);
  return true;
}

test('maintenance returned as HTTP 200 at login is a retryable outage', async () => {
  const { client } = stub([new Response(maintenanceHtml, { headers: { 'retry-after': '120' } })]);
  await assert.rejects(client.login(signal()), error => {
    maintenanceError(error);
    assert.equal((error as ConnectorError).retryAfterSeconds, 120);
    return true;
  });
});

test('maintenance at index prevents interpreting an archive 404 as NOT_AVAILABLE', async () => {
  const { client } = stub([loginResponse(), new Response(null, { status: 404 }),
    new Response('<html><h2>Sistema em Manuten&ccedil;&atilde;o Programada</h2></html>')]);
  await client.login(signal());
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), maintenanceError);
});

test('maintenance HTML is recognized in place of both ZIP and PDF downloads', async () => {
  for (const kind of ['XML', 'PDF']) {
    const { client } = stub([loginResponse(), new Response(maintenanceHtml)]);
    await client.login(signal());
    await assert.rejects(kind === 'XML' ? client.downloadXml('2026-09-18', 'DO1', signal())
      : client.downloadPdf('2026-09-18', 'do1', signal()), maintenanceError);
  }
});

test('maintenance message reaches executor as SOURCE_UNAVAILABLE, not success', async () => {
  const { client } = stub([new Response(maintenanceHtml)]);
  const result = await executeConnector({
    connector: { key: 'inlabs-maintenance-test', collect: async context => {
      await client.login(context.signal);
      return { publications: [] };
    } }, sourceId: 'source', runId: 'run', attemptId: 'attempt', timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 'SOURCE_UNAVAILABLE');
    assert.equal(result.retryable, true);
  }
});

test('binary PDF mentioning maintenance remains a valid transport result', async () => {
  const { client } = stub([loginResponse(), new Response('%PDF-1.7\nSistema em Manutenção Programada')]);
  await client.login(signal());
  assert.equal((await client.downloadPdf('2026-09-18', 'do1', signal())).status, 'AVAILABLE');
});

test('missing credentials fail before HTTP and do not leak secrets', async () => {
  const client = new InlabsClient({ credentials: () => undefined,
    fetch: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  await assert.rejects(client.login(signal()), code('INLABS_CREDENTIALS_MISSING'));
});

test('official form, cookie, XML normal/extra and PDF extra URL conventions', async () => {
  const { client, calls } = stub([loginResponse(), new Response(zip), new Response(zip),
    new Response('%PDF-1.7\nfixture')]);
  await client.login(signal());
  const result = await client.downloadXml('2026-09-18', 'DO1', signal());
  await client.downloadXml('2026-09-18', 'DO1E', signal());
  await client.downloadPdf('2026-09-18', 'do1', signal(), 'B');
  assert.equal(calls[0]!.url, 'https://inlabs.in.gov.br/logar.php');
  assert.equal(String(calls[0]!.init.body), 'email=test%40example.invalid&password=private-test-value');
  assert.ok(calls.every(call => call.init.redirect === 'manual'));
  assert.equal(new Headers(calls[1]!.init.headers).get('cookie'), 'inlabs_session_cookie=test-session');
  assert.equal(new Headers(calls[1]!.init.headers).get('origem'), '736372697074');
  assert.ok(calls[1]!.url.endsWith('p=2026-09-18&dl=2026-09-18-DO1.zip'));
  assert.ok(calls[2]!.url.endsWith('dl=2026-09-18-DO1E.zip'));
  assert.ok(calls[3]!.url.endsWith('dl=2026_09_18_ASSINADO_do1_extra_B.pdf'));
  assert.equal(result.status, 'AVAILABLE');
  if (result.status === 'AVAILABLE') assert.equal(result.rawSha256, createHash('sha256').update(zip).digest('hex'));
  assert.equal(JSON.stringify(client), '{}');
  client.close();
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), code('INLABS_AUTH_REQUIRED'));
});

test('authenticated responses can rotate the INLABS session cookie', async () => {
  const rotated = new Response(zip, { headers: {
    'set-cookie': 'inlabs_session_cookie=rotated-session; Secure; HttpOnly; Path=/',
  } });
  const { client, calls } = stub([loginResponse(), rotated, new Response(zip)]);
  await client.login(signal());
  await client.downloadXml('2026-09-18', 'DO1', signal());
  await client.downloadXml('2026-09-18', 'DO2', signal());
  assert.equal(new Headers(calls[1]!.init.headers).get('cookie'), 'inlabs_session_cookie=test-session');
  assert.equal(new Headers(calls[2]!.init.headers).get('cookie'), 'inlabs_session_cookie=rotated-session');
});

test('no session cookie and foreign login redirects fail without forwarding secrets', async () => {
  for (const response of [new Response('login failed'), new Response(null, { status: 302,
    headers: { location: 'https://example.invalid', 'set-cookie': 'inlabs_session_cookie=value' } })]) {
    const { client, calls } = stub([response]);
    await assert.rejects(client.login(signal()), code('INLABS_AUTH_FAILED'));
    assert.equal(calls.length, 1);
  }
});

test('archive 404 verifies index session and reports absence without declaring an empty collection', async () => {
  const { client, calls } = stub([loginResponse(), new Response(null, { status: 404 }), new Response('<html>Index</html>')]);
  await client.login(signal());
  const result = await client.downloadXml('2026-09-18', 'DO1E', signal());
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(calls.length, 3);
});

test('404 with expired session is an authentication failure', async () => {
  const { client } = stub([loginResponse(), new Response(null, { status: 404 }),
    new Response('<html><form action="logar.php"><input name="password"></form></html>')]);
  await client.login(signal());
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), code('INLABS_AUTH_FAILED'));
});

test('authenticated GET follows bounded same-origin redirects like official clients', async () => {
  const redirected = new Response(null, { status: 302, headers: {
    location: '/download/final.zip',
    'set-cookie': 'inlabs_session_cookie=rotated-session; Secure; HttpOnly; Path=/',
  } });
  const { client, calls } = stub([loginResponse(), redirected, new Response(zip)]);
  await client.login(signal());
  const result = await client.downloadXml('2026-09-18', 'DO1', signal());
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.url, 'https://inlabs.in.gov.br/download/final.zip');
  assert.equal(new Headers(calls[2]!.init.headers).get('cookie'),
    'inlabs_session_cookie=rotated-session');
});

test('authenticated redirects never forward cookies to foreign origins', async () => {
  const { client, calls } = stub([loginResponse(), new Response(null, { status: 302,
    headers: { location: 'https://example.invalid/capture' } })]);
  await client.login(signal());
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()),
    code('INLABS_UNEXPECTED_REDIRECT'));
  assert.equal(calls.length, 2);
});

test('redirects back to login remain retryable session failures', async () => {
  const { client } = stub([loginResponse(), new Response(null, { status: 302,
    headers: { location: '/logar.php' } })]);
  await client.login(signal());
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), error => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, 'INLABS_SESSION_REDIRECT');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterSeconds, 20);
    return true;
  });
});

test('HTML masquerading as archive is retried as a transient fetch failure', async () => {
  // The daily index lists the file: the HTML answer is a broken download.
  const { client } = stub([loginResponse(), new Response('<html>maintenance</html>'),
    new Response('<html><a href="index.php?p=2026-09-18&dl=2026-09-18-DO1.zip">DO1</a></html>')]);
  await client.login(signal());
  await assert.rejects(
    client.downloadXml('2026-09-18', 'DO1', signal()),
    error => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'INLABS_INVALID_DOWNLOAD');
      assert.equal(error.kind, 'FETCH_ERROR');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 20);
      assert.equal(error.metadata?.filename, '2026-09-18-DO1.zip');
      assert.equal(error.metadata?.bodyKind, 'HTML');
      assert.equal(error.metadata?.byteLength, 24);
      assert.equal(JSON.stringify(error.metadata).includes('maintenance'), false);
      return true;
    },
  );
});

// Shape of the production answer on Sunday 2026-09-27: every section returned
// the same 38,679-byte text/html page with HTTP 200 (synthetic body here).
const noEditionPage = () => new Response(
  '<!DOCTYPE html><html><head><title>INLABS - Imprensa Nacional &amp; contato@example.invalid</title></head>' +
  '<body><p>Selecione uma data</p></body></html>',
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
);
const emptyIndex = () => new Response('<!DOCTYPE html><html><body><div>Nenhum arquivo</div></body></html>');

test('HTML 200 for a file the daily index does not list is absence, not a failed download', async () => {
  const { client, calls } = stub([loginResponse(), noEditionPage(), emptyIndex(), noEditionPage()]);
  await client.login(signal());
  const first = await client.downloadXml('2026-09-27', 'DO1', signal());
  assert.equal(first.status, 'NOT_AVAILABLE');
  assert.equal(first.status === 'NOT_AVAILABLE' && first.evidence, 'NOT_IN_DAILY_INDEX');
  const metadata = first.status === 'NOT_AVAILABLE' ? first.metadata! : {};
  assert.equal(metadata.bodyKind, 'HTML');
  assert.equal(metadata.indexListsArchives, false);
  assert.equal(metadata.pageTitle, 'INLABS - Imprensa Nacional [email]');
  assert.equal(JSON.stringify(metadata).includes('Selecione'), false, 'never the page body');
  assert.equal(JSON.stringify(metadata).includes('example.invalid'), false, 'e-mail redacted');

  // The index of the date is read once per attempt.
  const second = await client.downloadXml('2026-09-27', 'DO2', signal());
  assert.equal(second.status, 'NOT_AVAILABLE');
  assert.equal(calls.length, 4);
  assert.equal(calls[2]!.url, 'https://inlabs.in.gov.br/index.php?p=2026-09-27');
});

test('HTML 200 is still a failure when the daily index shows an expired session or maintenance', async () => {
  const expired = stub([loginResponse(), noEditionPage(),
    new Response('<html><form action="logar.php"><input name="password"></form></html>')]);
  await expired.client.login(signal());
  await assert.rejects(expired.client.downloadXml('2026-09-27', 'DO1', signal()), code('INLABS_AUTH_FAILED'));

  const maintenance = stub([loginResponse(), noEditionPage(), new Response(maintenanceHtml)]);
  await maintenance.client.login(signal());
  await assert.rejects(maintenance.client.downloadXml('2026-09-27', 'DO1', signal()), maintenanceError);
});

test('non-HTML invalid bodies never consult the index', async () => {
  const { client, calls } = stub([loginResponse(), new Response(Uint8Array.from([1, 2, 3, 4]))]);
  await client.login(signal());
  await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), code('INLABS_INVALID_DOWNLOAD'));
  assert.equal(calls.length, 2);
});

test('page titles are bounded, markup-free and redact e-mail addresses', () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  assert.equal(pageTitle(encode('<html><body>no title</body></html>')), undefined);
  assert.equal(pageTitle(encode('<title>  a <b>b</b>\n c  </title>')), 'a b c');
  assert.equal(pageTitle(encode('<title>user.name+x@mail.gov.br</title>')), '[email]');
  assert.equal(pageTitle(encode(`<title>${'x'.repeat(500)}</title>`))!.length, 120);
  assert.equal(pageTitle(encode('<title><script>alert(1)</script>"\'`</title>')), 'alert(1)');
});

test('WAF rejection is distinguished from invalid credentials', async () => {
  const { client } = stub([loginResponse(), new Response('<html>The requested URL was rejected.</html>')]);
  await client.login(signal());
  await assert.rejects(client.readDailyIndex('2026-09-18', signal()), code('INLABS_ACCESS_DENIED'));
});

test('rate limits and 5xx preserve Retry-After and otherwise use conservative defaults', async () => {
  for (const status of [429, 503]) {
    const { client } = stub([new Response(null, { status, headers: { 'retry-after': '90' } })]);
    await assert.rejects(client.login(signal()), error => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.retryable, true);
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryAfterSeconds, 90);
      return true;
    });
  }

  const { client } = stub([new Response(null, { status: 502 })]);
  await assert.rejects(client.login(signal()), error => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, 'INLABS_UNAVAILABLE');
    assert.equal(error.retryAfterSeconds, 20);
    return true;
  });
});

test('credentials and transport details never appear in network errors', async () => {
  const { client } = stub([new Error('private-test-value test-session')]);
  await assert.rejects(client.login(signal()), error => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, 'INLABS_NETWORK_ERROR');
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes('private-test-value'));
    return true;
  });
});

test('size limit applies both with Content-Length and to streamed bytes', async () => {
  for (const headers of [{ 'content-length': '100' }, {}]) {
    const { client } = stub([loginResponse(), new Response(zip, { headers })], 10);
    await client.login(signal());
    await assert.rejects(client.downloadXml('2026-09-18', 'DO1', signal()), code('INLABS_RESPONSE_TOO_LARGE'));
  }
});

test('invalid dates and injected sections fail before sending any request', async () => {
  const { client, calls } = stub([]);
  for (const date of ['2026-02-30', '2026-13-01', '../index.php', 'bad']) {
    await assert.rejects(client.downloadXml(date, 'DO1', signal()), code('INLABS_INVALID_DATE'));
  }
  await assert.rejects(client.downloadPdf('2026-09-18', 'do1', signal(), '../'), code('INLABS_INVALID_SECTION'));
  assert.equal(calls.length, 0);
});

test('cancellation is inherited from the existing executor without an internal retry loop', async () => {
  let observedSignal: AbortSignal | null | undefined;
  const client = new InlabsClient({ credentials, fetch: ((_url, options) => {
    observedSignal = options?.signal;
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as typeof fetch });
  const result = await executeConnector({
    connector: { key: 'inlabs-transport-test', collect: async context => {
      await client.login(context.signal);
      return { publications: [] };
    } }, sourceId: 'source', runId: 'run', attemptId: 'attempt', timeoutMs: 15,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 'TIMEOUT');
  assert.equal(observedSignal?.aborted, true);
});
