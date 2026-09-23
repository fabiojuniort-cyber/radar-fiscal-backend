import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCgibsContainer, parseCgibsDate, parseCgibsDetailPage } from '../src/modules/collection/cgibs.parser.js';
import {
  CGIBS,
  bookletsHtml,
  communiqueDetailHtml,
  communiquesHtml,
  dereHtml,
  newsHtml,
  operationalNewsDetailHtml,
  portariasHtml,
  regulationsHtml,
  resolutionsHtml,
  splitPaymentHtml,
  technicalIndexHtml,
} from './cgibs.fixtures.js';

test('parses Portuguese dates and formal resolutions with strong normative fields', () => {
  assert.equal(parseCgibsDate('30/04/2026')?.toISOString().slice(0, 10), '2026-04-30');
  assert.equal(parseCgibsDate('30 de abril de 2026')?.toISOString().slice(0, 10), '2026-04-30');

  const parsed = parseCgibsContainer(resolutionsHtml, 'RESOLUTIONS', CGIBS + 'resolucoes');
  assert.equal(parsed.documents.length, 2);
  const six = parsed.documents.find((item) => item.actNumber === '6/2026');
  assert.ok(six);
  assert.equal(six.actType, 'RESOLUÇÃO CGIBS');
  assert.equal(six.publishedAt?.toISOString().slice(0, 10), '2026-04-30');
  assert.equal(six.sourceRole, 'PRIMARY');
  assert.match(six.externalId ?? '', /^\/upload\/arquivos\//);
});

test('same official Resolution PDF listed as regulation preserves one stable origin', () => {
  const resolution = parseCgibsContainer(resolutionsHtml, 'RESOLUTIONS', CGIBS + 'resolucoes').documents[0]!;
  const regulation = parseCgibsContainer(regulationsHtml, 'REGULATIONS', CGIBS + 'regulamentos').documents[0]!;
  assert.equal(resolution.externalId, regulation.externalId);
  assert.equal(resolution.officialUrl, regulation.officialUrl);
  assert.equal(resolution.identityKey, regulation.identityKey);
  assert.equal(resolution.sourceRole, 'PRIMARY');
  assert.equal(regulation.sourceRole, 'ENRICHMENT');
});

test('preserves revoked status without changing the formal Portaria identity', () => {
  const parsed = parseCgibsContainer(portariasHtml, 'PORTARIAS', CGIBS + 'portarias');
  assert.equal(parsed.documents.length, 1);
  const item = parsed.documents[0]!;
  assert.equal(item.actType, 'PORTARIA CGIBS');
  assert.equal(item.actNumber, '3/2026');
  assert.equal(item.documentStatus, 'REVOKED');
  assert.equal(item.revisionKind, 'REVOKED');
});

test('technical current and historical formal versions are distinct, while container status stays outside document family', () => {
  const parsed = parseCgibsContainer(dereHtml, 'TECHNICAL_DOCUMENTS', CGIBS + 'declaracao-de-regimes-especificos-dere');
  const layouts = parsed.documents.filter((item) => /Leiautes da DeRE/.test(item.title));
  assert.equal(layouts.length, 2);
  const current = layouts.find((item) => item.officialVersion === '1.2.0');
  const previous = layouts.find((item) => item.officialVersion === '1.1.0');
  assert.ok(current);
  assert.ok(previous);
  assert.notEqual(current.identityKey, previous.identityKey);
  assert.doesNotMatch(current.documentFamily, /Versão Atual/i);
  assert.doesNotMatch(previous.documentFamily, /Versões Anteriores/i);
  assert.equal(current.documentStatus, 'CURRENT');
  assert.equal(previous.documentStatus, 'PREVIOUS');
});

test('captures DeRE XSD, Nota Orientativa and Split Payment OpenAPI versions', () => {
  const dere = parseCgibsContainer(dereHtml, 'TECHNICAL_DOCUMENTS', CGIBS + 'declaracao-de-regimes-especificos-dere');
  assert.ok(dere.documents.some((item) => /Arquivos XSD/.test(item.title) && item.officialVersion === '1.2.0'));
  assert.ok(dere.documents.some((item) => /Nota Orientativa/.test(item.title)));

  const split = parseCgibsContainer(splitPaymentHtml, 'TECHNICAL_DOCUMENTS', CGIBS + 'split-payment');
  assert.ok(split.documents.some((item) => /OpenAPI/.test(item.title) && item.officialVersion === '1.1.0'));
  assert.ok(split.documents.some((item) => /OpenAPI/.test(item.title) && item.officialVersion === '0.0.10'));
});

test('discovers technical and official-communique detail pages but filters non-operational news', () => {
  const technical = parseCgibsContainer(technicalIndexHtml, 'TECHNICAL_DOCUMENTS', CGIBS + 'documentos-tecnicos');
  assert.deepEqual(
    technical.pageLinks.map((item) => new URL(item.url).pathname).sort(),
    ['/declaracao-de-regimes-especificos-dere', '/split-payment'],
  );

  const communications = parseCgibsContainer(communiquesHtml, 'OFFICIAL_COMMUNIQUES', CGIBS + 'comunicados-oficiais');
  assert.equal(communications.pageLinks.length, 1);

  const news = parseCgibsContainer(newsHtml, 'NEWS', CGIBS + 'noticias');
  assert.equal(news.pageLinks.length, 1);
  assert.match(news.pageLinks[0]!.title, /XSD da DeRE/);
});

test('creates page-only official communication and operational-news publication when no attachment exists', () => {
  const communication = parseCgibsDetailPage(
    communiqueDetailHtml,
    'OFFICIAL_COMMUNIQUES',
    CGIBS + 'comunicado-oficial-01-2025',
  );
  assert.equal(communication.documents.length, 1);
  const doc = communication.documents[0]!;
  assert.equal(doc.actType, 'COMUNICADO OFICIAL');
  assert.equal(doc.actNumber, '01/2025');
  assert.equal(doc.publishedAt?.toISOString().slice(0, 10), '2025-12-23');
  assert.equal(doc.metadata.officialUrlGranularity, 'PAGE');

  const news = parseCgibsDetailPage(
    operationalNewsDetailHtml,
    'NEWS',
    CGIBS + 'noticia-atualizacao-xsd-dere',
  );
  assert.equal(news.documents.length, 1);
  assert.ok(news.documents[0]!.fileUrl);
  assert.equal(news.documents[0]!.sourceRole, 'ENRICHMENT');
});

test('empty valid container is a successful no-results parse', () => {
  const parsed = parseCgibsContainer(
    '<!doctype html><html><body><main><h1>Resoluções</h1><p>Nenhuma publicação encontrada.</p></main></body></html>',
    'RESOLUTIONS',
    CGIBS + 'resolucoes',
  );
  assert.deepEqual(parsed.documents, []);
  assert.deepEqual(parsed.pageLinks, []);
});

test('booklet formal editions remain separate document identities', () => {
  const parsed = parseCgibsContainer(bookletsHtml, 'BOOKLETS', CGIBS + 'cartilhas');
  assert.equal(parsed.documents.length, 1);
  assert.equal(parsed.documents[0]!.sourceRole, 'ENRICHMENT');
  assert.equal(parsed.documents[0]!.officialVersion, '2.0');
});
