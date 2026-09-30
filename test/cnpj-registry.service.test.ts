import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CnpjRegistryError,
  lookupCnpjRegistry,
  parseBrasilApiCnpj,
  parseCnpjWsCnpj,
} from '../src/modules/company/cnpj-registry.service.js';

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
    cnae_fiscal_descricao: 'Atividades de associações de defesa de direitos sociais',
    cnaes_secundarios: [
      {
        codigo: 9493600,
        descricao: 'Atividades de organizações associativas ligadas à cultura e à arte',
      },
      {
        codigo: 9499500,
        descricao: 'Atividades associativas não especificadas anteriormente',
      },
    ],
  }, new Date('2026-09-30T10:00:00.000Z'));

  assert.equal(result.cnpj, '19131243000197');
  assert.equal(result.legalName, 'OPEN KNOWLEDGE BRASIL');
  assert.equal(result.tradeName, 'REDE PELO CONHECIMENTO LIVRE');
  assert.equal(result.uf, 'SP');
  assert.equal(result.municipalityIbgeCode, '3550308');
  assert.equal(result.cnaes.length, 3);
  assert.deepEqual(result.cnaes[0], {
    code: '9430800',
    description: 'Atividades de associações de defesa de direitos sociais',
    isPrimary: true,
  });
  assert.equal(result.cnaes[1]?.isPrimary, false);
  assert.equal(result.consultedAt, '2026-09-30T10:00:00.000Z');
});

test('lookupCnpjRegistry maps 404 to cnpj_not_found', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async () =>
          new Response(
            JSON.stringify({ message: 'not found' }),
            {
              status: 404,
              headers: {
                'content-type': 'application/json',
              },
            },
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
      new Response(
        JSON.stringify({
          cnpj: '19131243000197',
          razao_social: 'OPEN KNOWLEDGE BRASIL',
          uf: 'SP',
          cnae_fiscal: 9430800,
          cnae_fiscal_descricao: 'Atividade principal',
          qsa: [{ nome_socio: 'NÃO DEVE VAZAR' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
  );

  assert.equal('qsa' in result, false);
  assert.equal(result.cnaes[0]?.code, '9430800');
});


test('lookupCnpjRegistry rejects a mismatched provider CNPJ', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async () =>
          new Response(
            JSON.stringify({
              cnpj: '11222333000181',
              razao_social: 'OUTRA EMPRESA',
              uf: 'GO',
              cnae_fiscal: 4683400,
              cnae_fiscal_descricao: 'Comércio atacadista',
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
              },
            },
          ),
      ),
    (error: unknown) =>
      error instanceof CnpjRegistryError &&
      error.code === 'cnpj_provider_invalid_response',
  );
});

test('lookupCnpjRegistry falls back to Minha Receita when BrasilAPI is unavailable', async () => {
  const urls: string[] = [];

  const result = await lookupCnpjRegistry(
    '10515785000350',
    async (input) => {
      const url = String(input);
      urls.push(url);

      if (url.includes('brasilapi.com.br')) {
        return new Response(
          JSON.stringify({ message: 'unavailable' }),
          {
            status: 503,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
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
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    },
  );

  assert.equal(result.cnpj, '10515785000350');
  assert.equal(result.source, 'MINHA_RECEITA_DIRECT');
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? '', /brasilapi\.com\.br/);
  assert.match(urls[1] ?? '', /minhareceita\.org/);
});


test('parseCnpjWsCnpj maps only the cadastral fields used by the product', () => {
  const result = parseCnpjWsCnpj(
    {
      razao_social: 'OPEN KNOWLEDGE BRASIL',
      socios: [
        {
          nome: 'NÃO DEVE VAZAR',
        },
      ],
      estabelecimento: {
        cnpj: '19131243000197',
        nome_fantasia:
          'REDE PELO CONHECIMENTO LIVRE',
        situacao_cadastral: 'ATIVA',
        data_inicio_atividade: '2013-10-03',
        tipo_logradouro: 'AVENIDA',
        logradouro: 'PAULISTA',
        numero: '37',
        complemento: 'ANDAR 4',
        bairro: 'BELA VISTA',
        cep: '01311902',
        estado: {
          sigla: 'SP',
        },
        cidade: {
          nome: 'SAO PAULO',
          ibge_id: 3550308,
        },
        atividade_principal: {
          id: '9430800',
          descricao:
            'Atividades de associações de defesa de direitos sociais',
        },
        atividades_secundarias: [
          {
            id: '9493600',
            descricao:
              'Atividades de organizações associativas ligadas à cultura e à arte',
          },
        ],
        inscricoes_estaduais: [
          {
            inscricao_estadual:
              'NÃO DEVE SER USADA COMO IE OFICIAL',
            ativo: true,
          },
        ],
      },
    },
    new Date('2026-09-30T20:00:00.000Z'),
  );

  assert.equal(
    result.source,
    'CNPJ_WS_PUBLIC',
  );
  assert.equal(
    result.cnpj,
    '19131243000197',
  );
  assert.equal(
    result.legalName,
    'OPEN KNOWLEDGE BRASIL',
  );
  assert.equal(
    result.street,
    'AVENIDA PAULISTA',
  );
  assert.equal(
    result.municipalityIbgeCode,
    '3550308',
  );
  assert.equal(
    result.cnaes.length,
    2,
  );
  assert.equal(
    'socios' in result,
    false,
  );
  assert.equal(
    'stateRegistration' in result,
    false,
  );
  assert.equal(
    'inscricoes_estaduais' in result,
    false,
  );
});

test('lookupCnpjRegistry uses CNPJ.ws only after both primary providers fail', async () => {
  const urls: string[] = [];

  const result = await lookupCnpjRegistry(
    '19131243000197',
    async (input) => {
      const url = String(input);
      urls.push(url);

      if (
        !url.includes(
          'publica.cnpj.ws',
        )
      ) {
        return new Response(
          JSON.stringify({
            message: 'unavailable',
          }),
          {
            status: 503,
            headers: {
              'content-type':
                'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          razao_social:
            'OPEN KNOWLEDGE BRASIL',
          estabelecimento: {
            cnpj: '19131243000197',
            nome_fantasia:
              'REDE PELO CONHECIMENTO LIVRE',
            situacao_cadastral: 'ATIVA',
            data_inicio_atividade:
              '2013-10-03',
            logradouro: 'PAULISTA',
            numero: '37',
            bairro: 'BELA VISTA',
            cep: '01311902',
            estado: {
              sigla: 'SP',
            },
            cidade: {
              nome: 'SAO PAULO',
              ibge_id: 3550308,
            },
            atividade_principal: {
              id: '9430800',
              descricao:
                'Atividade principal',
            },
            atividades_secundarias: [],
          },
        }),
        {
          status: 200,
          headers: {
            'content-type':
              'application/json',
          },
        },
      );
    },
  );

  assert.equal(
    result.source,
    'CNPJ_WS_PUBLIC',
  );
  assert.equal(
    urls.length,
    3,
  );
  assert.equal(
    urls.filter((url) =>
      url.includes('publica.cnpj.ws'),
    ).length,
    1,
  );
});

test('lookupCnpjRegistry rejects a mismatched CNPJ.ws fallback response', async () => {
  await assert.rejects(
    () =>
      lookupCnpjRegistry(
        '19131243000197',
        async (input) => {
          const url = String(input);

          if (
            !url.includes(
              'publica.cnpj.ws',
            )
          ) {
            return new Response(
              JSON.stringify({
                message: 'unavailable',
              }),
              {
                status: 503,
                headers: {
                  'content-type':
                    'application/json',
                },
              },
            );
          }

          return new Response(
            JSON.stringify({
              razao_social:
                'OUTRA EMPRESA',
              estabelecimento: {
                cnpj: '11222333000181',
                estado: {
                  sigla: 'GO',
                },
                cidade: {
                  nome: 'GOIANIA',
                  ibge_id: 5208707,
                },
                atividade_principal: {
                  id: '6201501',
                  descricao:
                    'Desenvolvimento de programas de computador sob encomenda',
                },
              },
            }),
            {
              status: 200,
              headers: {
                'content-type':
                  'application/json',
              },
            },
          );
        },
      ),
    (error: unknown) =>
      error instanceof
        CnpjRegistryError &&
      error.code ===
        'cnpj_provider_invalid_response',
  );
});
