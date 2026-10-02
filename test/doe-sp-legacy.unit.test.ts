import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectorTimeBudget } from '../src/modules/collection/connector.contract.js';
import { ConnectorError } from '../src/modules/collection/connector.error.js';
import { createTimeBudget } from '../src/modules/collection/connector.executor.js';
import {
  DOE_SP_LEGACY_END,
  DOE_SP_LEGACY_LISTING_BLOCKED_AFTER,
  DOE_SP_LEGACY_MAX_PAGE_ATTEMPTS,
  DOE_SP_LEGACY_BROWSE_CADERNOS,
  DOE_SP_LEGACY_SEARCH_CADERNOS,
  DOE_SP_LEGACY_STATE_VERSION,
  DoeSpLegacyConnector,
  MAX_NEEDS_OCR_KEPT,
  doeSpLegacyNextPeriod,
  doeSpLegacySearchStart,
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
import {
  DOE_SP_LEGACY_SEARCH_TERMS,
  DOE_SP_LEGACY_TAX_VOCABULARY,
  DOE_SP_LEGACY_TERM_SINCE,
  doeSpLegacyTaxTerms,
  isDoeSpLegacyNewsPage,
} from '../src/modules/collection/doe-sp-legacy.rules.js';
import { asciiUpper } from '../src/modules/collection/doe-sp.parser.js';
import { DOE_SP_TAX_TERMS } from '../src/modules/collection/doe-sp.rules.js';
import {
  parseDoeSpLegacySourceState,
  reopenFailedLegacyPages,
} from '../src/modules/collection/doe-sp-legacy-source-state.repository.js';
import { extractDoeSpLegacyPdfText } from '../src/modules/collection/doe-sp-legacy.text.js';
import { runDoeSpLegacyPilot } from '../src/modules/collection/doe-sp-legacy.pilot.js';
import { normalizePublication } from '../src/modules/collection/publication.normalizer.js';
import { legacyPortal, scanPdf, textPdf, type LegacyPage, type LegacyPortalOptions } from './doe-sp-legacy.portal.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const context = (budget?: ConnectorTimeBudget) => ({
  sourceId: SOURCE_ID,
  runId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  signal: new AbortController().signal,
  ...(budget ? { budget } : {}),
});
const NOW = new Date('2026-09-29T12:00:00Z');
const EX1 = [{ id: 'ex1', name: 'Executivo I' }];
const EX1_EX2 = [...EX1, { id: 'ex2', name: 'Executivo II' }];

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

/** Browse cursor at `cursor`; the search cursor where a run that got there would be. */
function stateAt(cursor: string, searchCursor: string | null = doeSpLegacySearchStart(cursor)): DoeSpLegacySourceState {
  return { ...emptyDoeSpLegacyState('1988-01-01'), cursor, searchCursor };
}

/** A page of Executivo II/III (found by the keyword index from 2003 on). */
function exPage(caderno: 'Executivo II' | 'Executivo III', date: string, n: number, lines: string[]): LegacyPage {
  const base = page(date, n, lines);
  return { ...base, caderno, link: base.link.replace('executivo secao i/', caderno === 'Executivo II' ? 'executivo secao ii/' : 'executivo secao iii/') };
}

/** A date on which every term of the vocabulary is in force. */
const RECENT = '2023-06-30';

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
  assert.deepEqual(doeSpLegacyTaxTerms('Decreto nº 1 — dispõe sobre o ICMS e o IPVA.', RECENT), ['ICMS', 'IPVA']);
  assert.deepEqual(doeSpLegacyTaxTerms('Portaria CAT 12, de 1988: recolhimento do ICM.', '1988-03-02'), ['PORTARIA CAT', 'ICM']);
  assert.deepEqual(doeSpLegacyTaxTerms('Tribunal de Impostos e Taxas — sessão', RECENT), ['IMPOSTOS']);
  assert.deepEqual(doeSpLegacyTaxTerms('Emissão de NFC-e, CT-e e MDFe; obrigações acessórias; taxa judiciária', RECENT), ['NFC-E', 'CT-E', 'MDFE', 'OBRIGACOES ACESSORIAS', 'TAXA JUDICIARIA']);
  // Whole words only: no match inside another word.
  assert.deepEqual(doeSpLegacyTaxTerms('ICMSX e PREIPI e AICM', RECENT), []);
  assert.deepEqual(doeSpLegacyTaxTerms('Concurso: taxa de inscrição. Secretaria da Fazenda — férias de servidor.', RECENT), []);
  assert.throws(() => doeSpLegacyTaxTerms('ICMS', '02/03/1988'), RangeError);
  // Calendar-invalid dates are refused too (review DOE-SP-LEGACY-09R, N1).
  assert.throws(() => doeSpLegacyTaxTerms('ICMS', '2007-02-30'), RangeError);
  assert.throws(() => doeSpLegacyTaxTerms('ICMS', '2019-13-01'), RangeError);
  assert.equal(isDoeSpLegacyNewsPage('/2005/executivo secao i/marco/02/pagnot_0001_X.pdf'), true);
  assert.equal(isDoeSpLegacyNewsPage('/2005/executivo secao i/marco/02/pag_0001_X.pdf'), false);
});

test('rules: CT-e, IBS and CBS count only from 2007, 2019 and 2020 (P1: the acronym alone is another word on older pages)', () => {
  assert.deepEqual(DOE_SP_LEGACY_TERM_SINCE, { CTE: '2007-01-01', IBS: '2019-01-01', CBS: '2020-01-01' });
  const text = 'Cte. da Polícia Militar; CBS e IBS (siglas); CT-e';
  assert.deepEqual(doeSpLegacyTaxTerms(text, '1995-09-06'), []);
  assert.deepEqual(doeSpLegacyTaxTerms(text, '2006-12-31'), []);
  assert.deepEqual(doeSpLegacyTaxTerms(text, '2007-01-01'), ['CTE', 'CT-E']);
  assert.deepEqual(doeSpLegacyTaxTerms(text, '2018-12-31'), ['CTE', 'CT-E']);
  assert.deepEqual(doeSpLegacyTaxTerms(text, '2019-01-01'), ['CTE', 'IBS', 'CT-E']);
  assert.deepEqual(doeSpLegacyTaxTerms(text, '2020-01-01'), ['CTE', 'CBS', 'IBS', 'CT-E']);
  // Another term still keeps an older page; undated acronyms (IPI, ICMS) are unchanged.
  assert.deepEqual(doeSpLegacyTaxTerms('CBS — recolhimento do IPI e do ICM', '1988-03-02'), ['IPI', 'ICM']);
});

/** Top-level alternatives of `\b(?:A|B|C)\b`. */
function alternatives(pattern: RegExp): string[] {
  const body = pattern.source.replace(/^\\b\(\?:/, '').replace(/\)\\b$/, '');
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === '|' && depth === 0) { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out;
}

/** Every family accepted by the current connector, with the spellings that must be found. */
const FAMILY_SAMPLES: Record<string, string[]> = {
  'ICMS': ['ICMS'], 'IPVA': ['IPVA'], 'ITCMD': ['ITCMD'], 'ITCD': ['ITCD'], 'IBS': ['IBS'], 'CBS': ['CBS'],
  'IPI': ['IPI'], 'RICMS': ['RICMS'], 'CONFAZ': ['CONFAZ'], 'SIMPLES NACIONAL': ['Simples Nacional'],
  'SUBSTITUICAO TRIBUTARIA': ['substituição tributária'], 'DIFAL': ['DIFAL'],
  'TRIBUTAR\\w*': ['tributar', 'tributária', 'tributárias', 'tributário', 'tributários', 'tributaria'],
  'TRIBUTO\\w*': ['tributo', 'tributos'],
  'TRIBUTAC\\w*': ['tributação', 'tributações', 'tributacao'],
  'IMPOSTOS?': ['imposto', 'impostos'],
  'NOTAS? FISCA\\w*': ['nota fiscal', 'notas fiscais'],
  'NF-?E': ['NF-e', 'NFe'], 'NFC-?E': ['NFC-e', 'NFCe'], 'CT-?E': ['CT-e', 'CTe'], 'MDF-?E': ['MDF-e', 'MDFe'],
  'EFD': ['EFD'], 'SPED': ['SPED'],
  'DOCUMENTOS? FISCA\\w*': ['documento fiscal', 'documentos fiscais'],
  'OBRIGAC\\w* ACESSORIA\\w*': ['obrigação acessória', 'obrigações acessórias'],
  'BENEFICIOS? FISCA\\w*': ['benefício fiscal', 'benefícios fiscais'],
  'INCENTIVOS? FISCA\\w*': ['incentivo fiscal', 'incentivos fiscais'],
  'CREDITOS? (?:PRESUMIDO|OUTORGADO|ACUMULADO)\\w*': [
    'crédito presumido', 'créditos presumidos', 'crédito outorgado', 'créditos outorgados', 'crédito acumulado', 'créditos acumulados',
  ],
  'DIVIDA ATIVA': ['dívida ativa'], 'REFORMA TRIBUTARIA': ['reforma tributária'],
  'CONTRIBUINTES? DO ICMS': ['contribuinte do ICMS', 'contribuintes do ICMS'],
  'CADASTRO DE CONTRIBUINTES': ['cadastro de contribuintes'],
  'SUBSECRETARIA DA RECEITA ESTADUAL': ['Subsecretaria da Receita Estadual'],
};

/** Legacy administration vocabulary (pre-2023). */
const LEGACY_SAMPLES = [
  'ICM', 'Portaria CAT', 'Portarias CAT', 'Coordenação da Administração Tributária', 'Tribunal de Impostos e Taxas',
  'taxa estadual', 'taxas estaduais', 'taxa judiciária', 'taxas judiciárias', 'taxa de fiscalização',
  'taxas de fiscalização', 'taxa de polícia', 'taxas de polícia',
];

const queryKey = (value: string) => asciiUpper(value).replace(/-/g, '');

test('rules (B1): discovery is a superset of the local filter; every family of DOE_SP_TAX_TERMS is reachable by a query', () => {
  const families = alternatives(DOE_SP_TAX_TERMS);
  // A family added to the current connector must get samples (and query terms) here.
  assert.deepEqual(Object.keys(FAMILY_SAMPLES).sort(), [...families].sort());
  const queried = new Set(DOE_SP_LEGACY_SEARCH_TERMS.map(queryKey));
  const reachable = (sample: string) => {
    const terms = doeSpLegacyTaxTerms(sample, RECENT);
    assert.ok(terms.length > 0, `"${sample}" must be kept locally`);
    for (const term of terms) assert.ok(queried.has(queryKey(term)), `"${term}" (from "${sample}") must be a query`);
  };
  for (const [family, samples] of Object.entries(FAMILY_SAMPLES)) {
    const pattern = new RegExp(`^(?:${family})$`);
    for (const sample of samples) {
      assert.ok(pattern.test(asciiUpper(sample)), `sample "${sample}" belongs to ${family}`);
      reachable(sample);
    }
  }
  for (const sample of LEGACY_SAMPLES) reachable(sample);
  // By construction: every vocabulary term is kept as itself and queried in every spelling variant.
  for (const term of DOE_SP_LEGACY_TAX_VOCABULARY) {
    assert.deepEqual(doeSpLegacyTaxTerms(term, RECENT).map(queryKey), [queryKey(term)]);
    assert.ok(DOE_SP_LEGACY_SEARCH_TERMS.includes(term));
    assert.ok(DOE_SP_LEGACY_SEARCH_TERMS.includes(term.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  }
  assert.ok(DOE_SP_LEGACY_SEARCH_TERMS.includes('NFCe') && DOE_SP_LEGACY_SEARCH_TERMS.includes('obrigacoes acessorias'));
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

test('periods: one browse date over the whole range; one search month from 2003 when the browse cursor reaches it; ends at 30/06/2023', () => {
  const at = (cursor: string | null, searchCursor: string | null) => doeSpLegacyNextPeriod({ cursor, searchCursor, coverageTo: DOE_SP_LEGACY_END });
  assert.deepEqual(at('2002-12-31', '2003-01-01'), { mode: 'BROWSE', from: '2002-12-31', to: '2002-12-31', next: '2003-01-01' });
  assert.deepEqual(at('2003-01-01', '2003-01-01'), { mode: 'SEARCH', from: '2003-01-01', to: '2003-01-31', next: '2003-02-01' });
  assert.deepEqual(at('2003-01-01', '2003-02-01'), { mode: 'BROWSE', from: '2003-01-01', to: '2003-01-01', next: '2003-01-02' });
  assert.deepEqual(at('2023-06-30', null), { mode: 'BROWSE', from: '2023-06-30', to: '2023-06-30', next: null });
  assert.deepEqual(at(null, '2023-06-01'), { mode: 'SEARCH', from: '2023-06-01', to: '2023-06-30', next: null });
  assert.equal(at(null, null), null);
  // The search starts at 2003 or at a later coverage start (inside its month).
  assert.equal(doeSpLegacySearchStart('1988-01-01'), '2003-01-01');
  assert.equal(doeSpLegacySearchStart('2010-05-17'), '2010-05-17');
  assert.deepEqual(at('2010-05-17', '2010-05-17'), { mode: 'SEARCH', from: '2010-05-17', to: '2010-05-31', next: '2010-06-01' });
  assert.deepEqual(DOE_SP_LEGACY_SEARCH_CADERNOS.map((c) => c.name), ['Executivo III']);
  assert.deepEqual(DOE_SP_LEGACY_BROWSE_CADERNOS, ['Executivo I', 'Executivo II']);
  assert.equal(DOE_SP_LEGACY_STATE_VERSION, 2);
});

test('limits: politeness defaults and validation', () => {
  assert.deepEqual(resolveDoeSpLegacySourceLimits({}), { minRequestIntervalMs: 1000, maxDownloadBytesPerRun: 200 * 1024 * 1024, maxPeriodsPerRun: 0 });
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
  assert.deepEqual(result.completion, { complete: false, reason: 'TIME_BUDGET_REACHED', pending: { pendingPages: 0, cursorDate: 19950907, searchCursorDate: 20030101 } });

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

test('search (Executivo III, from 2003): one query per term, hits merged by page, off-period hits and news pages ignored', async () => {
  const icms = exPage('Executivo III', '2015-03-04', 10, ['PORTARIA CAT 30 — ICMS substituição tributária']);
  const ipva = exPage('Executivo III', '2015-03-05', 11, ['Resolução SFP — IPVA 2015']);
  const outside = exPage('Executivo III', '2015-04-01', 12, ['ICMS']);
  const news = { ...icms, pagina: '1', link: '/2015/executivo secao iii/marco/04/pagnot_0001_N.pdf' };
  const exIII = exPage('Executivo III', '2015-03-06', 3, ['Crédito acumulado de ICMS']);
  const exII = exPage('Executivo II', '2015-03-06', 4, ['ICMS']); // browsed, never searched
  const { api, instance } = connector({
    search: {
      'ICMS|Executivo III': [icms, outside, news, exIII],
      'IPVA|Executivo III': [ipva, icms],
      'tributária|Executivo III': [icms],
      'ICMS|Executivo II': [exII],
    },
  }, stateAt('2015-03-01'));
  const result = await instance.collect(context());

  assert.deepEqual(result.publications.map((p) => p.externalId).sort(), [icms.link, ipva.link, exIII.link].sort());
  assert.ok(result.publications.every((p) => p.metadata?.discovery === 'KEYWORD_SEARCH'));
  // Merged: the ICMS page returned by three terms is downloaded once; news and off-period never.
  assert.equal(api.requests.filter((r) => r.includes('GatewayPDF') && r.includes('pag_0010')).length, 1);
  assert.ok(!api.requests.some((r) => r.includes('GatewayPDF') && (r.includes('pagnot_') || r.includes('pag_0012'))));
  // Executivo I and II are never sent to the index: they are browsed.
  const listed = api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3.aspx?'));
  assert.equal(listed.length, DOE_SP_LEGACY_SEARCH_TERMS.length);
  assert.ok(listed.every((r) => new URL('https://x' + r.slice(4)).searchParams.get('filtrocadernos') === 'Executivo III'));
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.searchCursor, '2015-04-01');
  assert.equal(state.cursor, '2015-03-01');
  assert.equal(state.totals.newsPagesSkipped, 1);
});

test('browse (from 2003, DOE-SP-LEGACY-09): Executivo I is read whole, so a page the index would miss is kept', async () => {
  const date = '2012-06-13';
  const ipi = page(date, 302, ['Lei complementar — IPI']);
  const other = page(date, 303, ['Nomeações']);
  const oldCte = page('2005-03-02', 34, ['Cte. Geral da Polícia Militar']);
  const { api, instance } = connector({
    cadernos: { [date]: EX1, '2005-03-02': EX1 },
    editions: { [`${date}|Executivo I`]: [ipi, other], '2005-03-02|Executivo I': [oldCte] },
    search: {}, // the index answers nothing for this day
  }, stateAt(date, '2012-07-01'));
  const result = await instance.collect(context());
  assert.deepEqual(result.publications.map((p) => p.externalId), [ipi.link]);
  assert.equal(result.publications[0]!.metadata?.discovery, 'EDITION_BROWSE');
  assert.ok(!api.requests.some((r) => /filtropalavraschave=(?!%20|\+|&|$)/.test(r)), 'no keyword query');
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.cursor, '2012-06-14');
  assert.equal(state.searchCursor, '2012-07-01');

  // P1 false positive: "Cte." on a 2005 page alone no longer keeps it.
  const old = await connector({ cadernos: { '2005-03-02': EX1 }, editions: { '2005-03-02|Executivo I': [oldCte] } }, stateAt('2005-03-02', '2005-04-01')).instance.collect(context());
  assert.deepEqual(old.publications, []);
  assert.equal(parseDoeSpLegacySourceState(old.checkpoint!.state).totals.pagesWithoutTaxTerms, 1);
});

test('browse (DOE-SP-LEGACY-11): Executivo I and II of the date are listed whole; Executivo II is covered before 2003 too', async () => {
  const date = '1995-09-06';
  const exI = [page(date, 1, ['Nomeações'])];
  const exII = Array.from({ length: 16 }, (_, i) => exPage('Executivo II', date, i + 1, [i === 9 ? 'Coordenação da Administração Tributária — remoção' : 'Atos de pessoal']));
  const { api, instance } = connector({
    cadernos: { [date]: [...EX1_EX2, { id: 'ex3', name: 'Executivo III' }] },
    editions: { [`${date}|Executivo I`]: exI, [`${date}|Executivo II`]: exII, [`${date}|Executivo III`]: [exPage('Executivo III', date, 1, ['ICMS'])] },
  }, stateAt(date));
  const result = await instance.collect(context());
  assert.deepEqual(result.publications.map((p) => p.externalId), [exII[9]!.link]);
  assert.equal(result.publications[0]!.title, 'Diário Oficial do Estado de São Paulo — Executivo II — 06/09/1995 — página 10');
  assert.equal(result.publications[0]!.metadata?.discovery, 'EDITION_BROWSE');
  // Ex I (1 screen) + Ex II (2 screens); Executivo III is not browsed; every page of I and II read once.
  const screens = api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3.aspx?')).map((r) => new URL('https://x' + r.slice(4)).searchParams.get('filtrocadernos'));
  assert.deepEqual(screens, ['Executivo I', 'Executivo II', 'Executivo II']);
  assert.equal(api.requests.filter((r) => r.includes('GatewayPDF')).length, 17);
  assert.equal(parseDoeSpLegacySourceState(result.checkpoint!.state).totals.pagesWithoutTaxTerms, 16);

  // Only Executivo II that day: still browsed.
  const only = await connector({ cadernos: { [date]: [{ id: 'ex2', name: 'Executivo II' }] }, editions: { [`${date}|Executivo II`]: exII } }, stateAt(date)).instance.collect(context());
  assert.deepEqual(only.publications.map((p) => p.externalId), [exII[9]!.link]);
});

test('browse (B3): the time budget between the two cadernos of a date resumes on the second one', async () => {
  const date = '1996-04-04';
  const exI = [page(date, 1, ['ICMS'])];
  const exII = [exPage('Executivo II', date, 1, ['Dívida ativa'])];
  let clock = 0;
  const portal: LegacyPortalOptions = {
    cadernos: { [date]: EX1_EX2 },
    editions: { [`${date}|Executivo I`]: exI, [`${date}|Executivo II`]: exII },
    onRequest: (url) => { clock += url.pathname.includes('BuscaDO2001Resultado_11_3') ? 50_000 : 1_000; },
  };
  // Soft deadline after 40 s: GetCadernos (1 s) + Ex I screen (50 s) passes it, so the run yields before Ex II.
  const first = await connector(portal, stateAt(date)).instance.collect(context(createTimeBudget(clock, 100_000, 60_000, () => clock)));
  const state = parseDoeSpLegacySourceState(first.checkpoint!.state);
  assert.equal(first.completion?.reason, 'TIME_BUDGET_REACHED');
  assert.deepEqual(state.listing?.browseCadernos?.map((c) => c.name), ['Executivo I', 'Executivo II']);
  assert.equal(state.listing?.query, 1);
  assert.equal(state.cursor, date);

  const { api, instance } = connector(portal, state);
  const second = await instance.collect(context());
  // Resumed on Executivo II without looking the cadernos up or listing Executivo I again.
  assert.equal(api.requests.filter((r) => r.includes('GetCadernos')).length, 0);
  assert.deepEqual(api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3.aspx?')).map((r) => new URL('https://x' + r.slice(4)).searchParams.get('filtrocadernos')), ['Executivo II']);
  assert.deepEqual(second.publications.map((p) => p.externalId).sort(), [exI[0]!.link, exII[0]!.link].sort());
});

test('browse and search advance together: the search month runs when the browse cursor reaches it', async () => {
  const { instance } = connector({ cadernos: {}, search: {} }, stateAt('2010-03-30', '2010-04-01'), { maxPeriodsPerRun: 4 });
  const result = await instance.collect(context());
  const periods = (result.metadata?.doeSpLegacy as { periods: Array<{ mode: string; from: string }> }).periods;
  assert.deepEqual(periods.map((p) => `${p.mode} ${p.from}`), ['BROWSE 2010-03-30', 'BROWSE 2010-03-31', 'SEARCH 2010-04-01', 'BROWSE 2010-04-01']);
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.deepEqual([state.cursor, state.searchCursor], ['2010-04-02', '2010-05-01']);
  assert.deepEqual(result.completion?.pending, { pendingPages: 0, cursorDate: 20100402, searchCursorDate: 20100501 });
});

test('the last period of the archive closes it: both cursors null and a complete run', async () => {
  const { instance } = connector({ search: {} }, stateAt('2023-06-30', '2023-06-01'), { maxPeriodsPerRun: 0 });
  const result = await instance.collect(context());
  const state = parseDoeSpLegacySourceState(result.checkpoint!.state);
  assert.equal(state.cursor, null);
  assert.equal(state.searchCursor, null);
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

  const { api, instance } = connector(portal, state);
  const second = await instance.collect(context());
  assert.deepEqual(second.publications.map((p) => p.metadata?.pagina), ['2', '3']);
  // The pending pages are read without listing 03/03 again; then the next date is listed.
  assert.equal(api.requests.filter((r) => r.includes('GetCadernos')).length, 1);
  assert.equal(api.requests.filter((r) => r.includes('BuscaDO2001Resultado')).length, 0);
  assert.deepEqual((second.metadata?.doeSpLegacy as { periods: Array<{ from: string }> }).periods.map((p) => p.from), ['1999-03-04']);
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

// ---------------------------------------------------------------- listing (B2/B3)

/** 17 ICMS hits in Executivo III (two result screens). */
function icmsMonth(): LegacyPage[] {
  return Array.from({ length: 17 }, (_, i) => exPage('Executivo III', '2015-03-02', 20 + i, [`Portaria CAT ${i} — ICMS`]));
}

test('listing (B2): a malformed item on screen 2 blocks the period; the next run resumes on that screen and loses nothing', async () => {
  const hits = icmsMonth();
  let faulty = true;
  const portal: LegacyPortalOptions = {
    search: { 'ICMS|Executivo III': hits },
    screenFault: ({ keyword, caderno, screen }) => faulty && keyword === 'ICMS' && caderno === 'Executivo III' && screen === 2 ? 'MALFORMED_ONE' : undefined,
  };
  const first = await connector(portal, stateAt('2015-03-01')).instance.collect(context());
  assert.deepEqual(first.publications, []);
  assert.equal(first.partialFailures?.[0]?.code, 'DOE_SP_LEGACY_MALFORMED_RESULT_ITEM');
  assert.equal(first.completion?.reason, 'PARTIAL_FAILURE_RETRY_REQUIRED');
  let state = parseDoeSpLegacySourceState(first.checkpoint!.state);
  assert.equal(state.searchCursor, '2015-03-01');
  assert.deepEqual({ query: state.listing?.query, screen: state.listing?.screen, found: state.listing?.found.length, attempts: state.listing?.attempts },
    { query: 0, screen: 2, found: 15, attempts: 1 });

  faulty = false;
  const { api, instance } = connector(portal, state);
  const second = await instance.collect(context());
  // Resumed on screen 2 of the ICMS query: screen 1 is not listed again.
  const firstList = api.requests.find((r) => r.includes('BuscaDO2001Resultado_11_3'))!;
  assert.equal(new URL('https://x' + firstList.slice(4)).searchParams.get('xhitlist_vpc'), '2');
  assert.equal(second.partialFailures, undefined);
  assert.deepEqual(second.publications.map((p) => p.externalId).sort(), hits.map((h) => h.link).sort());
  state = parseDoeSpLegacySourceState(second.checkpoint!.state);
  assert.equal(state.searchCursor, '2015-04-01');
  assert.equal(state.listing, null);
});

test('listing (B2): an all-malformed or empty screen never advances the cursor; repeated failures are reported as blocked', async () => {
  const date = '1994-04-04';
  const pages = [page(date, 1, ['ICMS'])];
  const portal: LegacyPortalOptions = {
    cadernos: { [date]: EX1 },
    editions: { [`${date}|Executivo I`]: pages },
    screenFault: () => 'ALL_MALFORMED',
  };
  let state = stateAt(date);
  for (let attempt = 1; attempt <= DOE_SP_LEGACY_LISTING_BLOCKED_AFTER + 1; attempt += 1) {
    const run = await connector(portal, state).instance.collect(context());
    state = parseDoeSpLegacySourceState(run.checkpoint!.state);
    assert.equal(state.cursor, date);
    assert.equal(run.completion?.reason, 'PARTIAL_FAILURE_RETRY_REQUIRED');
    assert.equal(run.partialFailures?.[0]?.code,
      attempt >= DOE_SP_LEGACY_LISTING_BLOCKED_AFTER ? 'DOE_SP_LEGACY_LISTING_BLOCKED' : 'DOE_SP_LEGACY_MALFORMED_RESULT_ITEM');
    assert.equal(state.listing?.attempts, attempt);
  }

  const hits = icmsMonth();
  for (const fault of ['EMPTY', 'NEGATIVE'] as const) {
    const run = await connector({
      search: { 'ICMS|Executivo III': hits },
      screenFault: ({ keyword, screen }) => keyword === 'ICMS' && screen === 2 ? fault : undefined,
    }, stateAt('2015-03-01')).instance.collect(context());
    const after = parseDoeSpLegacySourceState(run.checkpoint!.state);
    assert.equal(run.partialFailures?.[0]?.code, fault === 'EMPTY' ? 'DOE_SP_LEGACY_EMPTY_RESULT_SCREEN' : 'DOE_SP_LEGACY_RESULT_SCREEN_MISSING');
    assert.equal(after.searchCursor, '2015-03-01');
    assert.equal(after.listing?.screen, 2);
    assert.deepEqual(after.pending, []);
  }
});

test('listing (B3): the time budget stops a SEARCH month between queries; runs resume without listing any screen twice', async () => {
  const hits = icmsMonth();
  const ipva = exPage('Executivo III', '2015-03-20', 5, ['Resolução — IPVA']);
  let clock = 0;
  const portal: LegacyPortalOptions = {
    search: { 'ICMS|Executivo III': hits, 'IPVA|Executivo III': [ipva] },
    onRequest: () => { clock += 1_000; },
  };
  const queries = DOE_SP_LEGACY_SEARCH_CADERNOS.length * DOE_SP_LEGACY_SEARCH_TERMS.length;
  let state = stateAt('2015-03-01');
  const listed: string[] = [];
  const kept: string[] = [];
  let runs = 0;
  // Until the month is listed and its pages are read (a run may yield while reading them).
  while (state.searchCursor === '2015-03-01' || state.pending.length) {
    runs += 1;
    assert.ok(runs < 50, 'no progress');
    // Real executor budget: 100 s hard timeout, soft deadline after 60 s (60 requests at 1 req/s).
    const budget = createTimeBudget(clock, 100_000, 40_000, () => clock);
    const { api, instance } = connector(portal, state);
    const run = await instance.collect(context(budget));
    listed.push(...api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3')));
    kept.push(...run.publications.map((p) => p.externalId!));
    state = parseDoeSpLegacySourceState(run.checkpoint!.state);
    if (state.searchCursor === '2015-03-01') {
      assert.equal(run.completion?.reason, 'TIME_BUDGET_REACHED');
      assert.ok(state.listing && state.listing.query > 0 && state.listing.query < queries);
      assert.ok(api.requests.length <= 61);
    }
  }
  assert.ok(runs >= 3, `runs=${runs}`); // the month spans several runs
  // Every query listed once, plus screen 2 of the ICMS query; the negative redirects are followed, not re-listed.
  const screens = listed.filter((r) => !r.includes('ResultadoNegativo'));
  assert.equal(new Set(screens).size, screens.length);
  assert.equal(screens.length, queries + 1);
  assert.deepEqual([...new Set(kept)].sort(), [...hits.map((h) => h.link), ipva.link].sort());
});

test('needsOcr full (gate): the scanned page stays pending instead of being dropped', async () => {
  const date = '1990-05-05';
  const scan = page(date, 1, 'scan');
  const full = Array.from({ length: MAX_NEEDS_OCR_KEPT }, (_, i) => ({
    link: `/1989/x/pag_${i}.pdf`, pagina: '1', date: '1989-01-02', caderno: 'Executivo I', paginaOrdenacao: String(i),
  }));
  const state: DoeSpLegacySourceState = {
    ...stateAt('1990-05-06'),
    needsOcr: full,
    pending: [{ link: scan.link, pagina: '1', date, caderno: 'Executivo I', paginaOrdenacao: '100001', discovery: 'EDITION_BROWSE' }],
  };
  const { instance } = connector({ editions: { [`${date}|Executivo I`]: [scan] } }, state);
  const run = await instance.collect(context());
  const after = parseDoeSpLegacySourceState(run.checkpoint!.state);
  assert.deepEqual(after.pending.map((p) => p.link), [scan.link]);
  assert.equal(after.needsOcr.length, MAX_NEEDS_OCR_KEPT);
  assert.equal(after.totals.pagesRead, 0);
  assert.equal(after.cursor, '1990-05-06');
  assert.equal(run.partialFailures?.[0]?.code, 'DOE_SP_LEGACY_NEEDS_OCR_FULL');
  assert.equal(run.completion?.reason, 'PARTIAL_FAILURE_RETRY_REQUIRED');
});

test('state: a listing in progress round-trips; an invalid one is dropped', () => {
  const listing = {
    mode: 'SEARCH', from: '2015-03-01', to: '2015-03-31', next: '2015-04-01', vocabularyVersion: 2,
    query: 7, screen: 3, screens: 4, attempts: 1,
    found: [{ link: '/2015/a/b.pdf', pagina: '2', date: '2015-03-02', caderno: 'Executivo I', paginaOrdenacao: '100002', discovery: 'KEYWORD_SEARCH' }],
  };
  const parsed = parseDoeSpLegacySourceState({ cursor: '2015-03-01', listing });
  assert.deepEqual(parsed.listing, listing);
  const cadernos = [{ id: 'ex1', name: 'Executivo I' }, { id: 'ex2', name: 'Executivo II' }];
  const browse = parseDoeSpLegacySourceState({ cursor: '1990-01-01', listing: { ...listing, mode: 'BROWSE', browseCadernos: cadernos } }).listing;
  assert.deepEqual(browse?.browseCadernos, cadernos);
  assert.deepEqual(parseDoeSpLegacySourceState({ cursor: '1990-01-01', listing: { ...listing, mode: 'BROWSE', browseCadernos: [] } }).listing?.browseCadernos, []);
  // A browse listing with an unreadable caderno is dropped (the date is listed again).
  assert.equal(parseDoeSpLegacySourceState({ cursor: '1990-01-01', listing: { ...listing, mode: 'BROWSE', browseCadernos: [{ id: 'ex1' }] } }).listing, null);
  assert.equal(parseDoeSpLegacySourceState({ cursor: '2015-03-01', listing: { ...listing, from: 'x' } }).listing, null);
  assert.equal(parseDoeSpLegacySourceState({ cursor: '2015-03-01', listing: { ...listing, screen: 0 } }).listing, null);
  // searchCursor: kept, null = done, missing/invalid = start of the search for the coverage.
  assert.equal(parseDoeSpLegacySourceState({ cursor: '2015-03-01', searchCursor: '2015-04-01' }).searchCursor, '2015-04-01');
  assert.equal(parseDoeSpLegacySourceState({ cursor: null, searchCursor: null }).searchCursor, null);
  assert.equal(parseDoeSpLegacySourceState({ cursor: '1990-01-01' }).searchCursor, '2003-01-01');
  assert.equal(parseDoeSpLegacySourceState({ coverageFrom: '2010-05-17', cursor: '2010-05-17', searchCursor: 'x' }).searchCursor, '2010-05-17');
});

// ---------------------------------------------------------------- pilot

test('limits: DOE_SP_LEGACY_MAX_PERIODS_PER_RUN bounds a pilot run (default unlimited)', () => {
  assert.equal(resolveDoeSpLegacySourceLimits({}).maxPeriodsPerRun, 0);
  assert.equal(resolveDoeSpLegacySourceLimits({ DOE_SP_LEGACY_MAX_PERIODS_PER_RUN: '3' }).maxPeriodsPerRun, 3);
  assert.throws(() => resolveDoeSpLegacySourceLimits({ DOE_SP_LEGACY_MAX_PERIODS_PER_RUN: '-1' }), RangeError);
});

test('pilot: classifies every page of a browse day and reports kept pages the keyword search misses', async () => {
  const old = '1995-09-06';
  const oldPages = [
    page(old, 1, ['DECRETO N. 40.000', 'Regulamento do ICMS']),
    page(old, 2, ['Nomeações de servidores']),
    page(old, 3, 'scan'),
  ];
  const recent = '2010-03-03';
  const kept = page(recent, 1, ['Portaria CAT 10 — ICMS']);
  const keptOnlyByNfce = page(recent, 2, ['Emissão de NFC-e pelos contribuintes']);
  const other = page(recent, 3, ['Concurso público: taxa de inscrição']);
  const news = page(recent, 4, ['Notícia do ICMS'], { link: '/2010/executivo secao i/marco/03/pagnot_0004_N.pdf' });
  const api = legacyPortal({
    cadernos: { [old]: EX1, [recent]: EX1 },
    editions: { [`${old}|Executivo I`]: oldPages, [`${recent}|Executivo I`]: [kept, keptOnlyByNfce, other, news] },
    // The index answers ICMS but (in this fixture) not NFC-e: the pilot must flag the miss.
    search: { 'ICMS|Executivo I': [kept, page('2010-03-04', 9, ['ICMS'])] },
  });
  const seen: string[] = [];
  const report = await runDoeSpLegacyPilot({
    browseDates: [old],
    compareDates: [recent],
    fetch: api.fetch,
    client: { timeoutMs: 5_000 },
    onPage: (p) => seen.push(p.outcome),
  });

  const [browse, compare] = report.days;
  assert.deepEqual(browse!.counts, { KEPT: 1, NO_TAX_TERMS: 1, NEEDS_OCR: 1, NEWS: 0, ERROR: 0 });
  assert.equal(browse!.pages[0]!.viewerUrl, doeSpLegacyViewerUrl({ ...oldPages[0]!, paginaOrdenacao: '100001' }));
  assert.deepEqual(browse!.pages[0]!.matchedTaxTerms, ['ICMS']);
  assert.equal(compare!.counts.KEPT, 2);
  assert.equal(compare!.counts.NEWS, 1);
  assert.deepEqual(compare!.search, {
    queries: DOE_SP_LEGACY_SEARCH_TERMS.length,
    hits: 1, // the off-day hit is ignored
    keptFoundBySearch: 1,
    missedBySearch: [keptOnlyByNfce.link],
  });
  assert.equal(report.totals.missedBySearch, 1);
  assert.equal(seen.length, 7);
  // Nothing is downloaded for news pages; no page text in the report.
  assert.ok(!api.requests.some((r) => r.includes('GatewayPDF') && r.includes('pagnot_')));
  assert.ok(!JSON.stringify(report).includes('contribuintes'));
});

test('pilot: --cadernos measures Executivo II/III (browse and compare in the same caderno); unknown ids are refused', async () => {
  const date = '2012-06-13';
  const exII = [exPage('Executivo II', date, 1, ['Nomeação de servidor']), exPage('Executivo II', date, 2, ['Dívida ativa — inscrição'])];
  const exIII = [exPage('Executivo III', date, 1, ['Edital — ICMS'])];
  const api = legacyPortal({
    cadernos: { [date]: [...EX1_EX2, { id: 'ex3', name: 'Executivo III' }] },
    editions: { [`${date}|Executivo II`]: exII, [`${date}|Executivo III`]: exIII, [`${date}|Executivo I`]: [page(date, 1, ['ICMS'])] },
    search: { 'ICMS|Executivo III': exIII, 'ICMS|Executivo I': [page(date, 1, ['ICMS'])] },
  });
  const report = await runDoeSpLegacyPilot({ browseDates: [], compareDates: [date], cadernos: ['ex2', 'ex3'], fetch: api.fetch, client: { timeoutMs: 5_000 } });
  assert.deepEqual(report.days.map((d) => [d.caderno, d.counts.KEPT, d.search?.missedBySearch.length]), [['Executivo II', 1, 1], ['Executivo III', 1, 0]]);
  assert.equal(report.days[0]!.search?.missedBySearch[0], exII[1]!.link);
  // Executivo I is not touched; every keyword query goes to the caderno being measured.
  const pdfs = api.requests.filter((r) => r.includes('GatewayPDF'));
  assert.equal(pdfs.length, 3);
  assert.ok(!pdfs.some((r) => r.includes('caderno=Executivo%20I&')));
  const queried = api.requests.filter((r) => r.includes('BuscaDO2001Resultado_11_3.aspx?')).map((r) => new URL('https://x' + r.slice(4)).searchParams.get('filtrocadernos'));
  assert.deepEqual([...new Set(queried)].sort(), ['Executivo II', 'Executivo III']);
  await assert.rejects(() => runDoeSpLegacyPilot({ browseDates: [date], compareDates: [], cadernos: ['ex4'] }), RangeError);
  await assert.rejects(() => runDoeSpLegacyPilot({ browseDates: [date], compareDates: [], cadernos: ['ex2', 'ex2'] }), RangeError);
});

test('pilot: compare dates must be in the keyword-index era', async () => {
  await assert.rejects(() => runDoeSpLegacyPilot({ browseDates: [], compareDates: ['2001-05-05'] }), RangeError);
});
