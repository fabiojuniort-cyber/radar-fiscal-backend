import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRfbRepresentationUrl,
  buildRfbSearchUrl,
  canonicalizeRfbListingNumber,
  decideRfbCapture,
  extractRfbIdAto,
  parseRfbRepresentationHtml,
  parseRfbSearchPage,
} from '../src/modules/collection/rfb-normas.parser.js';
import { RFB_SEARCH_FIXTURE, IN_ORIGINAL } from './rfb-normas.fixtures.js';

test('parses Sistema Normas search results with official idAto and pagination', () => {
  const page = parseRfbSearchPage(RFB_SEARCH_FIXTURE, 1);
  assert.equal(page.totalCount, 5);
  assert.equal(page.totalPages, 1);
  assert.equal(page.items.length, 5);
  assert.equal(page.items[0]!.idAto, '150001');
  assert.equal(page.items[1]!.agency, 'Cosit');
  assert.equal(page.items[0]!.publishedAt.toISOString().slice(0, 10), '2026-09-21');
});

test('extracts idAto from modern and legacy official URLs', () => {
  assert.equal(extractRfbIdAto('https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/123456'), '123456');
  assert.equal(extractRfbIdAto('https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?idAto=98765'), '98765');
});

test('builds publication-date search and official representation URLs', () => {
  const url = new URL(buildRfbSearchUrl({
    start: new Date('2026-09-17T00:00:00Z'),
    end: new Date('2026-09-23T00:00:00Z'),
    page: 2,
  }));
  assert.equal(url.searchParams.get('tipoData'), '2');
  assert.equal(url.searchParams.get('dt_inicio'), '17/09/2026');
  assert.equal(url.searchParams.get('dt_fim'), '23/09/2026');
  assert.equal(url.searchParams.get('p'), '2');
  assert.match(buildRfbRepresentationUrl('123', 'original'), /visao=original.*idAto=123/);
  assert.match(buildRfbRepresentationUrl('123', 'multivigente'), /visao=anotado.*idAto=123/);
});

test('deterministic filter includes approved scope and records objective exclusions', () => {
  const items = parseRfbSearchPage(RFB_SEARCH_FIXTURE).items;
  const decisions = new Map(items.map(item => [item.idAto, decideRfbCapture(item)]));
  assert.deepEqual(decisions.get('150001'), { included: true, category: 'NORMATIVE', reason: 'NORMATIVE_TYPE' });
  assert.deepEqual(decisions.get('150002'), { included: true, category: 'INTERPRETATIVE', reason: 'COSIT_INTERPRETATIVE' });
  assert.equal(decisions.get('150003')?.included, false);
  assert.equal(decisions.get('150003')?.reason, 'PORTARIA_ADMINISTRATIVE');
  assert.equal(decisions.get('150004')?.included, false);
  assert.equal(decisions.get('150004')?.reason, 'ADE_LOW_VALUE_CERTIFICATION');
  assert.equal(decisions.get('150005')?.included, true);
  assert.equal(decisions.get('150005')?.reason, 'ADE_OPERATIONAL_KEYWORD');
});

test('NCM-only Cosit interpretation is excluded deterministically', () => {
  const item = {
    idAto: '200001',
    type: 'Solução de Consulta',
    number: '999',
    agency: 'Cosit',
    publishedAt: new Date('2026-09-23T00:00:00Z'),
    abstract: 'Assunto: Classificação de Mercadorias. Nomenclatura Comum do Mercosul - NCM.',
    detailUrl: 'https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?idAto=200001',
  };
  assert.deepEqual(decideRfbCapture(item), {
    included: false,
    reason: 'INTERPRETATIVE_NCM_CLASSIFICATION',
  });
});

test('parses printer-friendly original content and canonical formal identity', () => {
  const representation = parseRfbRepresentationHtml(
    IN_ORIGINAL,
    'https://normas.receita.fazenda.gov.br/sijut2consulta/imprimir.action?visao=original&idAto=150001',
  );
  assert.match(representation.title ?? '', /2\.344/);
  assert.match(representation.normalizedText, /Art\. 1º/);
  assert.match(representation.normalizedHash, /^[a-f0-9]{64}$/);

  const item = parseRfbSearchPage(RFB_SEARCH_FIXTURE).items[0]!;
  const canonical = canonicalizeRfbListingNumber(item, representation.title);
  assert.equal(canonical.agency, 'RFB');
  assert.equal(canonical.actType, 'INSTRUÇÃO NORMATIVA');
  assert.equal(canonical.actNumber, '2344/2026');
  assert.equal(canonical.actDate?.toISOString().slice(0, 10), '2026-09-22');
});
