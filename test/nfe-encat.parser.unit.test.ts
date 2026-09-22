import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseNfeEncatListing } from '../src/modules/collection/nfe-encat.parser.js';

const FIXTURE = new URL('./fixtures/nfe-encat/', import.meta.url);
const URLS = {
  notes: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=',
  reports: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4=',
  schemas: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=',
  manuals: 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE=',
};

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE), 'utf8');
}

test('parses NT 2023.003 v1.30, NT 2026.009 v1.00 and keeps 2025.002 official versions independent', async () => {
  const items = parseNfeEncatListing(await fixture('technical-notes.html'), 'TECHNICAL_NOTES', URLS.notes);
  assert.equal(items.length, 4);
  const nt2026009 = items.find(item => item.documentNumber === '2026.009');
  assert.equal(nt2026009?.officialVersion, '1.00');
  assert.equal(nt2026009?.publishedAt?.toISOString().slice(0, 10), '2026-09-09');
  assert.equal(nt2026009?.documentStatus, 'CURRENT');
  const nt2023003 = items.find(item => item.documentNumber === '2023.003');
  assert.equal(nt2023003?.officialVersion, '1.30');
  assert.equal(nt2023003?.publishedAt?.toISOString().slice(0, 10), '2026-07-29');
  assert.equal(nt2023003?.documentStatus, 'RETIRED');
  const rtc = items.filter(item => item.documentFamily === 'NT 2025.002');
  assert.deepEqual(rtc.map(item => item.officialVersion).sort(), ['1.40', '1.50']);
  assert.notEqual(rtc[0]?.externalId, rtc[1]?.externalId);
});

test('parses successive versions of Informe Técnico 2025.002', async () => {
  const items = parseNfeEncatListing(await fixture('technical-reports.html'), 'TECHNICAL_REPORTS', URLS.reports);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.officialVersion), ['1.03', '1.02']);
  assert.ok(items.every(item => item.documentFamily === 'IT 2025.002'));
});

test('classifies schemas as production, homologation and retired and excludes other DF-e', async () => {
  const items = parseNfeEncatListing(await fixture('schemas.html'), 'SCHEMAS', URLS.schemas);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(item => [item.documentStatus, item.environment]), [
    ['CURRENT', 'PRODUCTION'],
    ['TESTING', 'HOMOLOGATION'],
    ['RETIRED', undefined],
  ]);
  assert.ok(items.every(item => !/NFGas|NFAg|NFCom/i.test(item.title)));
  const tokenWithPlus = items.find(item => item.documentStatus === 'TESTING')?.contentToken;
  assert.equal(tokenWithPlus, 'SCHEMATEST+ABC=');
});

test('keeps only NF-e/NFC-e manuals and excludes manuals for other DF-e', async () => {
  const items = parseNfeEncatListing(await fixture('manuals.html'), 'MANUALS', URLS.manuals);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.documentFamily, 'MOC NF-E/NFC-E');
  assert.equal(items.some(item => /NFGas/i.test(item.title)), false);
});
