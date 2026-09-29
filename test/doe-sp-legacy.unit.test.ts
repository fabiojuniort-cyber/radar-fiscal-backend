import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorError } from '../src/modules/collection/connector.error.js';
import {
  DOE_SP_LEGACY_END,
  DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS,
  DoeSpLegacyConnector,
  doeSpLegacyPeriod,
  emptyDoeSpLegacyState,
  resolveDoeSpLegacySourceLimits,
  type DoeSpLegacySourceState,
} from '../src/modules/collection/doe-sp-legacy.connector.js';
import {
  canonicalLegacyLink,
  doeSpLegacyPdfUrl,
  doeSpLegacyResultScreenUrl,
  doeSpLegacyResultUrl,
  doeSpLegacyViewerUrl,
  parseDoeSpLegacyCadernos,
  parseDoeSpLegacyResults,
} from '../src/modules/collection/doe-sp-legacy.parser.js';
import { doeSpLegacyTaxTerms, isDoeSpLegacyNewsPage } from '../src/modules/collection/doe-sp-legacy.rules.js';
import {
  parseDoeSpLegacySourceState,
  reopenFailedLegacyPages,
} from '../src/modules/collection/doe-sp-legacy-source-state.repository.js';
import { extractDoeSpLegacyPdfText } from '../src/modules/collection/doe-sp-legacy.text.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { legacyPortal, scanPdf, textPdf, type LegacyPage, type LegacyPortalOptions } from './doe-sp-legacy.portal.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const context = () => ({
  sourceId: SOURCE_ID,
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
});
const NOW = new Date('2026-09-29T12:00:00Z');
const EX1 = [{ id: 'ex1', name: 'Executivo I' }, { id: 'ex2', name: 'Executivo II' }];

function page(date: string, n: number, lines: string[] | 'scan', extra: Partial<LegacyPage> = {}): LegacyPage {
  const [y, m, d] = date.split('-');
  return {
    link: `/${y}/executivo secao i/m${m}/${d}/pag_${String(n).padStart(4, '0')}_ID${y}${m}${d}${n}.pdf`,
    pagina: String(n),
    date,
    caderno: 'Executivo I',
    pdf: lines === 'scan' ? scanPdf() : textPdf(lines),
    ...extra,
  };
}

function connector(portal: LegacyPortalOptions, state: DoeSpLegacySourceState, options: { maxPeriodsPerRun?: number; maxDownloadBytesPerRun?: number } = {}) {
  const api = legacyPortal(portal);
  const instance = new DoeSpLegacyConnector({
    fetch: api.fetch,
    now: () => NOW,
    readState: async () => state,
    client: { timeoutMs: 5_000 },
    maxPeriodsPerRun: options.maxPeriodsPerRun ?? 1,
    ...(options.maxDownloadBytesPerRun !== undefined ? { maxDownloadBytesPerRun: options.maxDownloadBytesPerRun } : {}),
  });
  return { api, instance };
}

function stateAt(cursor: string): DoeSpLegacySourceState {
  return { ...emptyDoeSpLegacyState('1988-01-01'), cursor };
}

// ---------------------------------------------------------------- parser

test('parser: GetCadernos literal, empty day and broken payload', () => {
  assert.deepEqual(parseDoeSpLegacyCadernos("[{'ID':'ex1','texto':'Executivo I'},{'ID':'jc2','texto':'Judiciário II'}];/*"), [
    { id: 'ex1', name: 'Executivo I' },
    { id: 'jc2', name: 'Judiciário II' },
  ]);
  assert.deepEqual(parseDoeSpLegacyCadernos('[]'), []);
  assert.throws(() => parseDoeSpLegacyCadernos('<html>erro</html>'), (error: unknown) =>
    error instanceof ConnectorError && error.code === 'DOE_SP_LEGACY_INVALID_CADERNOS');
});

test('parser: result screen, double-encoded links, negative page and unknown page', () => {
  const html = '<div>Documentos encontrados: 2</div>' +
    '<a href="/DO/BuscaDO2001Documento_11_4.aspx?link=%2f1995%2fexecutivo%2520secao%2520i%2fsetembro%2f06%2fpag_0001_AB.pdf&amp;pagina=1&amp;data=06/09/1995&amp;caderno=Executivo I&amp;paginaordenacao=100001">p1</a>' +
    '<a href="/DO/BuscaDO2001Documento_11_4.aspx?link=%2f1995%2fexecutivo%2520secao%2520i%2fsetembro%2f06%2fpag_0001_AB.pdf&amp;pagina=1&amp;data=06/09/1995&amp;caderno=Executivo I&amp;paginaordenacao=100001">dup</a>' +
    '<a href="/DO/BuscaDO2001Documento_11_4.aspx?link=%2f2023%2fexecutivo+secao+i%2fjunho%2f01%2fpag_0002_CD.pdf&amp;pagina=2&amp;data=01/06/2023&amp;caderno=Executivo I&amp;paginaordenacao=100002">p2</a>' +
    '<a href="/DO/BuscaDO2001Documento_11_4.aspx?link=javascript:x&amp;pagina=3&amp;data=99/99/2023&amp;caderno=Executivo I&amp;paginaordenacao=3">bad</a>';
  const parsed = parseDoeSpLegacyResults(html, 'https://www.imprensaoficial.com.br/DO/BuscaDO2001Resultado_11_3.aspx?x=1');
  assert.equal(parsed.found, true);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.malformed, 1);
  assert.deepEqual(parsed.items.map((item) => item.link), [
    '/1995/executivo secao i/setembro/06/pag_0001_AB.pdf',
    '/2023/executivo secao i/junho/01/pag_0002_CD.pdf',
  ]);
  assert.equal(parsed.items[0]!.date, '1995-09-06');

  assert.deepEqual(
    parseDoeSpLegacyResults('<html>…</html>', 'https://www.imprensaoficial.com.br/DO/BuscaDO2001ResultadoNegativo_11_3a.aspx?q=1'),
    { found: false, total: 0, items: [], malformed: 0 },
  );
  assert.throws(() => parseDoeSpLegacyResults('<html>manutenção</html>', 'https://www.imprensaoficial.com.br/DO/BuscaDO2001Resultado_11_3.aspx'),
    (error: unknown) => error instanceof ConnectorError && error.code === 'DOE_SP_LEGACY_INVALID_RESULT_PAGE');
  assert.equal(canonicalLegacyLink('%2f2015%2fexecutivo%2520secao%2520i%2fx.pdf'), '/2015/executivo secao i/x.pdf');
});

test('parser: URLs keep the portal shapes (viewer link preserved, GatewayPDF, screens)', () => {
  const ref = { link: '/1995/executivo secao i/setembro/06/pag_0001_AB.pdf', pagina: '1', date: '1995-09-06', caderno: 'Executivo I', paginaOrdenacao: '100001' };
  assert.equal(
    doeSpLegacyViewerUrl(ref),
    'https://www.imprensaoficial.com.br/DO/BuscaDO2001Documento_11_4.aspx?link=%2F1995%2Fexecutivo%2520secao%2520i%2Fsetembro%2F06%2Fpag_0001_AB.pdf&pagina=1&data=06%2F09%2F1995&caderno=Executivo+I&paginaordenacao=100001',
  );
  assert.equal(
    doeSpLegacyPdfUrl(ref),
    'https://www.imprensaoficial.com.br/DO/GatewayPDF.aspx?pagina=1&caderno=Executivo%20I&data=06/09/1995&link=/1995/executivo%20secao%20i/setembro/06/pag_0001_AB.pdf&paginaordenacao=100001',
  );
  const first = doeSpLegacyResultUrl({ from: '2015-03-01', to: '2015-03-31', caderno: { id: 'ex1', name: 'Executivo I' }, keyword: 'ICMS' });
  const params = new URL(first).searchParams;
  assert.equal(params.get('filtrotipopalavraschavesalvar'), 'UP');
  assert.equal(params.get('filtroperiodo'), '01/03/2015 a 31/03/2015');
  assert.equal(params.get('filtrocadernossalvar'), 'ex1');
  assert.equal(params.get('xhitlist_vpc'), 'first');
  assert.equal(new URL(doeSpLegacyResultScreenUrl(first, 3)).searchParams.get('xhitlist_vpc'), '3');
  const browse = new URL(doeSpLegacyResultUrl({ from: '1995-09-06', to: '1995-09-06', caderno: { id: 'ex1', name: 'Executivo I' } })).searchParams;
  assert.equal(browse.get('filtrotipopalavraschavesalvar'), 'FE');
  assert.equal(browse.get('filtropalavraschave'), ' ');
});

// ---------------------------------------------------------------- rules / text

test('rules: tax vocabulary of the current connector plus legacy terms; ambiguous words alone do not qualify', () => {
  assert.deepEqual(doeSpLegacyTaxTerms('Decreto nº 1 — dispõe sobre o ICMS e o IPVA.'), ['ICMS', 'IPVA']);
  assert.deepEqual(doeSpLegacyTaxTerms('Portaria CAT 12, de 1988: recolhimento do ICM.'), ['PORTARIA CAT', 'ICM']);
  assert.deepEqual(doeSpLegacyTaxTerms('Tribunal de Impostos e Taxas — sessão'), ['IMPOSTOS', 'TRIBUNAL DE IMPOSTOS E TAXAS']);
  assert.deepEqual(doeSpLegacyTaxTerms('Concurso: taxa de inscrição. Secretaria da Fazenda — férias de servidor.'), []);
  assert.equal(isDoeSpLegacyNewsPage('/2005/executivo secao i/marco/02/pagnot_0001_X.pdf'), true);
  assert.equal(isDoeSpLegacyNewsPage('/2005/executivo secao i/marco/02/pag_0001_X.pdf'), false);
});

test('text: native page vs scan without text layer; invalid bytes fail as processing error', async () => {
  const native = await extractDoeSpLegacyPdfText(textPdf(['DECRETO N. 1', 'Dispõe sobre o ICMS']));
  assert.equal(native.extraction, 'PDF_NATIVE_TEXT');
  assert.equal(native.scanned, false);
  assert.match(native.text, /DECRETO N\. 1\nDispõe sobre o ICMS/);

  const scan = await extractDoeSpLegacyPdfText(scanPdf());
  assert.equal(scan.scanned, true);
  assert.equal(scan.extraction, 'EMPTY');

  await assert.rejects(() => extractDoeSpLegacyPdfText(new TextEncoder().encode('<html>')), (error: unknown) =>
    error instanceof ConnectorError && error.code === 'DOE_SP_LEGACY_INVALID_PDF');
});

test('periods: one date before the index start, one month after; the range ends at 30/06/2023', () => {
  assert.deepEqual(doeSpLegacyPeriod('2002-12-31', DOE_SP_LEGACY_END), { mode: 'BROWSE', from: '2002-12-31', to: '2002-12-31', next: '2003-01-01' });
  assert.deepEqual(doeSpLegacyPeriod('2003-01-01', DOE_SP_LEGACY_END), { mode: 'SEARCH', from: '2003-01-01', to: '2003-01-31', next: '2003-02-01' });
  assert.deepEqual(doeSpLegacyPeriod('2023-06-01', DOE_SP_LEGACY_END), { mode: 'SEARCH', from: '2023-06-01', to: '2023-06-30', next: null });
});

test('limits: politeness defaults and validation', () => {
  assert.deepEqual(resolveDoeSpLegacySourceLimits({}), { minRequestIntervalMs: 1000, maxDownloadBytesPerRun: 200 * 1024 * 1024 });
  assert.throws(() => resolveDoeSpLegacySourceLimits({ DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS: '-1' }), RangeError);
});

// ---------------------------------------------------------------- connector

test('browse (before 2003): lists the whole edition, reads every page, keeps only pages with tax terms', async () => {
  const date = '1995-09-06';
  const pages = [
    page(date, 1, ['DECRETO N. 40.000, DE 5 DE SETEMBRO DE 1995', 'Altera o Regulamento do ICMS']),
    page(date, 2, ['Nomeações e férias de servidores']),
    page(date, 3, 'scan'),
    ...Array.from({ length: 14 }, (_, i) => page(date, 4 + i, ['Atos diversos'])),
  ];
  const { api, instance } = connector({ cadernos: { [date]: EX1 }, editions: { [`${date}|Executivo I`]: pages } }, stateAt(date));
  const result = await instance.collect(context());

  assert.equal(result.publications.length, 1);
  const kept = result.publications[0]!;
  assert.equal(kept.externalId, pages[0]!.link);
  assert.equal(kept.officialUrl, doeSpLegacyViewerUrl({ ...pages[0]!, paginaOrdenacao: '100001' }));
  assert.equal(kept.title, 'Diário Oficial do Estado de São Paulo — Executivo I — 06/09/1995 — página 1');
  assert.equal(kept.stateCode, 'SP');
  assert.match(kept.content ?? '', /Regulamento do ICMS/);
  assert.equal(kept.files?.[0]?.versionRole, 'PROVENANCE');
  assert.equal(kept.files?.[0]?.metadata?.stored, false);
  assert.equal(kept.metadata?.discovery, 'EDITION_BROWSE');
  assert.deepEqual(kept.metadata?.matchedTaxTerms, ['ICMS']);

  // Two result screens (17 pages, 15 per screen), every page read once.
  assert.equal(api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3')).length, 2);
  assert.equal(api.requests.filter((r) => r.includes('GatewayPDF')).length, 17);

  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.cursor, '1995-09-07');
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.needsOcr.map((ref) => ref.link), [pages[2]!.link]);
  assert.equal(state.totals.pagesKept, 1);
  assert.equal(state.totals.pagesWithoutTaxTerms, 15);
  assert.deepEqual(result.completion, { complete: false, reason: 'TIME_BUDGET_REACHED', pending: { pendingPages: 0, cursorDate: 19950907 } });

  // Page persisted as a normalized STATE publication, PDF as provenance only.
  const normalized = normalizePublication({ sourceId: SOURCE_ID, publication: kept });
  assert.equal(normalized.contentHashVersion, 2);
  assert.equal(normalized.uf, 'SP');
});

test('browse: a day without Executivo I edition is listed as empty and the cursor advances', async () => {
  const { api, instance } = connector({ cadernos: {} }, stateAt('1990-01-01'));
  const result = await instance.collect(context());
  assert.deepEqual(result.publications, []);
  assert.equal(parseDoeSpLegacySourceState(result.checkpoint!.state).cursor, '1990-01-02');
  assert.equal(api.requests.length, 1);
});

test('search (from 2003): one query per term and caderno, hits merged by page, off-period hits and news pages ignored', async () => {
  const icms = page('2015-03-04', 10, ['PORTARIA CAT 30 — ICMS substituição tributária']);
  const ipva = page('2015-03-05', 11, ['Resolução SFP — IPVA 2015']);
  const outside = page('2015-04-01', 12, ['ICMS']);
  const news = page('2015-03-04', 1, ['Notícia sobre o ICMS'], { link: '/2015/executivo secao i/marco/04/pagnot_0001_N.pdf' });
  const exII = { ...page('2015-03-06', 3, ['Crédito acumulado de ICMS']), caderno: 'Executivo II' };
  const { api, instance } = connector({
    search: {
      'ICMS|Executivo I': [icms, outside, news],
      'IPVA|Executivo I': [ipva, icms],
      'tributária|Executivo I': [icms],
      'ICMS|Executivo II': [exII],
    },
  }, stateAt('2015-03-01'));
  const result = await instance.collect(context());

  assert.deepEqual(result.publications.map((p) => p.externalId).sort(), [icms.link, ipva.link, exII.link].sort());
  assert.ok(result.publications.every((p) => p.metadata?.discovery === 'KEYWORD_SEARCH'));
  // Merged: the ICMS page returned by three terms is downloaded once; news and off-period never.
  assert.equal(api.requests.filter((r) => r.includes('GatewayPDF') && r.includes('pag_0010')).length, 1);
  assert.ok(!api.requests.some((r) => r.includes('GatewayPDF') && (r.includes('pagnot_') || r.includes('pag_0012'))));
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.cursor, '2015-04-01');
  assert.equal(state.totals.newsPagesSkipped, 1);
});

test('the last period of the archive closes it: cursor null and a complete run', async () => {
  const { instance } = connector({ search: {} }, stateAt('2023-06-01'));
  const result = await instance.collect(context());
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.cursor, null);
  assert.equal(result.completion, undefined);
  assert.equal(result.partialFailures, undefined);
  assert.equal(typeof state.lastSuccessAt, 'string');
});

test('a page that keeps failing is retried, then abandoned and reported', async () => {
  const date = '1996-01-02';
  const broken = page(date, 1, ['ICMS'], { htmlInsteadOfPdf: true });
  const portal = { cadernos: { [date]: EX1 }, editions: { [`${date}|Executivo I`]: [broken] } };

  // HTML instead of PDF is a source-level glitch: the whole run stops, the page stays pending.
  let state = stateAt(date);
  const first = await connector(portal, state).instance.collect(context());
  state = parseDoeSpLegacySourceState(first.checkpoint!.state);
  assert.equal(first.completion?.reason, 'PARTIAL_FAILURE_RETRY_REQUIRED');
  assert.deepEqual(state.pending.map((p) => p.link), [broken.link]);
  assert.equal(state.cursor, '1996-01-03');

  // An invalid PDF (processing error) counts attempts and is abandoned at the limit.
  const invalid = { ...broken, htmlInsteadOfPdf: false, pdf: new TextEncoder().encode('%PDF-garbage') };
  const portal2 = { cadernos: { [date]: EX1 }, editions: { [`${date}|Executivo I`]: [invalid] } };
  for (let attempt = 1; attempt <= DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS; attempt += 1) {
    const run = await connector(portal2, state).instance.collect(context());
    state = parseDoeSpLegacySourceState(run.checkpoint!.state);
    if (attempt < DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS) {
      assert.equal(state.pending[0]?.attempts, attempt);
      assert.equal(run.partialFailures?.[0]?.code, 'DOE_SP_LEGACY_INVALID_PDF');
    } else {
      assert.deepEqual(state.pending, []);
      assert.equal(run.partialFailures?.[0]?.code, 'DOE_SP_LEGACY_PAGE_ABANDONED');
    }
  }
});

test('source unavailable before anything was read: the run fails (never "0 results")', async () => {
  const { instance } = connector({ failStatus: { match: /./, status: 503 } }, stateAt('1990-01-02'));
  await assert.rejects(() => instance.collect(context()), (error: unknown) =>
    error instanceof ConnectorError && error.kind === 'SOURCE_UNAVAILABLE');
});

test('an unknown result page stops listing and keeps the cursor on the same period', async () => {
  const date = '1997-05-05';
  const { instance } = connector({ cadernos: { [date]: EX1 }, editions: { [`${date}|Executivo I`]: [page(date, 1, ['ICMS'])] }, brokenResults: true }, stateAt(date));
  const result = await instance.collect(context());
  assert.equal(result.partialFailures?.[0]?.code, 'DOE_SP_LEGACY_INVALID_RESULT_PAGE');
  assert.equal(parseDoeSpLegacySourceState(result.checkpoint!.state).cursor, date);
  assert.equal(result.completion?.reason, 'PARTIAL_FAILURE_RETRY_REQUIRED');
});

test('byte budget: stops after the first page read and keeps the rest pending; the next run resumes without listing', async () => {
  const date = '1999-03-03';
  const pages = [page(date, 1, ['ICMS um']), page(date, 2, ['ICMS dois']), page(date, 3, ['ICMS três'])];
  const portal = { cadernos: { [date]: EX1 }, editions: { [`${date}|Executivo I`]: pages } };
  const first = await connector(portal, stateAt(date), { maxDownloadBytesPerRun: 1 }).instance.collect(context());
  assert.equal(first.publications.length, 1);
  assert.equal(first.completion?.reason, 'SOURCE_BUDGET_REACHED');
  const state = parseDoeSpLegacySourceState(first.checkpoint!.state);
  assert.deepEqual(state.pending.map((p) => p.pagina), ['2', '3']);

  const { api, instance } = connector(portal, state, { maxPeriodsPerRun: 0 });
  const second = await instance.collect(context());
  assert.deepEqual(second.publications.map((p) => p.metadata?.pagina), ['2', '3']);
  assert.equal(api.requests.filter((r) => r.includes('BuscaDO2001Resultado')).length > 0, true); // next period listed
  assert.equal(api.requests.filter((r) => r.includes('GetCadernos') && r.includes('1999-03-03')).length, 0);
});

test('state: invalid entries dropped; failed persistence reopens the page in retry', () => {
  const parsed = parseDoeSpLegacySourceState({
    coverageFrom: '1988-01-01', cursor: 'bad', pending: [{ link: '../x.pdf' }, { link: '/1990/a/b.pdf', pagina: '1', date: '1990-01-02', caderno: 'Executivo I', paginaOrdenacao: '100001', discovery: 'EDITION_BROWSE', attempts: 2 }],
    retry: 'x', needsOcr: [], totals: { pagesKept: 3 },
  });
  assert.equal(parsed.cursor, '1988-01-01');
  assert.equal(parsed.pending.length, 1);
  assert.equal(parsed.pending[0]!.attempts, 2);
  assert.equal(parsed.totals.pagesKept, 3);
  assert.equal(parseDoeSpLegacySourceState({ cursor: null }).cursor, null);

  const reopened = reopenFailedLegacyPages(parsed, [
    { externalId: '/1991/c/d.pdf', metadata: { pagina: '4', doeDate: '1991-02-03', caderno: 'Executivo I', paginaOrdenacao: '100004', discovery: 'EDITION_BROWSE' } },
    { externalId: '/1990/a/b.pdf', metadata: { pagina: '1', doeDate: '1990-01-02', caderno: 'Executivo I', paginaOrdenacao: '100001' } },
    { externalId: 'garbage', metadata: {} },
  ]);
  assert.deepEqual(reopened.retry.map((p) => p.link), ['/1991/c/d.pdf']);
});
