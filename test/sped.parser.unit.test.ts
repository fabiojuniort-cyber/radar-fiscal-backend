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


test('keeps official EFD ICMS/IPI technical-note versions as separate publications in one family', () => {
  const v11 = descriptorFromPage(
    'EFD_ICMS_IPI',
    page('7001', 'Nota Técnica 2023.001 v 1.1 (leiaute versão 018)', 'Publicado em 01/11/2023', '7002'),
  );
  const v12 = descriptorFromPage(
    'EFD_ICMS_IPI',
    page('7003', 'Nota Técnica 2023.001 v 1.2 (leiaute versão 018)', 'Publicado em 15/12/2023', '7004'),
  );
  assert.equal(v11?.officialVersion, '1.1');
  assert.equal(v12?.officialVersion, '1.2');
  assert.equal(v11?.documentNumber, '2023.001');
  assert.equal(v12?.documentNumber, '2023.001');
  assert.equal(v11?.documentFamily, v12?.documentFamily);
  assert.notEqual(v11?.actNumber, v12?.actNumber);
  assert.match(v11?.actNumber ?? '', /v1\.1$/);
  assert.match(v12?.actNumber ?? '', /v1\.2$/);
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
  assert.equal(dere?.documentStatus, 'FINAL');
  assert.deepEqual(dere?.relatedTaxes.sort(), ['CBS', 'IBS']);
});




test('parses pagina/show DeRE as an official publication page', () => {
  const parsed = parseSpedPage(
    '<html><body><h2>Receita Federal do Brasil e CGIBS publicam documentação técnica oficial da Declaração de Regimes Específicos (DeRE)</h2>' +
      '<p>Publicado em 12/12/2025</p>' +
      '<p>Pacote de integração Versão 1.0.0 inclui Manual de Orientação Leiautes Schemas XSD IBS CBS</p>' +
      '<a href="/arquivo/download/7951">DeRE_v1.0.0.zip</a>' +
      '</body></html>',
    'https://sped.rfb.gov.br/pagina/show/7950',
  );
  const descriptor = descriptorFromPage('DERE', parsed);
  assert.equal(descriptor?.externalId, 'pagina:7950');
  assert.equal(descriptor?.officialVersion, '1.0.0');
  assert.equal(descriptor?.files.length, 1);
});

test('does not classify technical navigation/category pages as publications without document evidence', () => {
  const parsed = parseSpedPage(
    '<html><body><h1>EFD ICMS IPI</h1><h2>Manuais e Guias Práticos</h2>' +
      '<a href="/item/show/7900">Guia Prático EFD ICMS IPI versão 3.2.1</a>' +
      '<a href="/item/show/8112">Guia Prático EFD ICMS IPI versão 3.2.2</a>' +
      '</body></html>',
    'https://sped.rfb.gov.br/item/show/1573',
  );
  assert.equal(descriptorFromPage('EFD_ICMS_IPI', parsed), undefined);
});

test('parses arquivo/show document pages without treating the HTML page as the binary', () => {
  const parsed = parseSpedPage(
    '<html><body><h1>EFD Contribuições</h1>' +
      '<h2>Nota Técnica 011_2026 - Descontinuidade da EFD-Contribuições - Orientações para os contribuintes do PIS Cofins</h2>' +
      '<p>Data 03/02/2026 00:00:00</p>' +
      '<a href="/arquivo/download/8017">Nota Técnica 011_2026.pdf</a>' +
      '</body></html>',
    'https://sped.rfb.gov.br/arquivo/show/8016',
  );
  const descriptor = descriptorFromPage('EFD_CONTRIBUICOES', parsed);
  assert.equal(descriptor?.externalId, 'arquivo:8016');
  assert.equal(descriptor?.documentNumber, '11/2026');
  assert.equal(descriptor?.files.length, 1);
  assert.match(descriptor?.files[0]?.url ?? '', /\/arquivo\/download\/8017$/);
});


test('marks explicitly identified DeRE minutas as DRAFT without assuming other documents are final', () => {
  const draft = descriptorFromPage(
    'DERE',
    page('8200', 'DeRE - Atualização de Minutas do Manual e dos leiautes', 'Publicado em 23/02/2026 Minuta do Manual e minuta dos leiautes IBS CBS', '8201'),
  );
  assert.equal(draft?.documentStatus, 'DRAFT');
  assert.equal(draft?.revisionKind, 'UPDATE');
});

test('global highlight filter rejects ECD/ECF and accepts only scoped SPED module content', () => {
  assert.equal(isAllowedGlobalHighlight('EFD_ICMS_IPI', 'Nova versão do Guia Prático da EFD ICMS IPI'), true);
  assert.equal(isAllowedGlobalHighlight('EFD_CONTRIBUICOES', 'EFD-CONTRIBUIÇÕES - PUBLICAÇÃO DA NOTA TÉCNICA Nº 12'), true);
  assert.equal(isAllowedGlobalHighlight('DERE', 'DeRE - Atualização de Minutas do Manual e dos leiautes'), true);
  assert.equal(isAllowedGlobalHighlight('EFD_ICMS_IPI', 'Publicação da Versão 12.0.3 do Programa da ECF'), false);
  assert.equal(isAllowedGlobalHighlight('EFD_CONTRIBUICOES', 'Publicação da versão 8.0.0 da ECD'), false);
});
