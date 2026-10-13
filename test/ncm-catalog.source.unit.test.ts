import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAssignableNcmCode,
  normalizeNcmDigits,
  parseNcmCatalogPayload,
} from '../src/modules/taxonomy/ncm/ncm-catalog.source.js';

const fixture = {
  Data_Ultima_Atualizacao_NCM: '01/10/2026',
  Ato: { Tipo: 'Res Gecex', Numero: '999' },
  Nomenclaturas: [
    {
      Codigo: '01',
      Descricao: 'Animais vivos.',
      Data_Inicio: '01/04/2022',
      Data_Fim: '31/12/9999',
      Tipo_Ato_Ini: 'Res Gecex',
      Numero_Ato_Ini: '272',
      Ano_Ato_Ini: '2021',
    },
    {
      Codigo: '1006.30.11',
      Descricao: 'Arroz semibranqueado ou branqueado.',
      Data_Inicio: '01/04/2022',
      Data_Fim: '31/12/9999',
      Tipo_Ato_Ini: 'Res Gecex',
      Numero_Ato_Ini: '272',
      Ano_Ato_Ini: '2021',
    },
  ],
};

test('NCM parser preserves hierarchy and marks only 8-digit codes assignable', () => {
  const parsed = parseNcmCatalogPayload(fixture);

  assert.equal(parsed.sourceUpdatedOnIso, '2026-10-01');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.assignableCount, 1);

  assert.deepEqual(
    parsed.entries.map((entry) => ({
      code: entry.officialCode,
      digits: entry.digits,
      assignable: entry.assignable,
    })),
    [
      { code: '01', digits: '01', assignable: false },
      { code: '1006.30.11', digits: '10063011', assignable: true },
    ],
  );
});

test('NCM parser accepts the real Siscomex vigente date label', () => {
  const parsed = parseNcmCatalogPayload({
    ...fixture,
    Data_Ultima_Atualizacao_NCM: 'Vigente em 01/10/2026',
    Ato: 'Resolução Gecex nº 926/2026',
  });

  assert.equal(parsed.sourceUpdatedOn, 'Vigente em 01/10/2026');
  assert.equal(parsed.sourceUpdatedOnIso, '2026-10-01');
  assert.equal(parsed.act, 'Resolução Gecex nº 926/2026');
});

test('NCM helpers normalize formatted codes', () => {
  assert.equal(normalizeNcmDigits('1006.30.11'), '10063011');
  assert.equal(isAssignableNcmCode('1006.30.11'), true);
  assert.equal(isAssignableNcmCode('01.01'), false);
});

test('NCM parser rejects duplicate official codes', () => {
  assert.throws(
    () => parseNcmCatalogPayload({
      ...fixture,
      Nomenclaturas: [
        fixture.Nomenclaturas[1],
        fixture.Nomenclaturas[1],
      ],
    }),
    /NCM_SOURCE_DUPLICATE_CODE:1006\.30\.11/,
  );
});

test('NCM parser rejects invalid source dates', () => {
  assert.throws(
    () => parseNcmCatalogPayload({
      ...fixture,
      Data_Ultima_Atualizacao_NCM: 'Vigente em 31/02/2026',
    }),
    /NCM_SOURCE_INVALID_DATE/,
  );
});

test('NCM parser does not loosen row validity dates', () => {
  assert.throws(
    () => parseNcmCatalogPayload({
      ...fixture,
      Nomenclaturas: [
        {
          ...fixture.Nomenclaturas[1],
          Data_Inicio: 'Vigente em 01/04/2022',
        },
      ],
    }),
    /NCM_SOURCE_INVALID_DATE:Nomenclaturas\[0\]\.Data_Inicio/,
  );
});
