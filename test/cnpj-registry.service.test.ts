import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CnpjRegistryError,
  lookupCnpjRegistry,
  parseBrasilApiCnpj,
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
