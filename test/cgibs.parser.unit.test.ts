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

test('prefers a formal link title when the page leaves a stale formal heading active', () => {
  const html = `<!doctype html><html><body><main>
  <h1>Resoluções</h1>
  <h4>RESOLUÇÃO CGIBS Nº 2, DE 10 DE MARÇO DE 2026</h4>
  <a href="/upload/arquivos/202603/resolucao-2.pdf">RESOLUÇÃO CGIBS Nº 2, DE 10 DE MARÇO DE 2026</a>
  <p>Publicada e disponibilizada no site do CGIBS em 11/03/2026</p>
  <a href="/upload/arquivos/202603/resolucao-3.pdf">RESOLUÇÃO CGIBS Nº 3, DE 10 DE MARÇO DE 2026</a>
  <p>Publicada e disponibilizada no site do CGIBS em 11/03/2026</p>
  </main></body></html>`;

  const parsed = parseCgibsContainer(html, 'RESOLUTIONS', CGIBS + 'resolucoes');
  assert.equal(parsed.documents.length, 2);
  assert.deepEqual(parsed.documents.map((item) => item.actNumber), ['2/2026', '3/2026']);
  assert.notEqual(parsed.documents[0]!.identityKey, parsed.documents[1]!.identityKey);
  assert.match(parsed.documents[1]!.title, /Nº 3/);
});

test('treats zero-padded heading numbers as equivalent to unpadded link numbers', () => {
  const html = `<!doctype html><html><body><main>
  <h1>Portarias</h1>
  <h4>PORTARIA Nº 01/2026</h4>
  <a href="/upload/arquivos/202605/portaria-1.pdf">Portaria CGIBS nº 1 2026 (.pdf 587,21 KBytes)</a>
  <p>Publicada e disponibilizada no site do CGIBS em 18/05/2026</p>
  </main></body></html>`;

  const parsed = parseCgibsContainer(html, 'PORTARIAS', CGIBS + 'portarias');
  assert.equal(parsed.documents.length, 1);
  const item = parsed.documents[0]!;
  assert.equal(item.title, 'PORTARIA Nº 01/2026');
  assert.equal(item.actNumber, '01/2026');
  assert.equal(item.identityKey, 'CGIBS|ACT|PORTARIA_CGIBS|01_2026');
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


test('keeps publication dates and statuses inside each formal act block', () => {
  const html = `<!doctype html><html><body><main>
  <h1>Atos Técnicos Conjuntos</h1>
  <h4>ATO TÉCNICO CONJUNTO RFB/CGIBS Nº 1, DE 31 DE JULHO DE 2026</h4>
  <a href="/upload/arquivos/202608/ato-1.pdf">AM Ato Tecnico Conjunto Ratificacao NTs DFEs Revisao assinado</a>
  <p>Publicado e disponibilizado no site do CGIBS em 01/08/2026</p>
  <h4>ATO TÉCNICO CONJUNTO RFB/CGIBS Nº 4, DE 28 DE AGOSTO DE 2026</h4>
  <a href="/upload/arquivos/202609/ato-4.pdf">Minuta Ato Tecnico Conjunto n 4 Split assinado assinado</a>
  <p>Publicado e disponibilizado no site do CGIBS em 08/09/2026</p>
  </main></body></html>`;

  const parsed = parseCgibsContainer(
    html,
    'JOINT_TECHNICAL_ACTS',
    CGIBS + 'atos-tecnicos-conjuntos',
  );
  const first = parsed.documents.find((item) => item.actNumber === '1/2026');
  const fourth = parsed.documents.find((item) => item.actNumber === '4/2026');
  assert.ok(first);
  assert.ok(fourth);
  assert.equal(first.publishedAt?.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(fourth.publishedAt?.toISOString().slice(0, 10), '2026-09-08');
  assert.equal(first.documentStatus, 'PUBLISHED');
  assert.equal(first.revisionKind, 'ORIGINAL');
  assert.equal(fourth.documentStatus, 'PUBLISHED');
  assert.equal(fourth.revisionKind, 'ORIGINAL');
});

test('does not leak a later revoked act status into a previous act', () => {
  const html = `<!doctype html><html><body><main>
  <h1>Portarias</h1>
  <h4>PORTARIA Nº 01/2026</h4>
  <a href="/upload/arquivos/202605/portaria-1.pdf">PORTARIA Nº 01/2026</a>
  <p>Publicada e disponibilizada no site do CGIBS em 18/05/2026</p>
  <h4>PORTARIA Nº 03/2026 (REVOGADA)</h4>
  <a href="/upload/arquivos/202606/portaria-3.pdf">PORTARIA Nº 03/2026</a>
  <p>Publicada e disponibilizada no site do CGIBS em 09/06/2026</p>
  </main></body></html>`;

  const parsed = parseCgibsContainer(html, 'PORTARIAS', CGIBS + 'portarias');
  const first = parsed.documents.find((item) => item.actNumber === '01/2026');
  const revoked = parsed.documents.find((item) => item.actNumber === '03/2026');
  assert.ok(first);
  assert.ok(revoked);
  assert.equal(first.documentStatus, 'PUBLISHED');
  assert.equal(first.publishedAt?.toISOString().slice(0, 10), '2026-05-18');
  assert.equal(revoked.documentStatus, 'REVOKED');
  assert.equal(revoked.revisionKind, 'REVOKED');
  assert.equal(revoked.publishedAt?.toISOString().slice(0, 10), '2026-06-09');
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
