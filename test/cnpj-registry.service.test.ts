import assert from 'node:assert/strict';
import test from 'node:test';

import { processLogger } from '../src/infrastructure/logging/process-logger.js';
import {
  CnpjRegistryError,
  lookupCnpjRegistry,
  parseBrasilApiCnpj,
} from '../src/modules/company/cnpj-registry.service.js';

const SUCCESS_PAYLOAD = {
  cnpj: '10515785000350',
  razao_social: 'AGREX DO BRASIL LTDA.',
  nome_fantasia: 'AGREX',
  uf: 'GO',
  municipio: 'GOIATUBA',
  codigo_municipio_ibge: 5209101,
  cep: '75600000',
  logradouro: 'RODOVIA GO 320 KM 3,0',
  numero: 'SN',
  bairro: 'ZONA RURAL',
  cnae_fiscal: 1069400,
  cnae_fiscal_descricao:
    'Moagem e fabricação de produtos de origem vegetal não especificados anteriormente',
  cnaes_secundarios: [],
};

function jsonResponse(
  payload: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(payload),
    {
      status,
      headers: {
        'content-type': 'application/json',
      },
    },
  );
}

test('parseBrasilApiCnpj keeps primary and all secondary CNAEs', () => {
  const result = parseBrasilApiCnpj({
    cnpj: '19131243000197',
    razao_social: 'OPEN KNOWLEDGE BRASIL',
    nome_fantasia: 'REDE PELO CONHECIMENTO LIVRE',
    uf: 'SP',
    cep: '01311902',
    municipio: 'SAO PAULO',
    codigo_municipio_ibge: 3550308,
    logradouro: 'AVENIDA PAULISTA',
    numero: '37',
    complemento: 'ANDAR 4',
    bairro: 'BELA VISTA',
    cnae_fiscal: 9430800,
    cnae_fiscal_descricao:
      'Atividades de associações de defesa de direitos sociais',
    cnaes_secundarios: [
      {
        codigo: 9493600,
        descricao:
          'Atividades de organizações associativas ligadas à cultura e à arte',
      },
      {
        codigo: 9499500,
        descricao:
          'Atividades associativas não especificadas anteriormente',
      },
    ],
  }, new Date('2026-09-30T10:00:00.000Z'));

  assert.equal(result.cnpj, '19131243000197');
  assert.equal(result.legalName, 'OPEN KNOWLEDGE BRASIL');
  assert.equal(
    result.tradeName,
    'REDE PELO CONHECIMENTO LIVRE',
  );
  assert.equal(result.uf, 'SP');
  assert.equal(
    result.municipalityIbgeCode,
    '3550308',
  );
  assert.equal(result.cnaes.length, 3);
  assert.deepEqual(result.cnaes[0], {
    code: '9430800',
    description:
      'Atividades de associações de defesa de direitos sociais',
    isPrimary: true,
  });
  assert.equal(result.cnaes[1]?.isPrimary, false);
  assert.equal(
    result.consultedAt,
    '2026-09-30T10:00:00.000Z',
  );
});

test('lookupCnpjRegistry maps corroborated 404 responses to cnpj_not_found', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async () =>
          jsonResponse(
            { message: 'not found' },
            404,
          ),
      ),
    (error: unknown) =>
      error instanceof CnpjRegistryError &&
      error.code === 'cnpj_not_found',
  );
});

test('lookupCnpjRegistry does not expose QSA or provider extras', async () => {
  const result = await lookupCnpjRegistry(
    '19131243000197',
    async () =>
      jsonResponse({
        cnpj: '19131243000197',
        razao_social: 'OPEN KNOWLEDGE BRASIL',
        uf: 'SP',
        cnae_fiscal: 9430800,
        cnae_fiscal_descricao:
          'Atividade principal',
        qsa: [
          { nome_socio: 'NÃO DEVE VAZAR' },
        ],
      }),
  );

  assert.equal('qsa' in result, false);
  assert.equal(
    result.cnaes[0]?.code,
    '9430800',
  );
});

test('lookupCnpjRegistry rejects a mismatched provider CNPJ', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async () =>
          jsonResponse({
            cnpj: '11222333000181',
            razao_social: 'OUTRA EMPRESA',
            uf: 'GO',
            cnae_fiscal: 4683400,
            cnae_fiscal_descricao:
              'Comércio atacadista',
          }),
      ),
    (error: unknown) =>
      error instanceof CnpjRegistryError &&
      error.code ===
        'cnpj_provider_invalid_response',
  );
});

test('lookupCnpjRegistry succeeds with Minha Receita when BrasilAPI is unavailable', async () => {
  const urls: string[] = [];

  const result = await lookupCnpjRegistry(
    '10515785000350',
    async (input) => {
      const url = String(input);
      urls.push(url);

      if (url.includes('brasilapi.com.br')) {
        return jsonResponse(
          { message: 'unavailable' },
          503,
        );
      }

      return jsonResponse(SUCCESS_PAYLOAD);
    },
  );

  assert.equal(result.cnpj, '10515785000350');
  assert.equal(
    result.source,
    'MINHA_RECEITA_DIRECT',
  );
  assert.equal(urls.length, 2);
  assert.ok(
    urls.some((url) =>
      url.includes('brasilapi.com.br'),
    ),
  );
  assert.ok(
    urls.some((url) =>
      url.includes('minhareceita.org'),
    ),
  );
});

test('lookupCnpjRegistry treats mixed not-found and unavailable responses as provider unavailable', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async (input) =>
          String(input).includes(
            'brasilapi.com.br',
          )
            ? jsonResponse(
                { message: 'not found' },
                404,
              )
            : jsonResponse(
                { message: 'unavailable' },
                503,
              ),
      ),
    (error: unknown) =>
      error instanceof CnpjRegistryError &&
      error.code ===
        'cnpj_provider_unavailable',
  );
});

test('lookupCnpjRegistry aborts the slower provider after the first success', async () => {
  let slowerAborted = false;

  const result = await lookupCnpjRegistry(
    '10515785000350',
    async (input, init) => {
      const url = String(input);

      if (url.includes('brasilapi.com.br')) {
        return jsonResponse(SUCCESS_PAYLOAD);
      }

      return new Promise<Response>(
        (_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              slowerAborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        },
      );
    },
  );

  await new Promise((resolve) =>
    setTimeout(resolve, 0),
  );

  assert.equal(
    result.source,
    'BRASILAPI_MINHA_RECEITA',
  );
  assert.equal(slowerAborted, true);
});

test('lookupCnpjRegistry emits structured provider telemetry without logging the CNPJ', async () => {
  const records: Array<{
    data: Record<string, unknown>;
    message: string;
  }> = [];
  const originalInfo = processLogger.info;
  const originalWarn = processLogger.warn;

  processLogger.info = (data, message) => {
    records.push({ data, message });
  };
  processLogger.warn = (data, message) => {
    records.push({ data, message });
  };

  try {
    await lookupCnpjRegistry(
      '10515785000350',
      async () =>
        jsonResponse(SUCCESS_PAYLOAD),
    );

    await new Promise((resolve) =>
      setTimeout(resolve, 0),
    );
  } finally {
    processLogger.info = originalInfo;
    processLogger.warn = originalWarn;
  }

  assert.ok(records.length >= 1);
  assert.ok(
    records.every(
      (record) =>
        record.message ===
        'cnpj_registry_provider_attempt',
    ),
  );
  assert.ok(
    records.some(
      (record) =>
        typeof record.data.provider === 'string' &&
        typeof record.data.durationMs === 'number' &&
        typeof record.data.outcome === 'string',
    ),
  );
  assert.ok(
    records.every(
      (record) =>
        !('cnpj' in record.data),
    ),
  );
});
