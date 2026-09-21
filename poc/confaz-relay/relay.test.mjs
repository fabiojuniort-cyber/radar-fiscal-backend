import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

process.env.RELAY_BEARER_TOKEN = 'test-token';
process.env.PORT = '0';

const { default: server } = await import('./testable-server.mjs');

async function request(path, options = {}) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test.after(() => {
  server.close();
});

test('health endpoint is public', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    status: 'ok',
  });
});

test('fetch endpoint requires bearer token', async () => {
  const response = await request(
    '/fetch?path=%2Flegislacao%2Fconvenios%2F2026%2F2026',
  );
  assert.equal(response.status, 401);
});

test('relay rejects non-CONFAZ paths before upstream request', async () => {
  const response = await request(
    '/fetch?path=https%3A%2F%2Fexample.com%2F',
    {
      headers: {
        Authorization: 'Bearer test-token',
      },
    },
  );
  assert.equal(response.status, 400);
  assert.equal(
    JSON.parse(response.body).error,
    'destination_not_allowed',
  );
});

test('relay rejects methods other than GET', async () => {
  const response = await request('/fetch?path=%2F', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
    },
  });
  assert.equal(response.status, 404);
});
