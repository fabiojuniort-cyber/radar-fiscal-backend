import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import {
  doeSpEmenta,
  doeSpHtmlText,
  doeSpIdsHash,
  findDoeSpNamed,
  parseDoeSpDetail,
  parseDoeSpEditionStatus,
  parseDoeSpEditionUrl,
  parseDoeSpList,
  parseDoeSpNamedItems,
  parseDoeSpStructured,
  parseDoeSpSupplementaryUrls,
  parseDoeSpTypeCatalogue,
} from '../src/modules/collection/doe-sp.parser.js';
import {
  ID,
  details,
  editionUrl0904,
  filters,
  journals,
  list0904,
  sections,
  status0904,
  structured0904,
  supplementaryUrls,
} from './doe-sp.fixtures.js';

test('DOE-SP catalogue: journals and sections are found by name, not by hard-coded id', () => {
  const journal = findDoeSpNamed(parseDoeSpNamedItems(journals, 'X'), 'executivo');
  assert.equal(journal?.id, 'ca96256b-6ca1-407f-866e-567ef9430123');
  const section = findDoeSpNamed(parseDoeSpNamedItems(sections, 'X'), 'Atos Normativos');
  assert.equal(section?.id, '257b103f-1eb2-4f24-a170-4e553c7e4aac');
  assert.throws(() => parseDoeSpNamedItems({ items: [] }, 'DOE_SP_INVALID_JOURNALS'), (error: unknown) =>
    error instanceof ConnectorError && error.code === 'DOE_SP_INVALID_JOURNALS' && error.kind === 'PROCESSING_ERROR');
});

test('DOE-SP structured summary: flattens the organ tree with full path', () => {
  const entries = parseDoeSpStructured(structured0904);
  assert.equal(entries.length, 9);
  const posto = entries.find((entry) => entry.id === ID.postoFiscal);
  assert.deepEqual(posto?.path, [
    'Atos Normativos', 'SECRETARIA DA FAZENDA E PLANEJAMENTO', 'Subsecretaria da Receita Estadual',
    'Diretoria Geral Executiva da Administração Tributária', 'Delegacias Tributárias',
    'Delegacia Tributária de Araçatuba - DT-9', 'Posto Fiscal de Araçatuba',
  ]);
  assert.deepEqual(parseDoeSpStructured({ items: [] }), []);
  assert.throws(() => parseDoeSpStructured({ journalName: 'Executivo' }), /DOE_SP_INVALID_STRUCTURED_SUMMARY/);
});

test('DOE-SP ids fingerprint is order independent and changes with a new act', () => {
  const ids = parseDoeSpStructured(structured0904).map((entry) => entry.id);
  assert.equal(doeSpIdsHash(ids), doeSpIdsHash([...ids].reverse()));
  assert.notEqual(doeSpIdsHash(ids), doeSpIdsHash([...ids, '739fada3-fd86-49b8-1845-08df197a65f4']));
});

test('DOE-SP list: parses hierarchy/type and isolates malformed items', () => {
  const broken = {
    ...list0904,
    publications: [
      ...list0904.publications,
      { id: 'not-a-guid', title: 'X' },
      { id: '11111111-2222-4333-8444-555555555555', title: '', slug: '', hierarchy: '', date: '' },
    ],
  };
  const parsed = parseDoeSpList(broken);
  assert.equal(parsed.items.length, list0904.publications.length);
  assert.deepEqual(parsed.malformed.map((item) => item.reason), ['INVALID_ID', 'MISSING_REQUIRED_FIELD']);
  const sre = parsed.items.find((item) => item.id === ID.sre43)!;
  assert.deepEqual(sre.hierarchy, ['Executivo', 'Atos Normativos', 'Secretaria da Fazenda e Planejamento', 'Subsecretaria da Receita Estadual']);
  assert.equal(sre.publicationTypeId, 'cb4ba2b1-3c31-4d79-85be-0c348ef04c66');
  assert.throws(() => parseDoeSpList({ items: [] }), /DOE_SP_INVALID_SUMMARY_LIST/);
});

test('DOE-SP type catalogue maps publication type ids', () => {
  const types = parseDoeSpTypeCatalogue(filters);
  assert.equal(types.get('4bfe9767-ed4a-40ed-941f-043854642699'), 'Decreto Numerado');
  assert.equal(types.get('50f23a62-e5ba-45a0-a7ea-dd9b0295a36b'), 'Retificação');
});

test('DOE-SP detail: full text without SEI <title>/CSS, tables kept, ementa detected', () => {
  const detail = parseDoeSpDetail(details[ID.sre43], ID.sre43);
  assert.equal(detail.date, '2026-09-04');
  assert.equal(detail.publicationType, 'Portaria');
  assert.equal(detail.authCode, '2026.09.03.1.1.28.3.214.2102360');
  const text = doeSpHtmlText(detail.contentHtml);
  assert.ok(!/SEI\/GESP/.test(text), 'SEI head title must not leak into the text');
  assert.ok(!/font-size/.test(text), 'CSS must not leak into the text');
  assert.match(text, /Artigo 1º - Fica acrescentado/);
  assert.match(text, /630-0 Receita não tributária - FED - Centro de Estudos PGE/);
  assert.equal(doeSpEmenta(text)?.startsWith('Altera a Portaria CAT 125/11'), true);

  const decree = doeSpHtmlText(parseDoeSpDetail(details[ID.decree70843], ID.decree70843).contentHtml);
  assert.match(decree, /^Dispõe sobre a classificação institucional da Casa Civil/);
  assert.match(decree, /TARCÍSIO DE FREITAS/);
});

test('DOE-SP detail: attachments and contract violations', () => {
  const dicar = parseDoeSpDetail(details[ID.dicar59], ID.dicar59);
  assert.deepEqual(dicar.attachments, [{
    id: 'ede64d5b-2bdc-4c9b-bfd3-841a1c69eded',
    name: 'Anexo_Com DICAR-59 - Publicação Juros ITCMD e IPVA - SET-26.pdf',
    position: 0,
  }]);
  assert.throws(() => parseDoeSpDetail(details[ID.dicar59], ID.sre43), /DOE_SP_PUBLICATION_ID_MISMATCH/);
  assert.throws(() => parseDoeSpDetail({ ...details[ID.sre43], content: null }, ID.sre43), /DOE_SP_PUBLICATION_WITHOUT_CONTENT/);
  assert.throws(() => parseDoeSpDetail({ ...details[ID.sre43], date: '04/09/2026' }, ID.sre43), /DOE_SP_PUBLICATION_MISSING_FIELDS/);
});

test('DOE-SP editions: status, main PDF and supplementary editions', () => {
  const status = parseDoeSpEditionStatus(status0904);
  assert.equal(status.find((item) => item.editionName === 'Executivo_Atos_Normativos')?.number, 169);
  assert.deepEqual(parseDoeSpEditionStatus(null), []);
  assert.equal(parseDoeSpEditionUrl(editionUrl0904)?.fileName, '2d9ae845-29b5-4e1f-bae8-a3a532cbae7f');
  const supplementary = parseDoeSpSupplementaryUrls(supplementaryUrls);
  assert.equal(supplementary.length, 1);
  assert.equal(supplementary[0]!.status, 'Pronto');
  assert.deepEqual(parseDoeSpSupplementaryUrls({}), []);
});
