import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRfbApiRepresentationUrl,
  buildRfbSearchUrl,
  canonicalizeRfbListingNumber,
  decideRfbCapture,
  extractRfbIdAto,
  parseRfbApiRepresentation,
  parseRfbSearchPage,
} from '../src/modules/collection/rfb-normas.parser.js';
import {
  IN_API_ORIGINAL,
  JOINT_PORTARIA_DUPLICATE_API_ORIGINAL,
  RETIFICATION_API_ORIGINAL,
  RETIFICATION_DUPLICATE_API_ORIGINAL,
  RFB_SEARCH_FIXTURE,
} from './rfb-normas.fixtures.js';

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
  assert.match(buildRfbApiRepresentationUrl('123', 'original'), /\/ato\/123\/visao\/original$/);
  assert.match(buildRfbApiRepresentationUrl('123', 'multivigente'), /\/ato\/123\/visao\/multivigente$/);
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

test('parses modern official API content, dates, attachments and canonical identity', () => {
  const representation = parseRfbApiRepresentation(IN_API_ORIGINAL);
  assert.match(representation.title ?? '', /2\.344/);
  assert.match(representation.normalizedText, /Art\. 1º/);
  assert.match(representation.normalizedHash, /^[a-f0-9]{64}$/);
  assert.equal(representation.publishedAt?.toISOString().slice(0, 10), '2026-09-23');
  assert.equal(representation.effectiveAt?.toISOString().slice(0, 10), '2026-09-23');
  assert.equal(representation.agency, 'RFB');
  assert.equal(representation.type, 'Instrução Normativa');
  assert.equal(representation.number, '2.344');

  const item = parseRfbSearchPage(RFB_SEARCH_FIXTURE).items[0]!;
  const canonical = canonicalizeRfbListingNumber({
    ...item,
    agency: representation.agency!,
    type: representation.type!,
    number: representation.number!,
    publishedAt: representation.publishedAt!,
  }, representation.title);
  assert.equal(canonical.agency, 'RFB');
  assert.equal(canonical.actType, 'INSTRUÇÃO NORMATIVA');
  assert.equal(canonical.actNumber, '2344/2026');
  assert.equal(canonical.actDate?.toISOString().slice(0, 10), '2026-09-22');
});


test('detects retification content even when Sistema Normas inherits the target Portaria title', () => {
  const parsed = parseRfbApiRepresentation(RETIFICATION_API_ORIGINAL);
  assert.equal(parsed.title, 'Portaria RFB nº 619, de 3 de dezembro de 2025');
  assert.equal(parsed.revisionKind, 'RETIFICATION');
  assert.equal(parsed.duplicatePublicationReference, false);
  assert.match(parsed.normalizedText, /^Retificação/);
});

test('detects explicit repeated-publication retification reference', () => {
  const parsed = parseRfbApiRepresentation(RETIFICATION_DUPLICATE_API_ORIGINAL);
  assert.equal(parsed.revisionKind, 'RETIFICATION');
  assert.equal(parsed.duplicatePublicationReference, true);
  assert.match(parsed.normalizedText, /publicação repetida/i);
});

test('detects generic repeated publication reference without retification marker', () => {
  const parsed = parseRfbApiRepresentation(JOINT_PORTARIA_DUPLICATE_API_ORIGINAL);
  assert.equal(parsed.revisionKind, undefined);
  assert.equal(parsed.duplicatePublicationReference, true);
  assert.match(parsed.normalizedText, /^Publicação repetida/i);
});

test('captures joint PGFN/RFB tax transaction notice deterministically', () => {
  const item = {
    idAto: '153623',
    type: 'Edital de Transação',
    number: '5',
    agency: 'PGFN RFB',
    publishedAt: new Date('2026-09-18T00:00:00Z'),
    abstract: 'Torna pública proposta de transação para regularização de débitos tributários.',
    detailUrl: 'https://normas.receita.fazenda.gov.br/sijut2consulta/link.action?idAto=153623',
  };
  assert.deepEqual(decideRfbCapture(item), {
    included: true,
    category: 'OPERATIONAL',
    reason: 'CENTRAL_TAX_TRANSACTION_NOTICE',
  });
});
