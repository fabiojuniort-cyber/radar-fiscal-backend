import assert from 'node:assert/strict';
import test from 'node:test';

import {
  descriptorFromPage,
  isAllowedGlobalHighlight,
  parseSpedPage,
} from '../src/modules/collection/sped.parser.js';

function page(id: string, title: string, body: string, fileId = '9000', fileName = 'documento.pdf') {
  return parseSpedPage(
    '<!doctype html><html><body><h1>EFD-Reinf</h1><h2>' + title + '</h2>' +
      body + '<a href="/arquivo/download/' + fileId + '">' + fileName + '</a></body></html>',
    'https://sped.rfb.gov.br/item/show/' + id,
  );
}

test('models Guia Prático 3.2.1 and 3.2.2 as distinct official versions in the same family', () => {
  const one = descriptorFromPage(
    'EFD_ICMS_IPI',
    page('7900', 'Guia Prático EFD ICMS IPI versão 3.2.1', 'Data 18/11/2025 00:00:00', '7901'),
  );
  const two = descriptorFromPage(
    'EFD_ICMS_IPI',
    page('8114', 'Guia Prático EFD ICMS IPI versão 3.2.2', 'Publicado em 25/03/2026', '8112'),
  );
  assert.equal(one?.kind, 'GUIDE');
  assert.equal(two?.kind, 'GUIDE');
  assert.equal(one?.officialVersion, '3.2.1');
  assert.equal(two?.officialVersion, '3.2.2');
  assert.equal(one?.documentFamily, two?.documentFamily);
  assert.notEqual(one?.externalId, two?.externalId);
});

test('distinguishes EFD-Reinf NT 01/2026 original and explicit republication', () => {
  const original = descriptorFromPage(
    'EFD_REINF',
    page('8116', 'Nota Técnica 01/2026 – Ajustes nos leiautes da versão 2.1.2', 'Publicado em 25/03/2026', '8117'),
  );
  const republished = descriptorFromPage(
    'EFD_REINF',
    page('8129', 'Nota Técnica 01/2026 republicada – Ajustes nos leiautes da versão 2.1.2', 'Publicado em 31/03/2026', '8130'),
  );
  assert.equal(original?.kind, 'TECHNICAL_NOTE');
  assert.equal(original?.documentNumber, '01/2026');
  assert.equal(original?.actNumber, '01/2026');
  assert.equal(republished?.revisionKind, 'REPUBLICATION');
  assert.equal(republished?.officialVersion, undefined);
  assert.equal(republished?.actNumber, '01/2026 - REPUBLICAÇÃO');
  assert.equal(original?.documentFamily, republished?.documentFamily);
});

test('parses EFD-Contribuições NT 11/2026 update and NT 12/2026', () => {
  const nt11 = descriptorFromPage(
    'EFD_CONTRIBUICOES',
    page('8058', 'EFD-CONTRIBUIÇÕES - ATUALIZAÇÃO DA NOTA TÉCNICA Nº 11 2026', 'Publicado em 20/02/2026 PIS COFINS', '8059'),
  );
  const nt12 = descriptorFromPage(
    'EFD_CONTRIBUICOES',
    page('8126', 'Nota Técnica 012 2026 - ORIENTAÇÃO PARA OS CONTRIBUINTES DE PIS COFINS - LC 224_2025', 'Publicado em 30/03/2026', '8127'),
  );
  assert.equal(nt11?.documentNumber, '11/2026');
  assert.equal(nt11?.revisionKind, 'UPDATE');
  assert.equal(nt12?.documentNumber, '12/2026');
  assert.deepEqual(nt12?.relatedTaxes.sort(), ['COFINS', 'PIS']);
});

test('classifies EFD-Reinf XSD and DeRE official technical package', () => {
  const xsd = descriptorFromPage(
    'EFD_REINF',
    page('2270', 'ESQUEMAS XSD - VERSÃO MAIS RECENTE', 'Pacote XSD Eventos EFD Reinf v 2.1.2', '2271', 'reinf-xsd.zip'),
  );
  const dere = descriptorFromPage(
    'DERE',
    page('7950', 'Receita Federal do Brasil e CGIBS publicam documentação técnica oficial da Declaração de Regimes Específicos (DeRE)', 'Publicado em 12/12/2025 Pacote de integração Versão 1.0.0 inclui Manual de Orientação Leiautes Schemas XSD IBS CBS', '7951', 'DeRE_v1.0.0.zip'),
  );
  assert.equal(xsd?.kind, 'XSD_SCHEMA');
  assert.equal(dere?.kind, 'MANUAL');
  assert.equal(dere?.officialVersion, '1.0.0');
  assert.deepEqual(dere?.relatedTaxes.sort(), ['CBS', 'IBS']);
});

test('global highlight filter rejects ECD/ECF and accepts only scoped SPED module content', () => {
  assert.equal(isAllowedGlobalHighlight('EFD_ICMS_IPI', 'Nova versão do Guia Prático da EFD ICMS IPI'), true);
  assert.equal(isAllowedGlobalHighlight('EFD_CONTRIBUICOES', 'EFD-CONTRIBUIÇÕES - PUBLICAÇÃO DA NOTA TÉCNICA Nº 12'), true);
  assert.equal(isAllowedGlobalHighlight('DERE', 'DeRE - Atualização de Minutas do Manual e dos leiautes'), true);
  assert.equal(isAllowedGlobalHighlight('EFD_ICMS_IPI', 'Publicação da Versão 12.0.3 do Programa da ECF'), false);
  assert.equal(isAllowedGlobalHighlight('EFD_CONTRIBUICOES', 'Publicação da versão 8.0.0 da ECD'), false);
});
