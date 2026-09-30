import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lookupStateRegistration,
  parseGoSintegraResult,
} from '../src/modules/company/state-registration.service.js';

test('parseGoSintegraResult extracts IE and status', () => {
  const result = parseGoSintegraResult(
    `
      <html>
        <body>
          <table>
            <tr>
              <td>Inscrição Estadual - CCE :</td>
              <td>10.779.976-6</td>
            </tr>
            <tr>
              <td>Situação Cadastral Vigente:</td>
              <td>ATIVO - HABILITADO</td>
            </tr>
          </table>
        </body>
      </html>
    `,
    new Date('2026-09-30T12:00:00.000Z'),
  );

  assert.equal(result.registration, '10.779.976-6');
  assert.equal(result.registrationStatus, 'ATIVO - HABILITADO');
  assert.equal(result.lookupStatus, 'SUCCESS');
  assert.equal(result.source, 'SEFAZ_GO_SINTEGRA');
  assert.equal(result.checkedAt, '2026-09-30T12:00:00.000Z');
});

test('lookupStateRegistration posts CNPJ to GO SINTEGRA', async () => {
  const requests: Array<{
    url: string;
    method: string;
    body: string;
  }> = [];

  const result = await lookupStateRegistration(
    '12.345.678/0001-95',
    'GO',
    async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body instanceof URLSearchParams
        ? init.body.toString()
        : '';

      requests.push({ url, method, body });

      if (method === 'GET') {
        return new Response('<html>Consulta SINTEGRA</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'ASPSESSIONID=fake; path=/',
          },
        });
      }

      return new Response(
        '<td>Inscrição Estadual - CCE :</td><td>10.123.456-2</td>',
        {
          status: 200,
          headers: {
            'content-type': 'text/html',
          },
        },
      );
    },
  );

  assert.equal(result.registration, '10.123.456-2');
  assert.equal(requests.length, 2);
  assert.match(
    requests[0]?.url ?? '',
    /Sintegra\/Consulta\/default\.html$/,
  );
  assert.equal(requests[1]?.method, 'POST');
  assert.match(requests[1]?.body ?? '', /tCNPJ=12345678000195/);
  assert.match(requests[1]?.body ?? '', /rTipoDoc=2/);
  assert.match(requests[1]?.body ?? '', /btCGC=Consulta%3D/);
});

test('GO lookup failure stays UNAVAILABLE instead of being treated as missing IE', async () => {
  const result = await lookupStateRegistration(
    '12.345.678/0001-95',
    'GO',
    async () => {
      throw new Error('network unavailable');
    },
  );

  assert.equal(result.registration, null);
  assert.equal(result.registrationStatus, null);
  assert.equal(result.lookupStatus, 'UNAVAILABLE');
  assert.equal(result.source, 'SEFAZ_GO_SINTEGRA');
  assert.ok(result.checkedAt.length > 0);
});

test('unsupported UFs stay explicit instead of inventing IE', async () => {
  const result = await lookupStateRegistration(
    '12.345.678/0001-95',
    'MT',
  );

  assert.equal(result.registration, null);
  assert.equal(result.lookupStatus, 'NOT_SUPPORTED');
  assert.equal(result.source, null);
});

test('lookupStateRegistration falls back to legacy GO landing page', async () => {
  const urls: string[] = [];

  const result = await lookupStateRegistration(
    '12.345.678/0001-95',
    'GO',
    async (input, init) => {
      const url = String(input);
      urls.push(url);

      if (url.endsWith('/default.html')) {
        return new Response('not found', {
          status: 404,
        });
      }

      if ((init?.method ?? 'GET') === 'GET') {
        return new Response('<html>Consulta SINTEGRA</html>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
          },
        });
      }

      return new Response(
        '<td>Inscrição Estadual:</td><td>10.442.221-1</td>',
        {
          status: 200,
          headers: {
            'content-type': 'text/html',
          },
        },
      );
    },
  );

  assert.equal(result.registration, '10.442.221-1');
  assert.equal(urls.length, 3);
  assert.match(urls[0] ?? '', /default\.html$/);
  assert.match(urls[1] ?? '', /default\.asp$/);
  assert.match(urls[2] ?? '', /consultar\.asp$/);
});
