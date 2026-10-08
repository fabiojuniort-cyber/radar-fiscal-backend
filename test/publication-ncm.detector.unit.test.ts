import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { extractActBodyHtml } from '../src/modules/collection/confaz.connector.js';
import {
  currentWordingText,
  sanitizeLegalPresentationHtml,
} from '../src/modules/collection/legal-presentation.js';
import {
  extractNcmCandidates,
  selectText,
} from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

test('extractNcmCandidates normalizes formatted and plain NCMs and counts repeats', () => {
  const text = [
    'A tabela alcança o NCM 1006.30.11 para arroz branqueado.',
    'Também menciona 10062099 e repete 1006.30.11 em outra linha.',
    'O código 9999.99.99 tem formato plausível, mas será validado pelo catálogo.',
    'A sequência 123456789 não pode ser recortada como oito dígitos.',
  ].join(' ');

  const candidates = extractNcmCandidates(text);
  const byCode = new Map(candidates.map((candidate) => [candidate.code, candidate]));

  assert.equal(candidates.length, 3);
  assert.equal(byCode.get('10063011')?.occurrenceCount, 2);
  assert.equal(byCode.get('10062099')?.occurrenceCount, 1);
  assert.equal(byCode.get('99999999')?.occurrenceCount, 1);
  assert.ok(byCode.get('10063011')?.excerpt.includes('1006.30.11'));
  assert.equal(byCode.has('12345678'), false);
});

test('extractNcmCandidates ignores date-shaped and unrelated numeric text', () => {
  const text = [
    'Lei nº 14.133/2021, publicada em 01/10/2026, processo 12345.',
    'Datas ISO como 2026-10-01 também não são códigos NCM.',
    'Separações livres como 1006 30 11 não entram no detector conservador.',
  ].join(' ');
  assert.deepEqual(extractNcmCandidates(text), []);
});

test('extractNcmCandidates accepts the "8417.8020" typing of official annexes but not longer codes', () => {
  const codes = extractNcmCandidates(
    'Fornos para fusão de vidro 8417.8020. Ninhos metálicos 7326.90.9999. Motocultores 8701.10.',
  ).map((candidate) => candidate.code);
  assert.deepEqual(codes, ['84178020']);
});

test('selectText reads only the wording in force when the page marks previous wordings', () => {
  const presentation = [
    '<p class="TextoAcordo">Cláusula primeira Reduz a base de cálculo.</p>',
    '<table><tr><td><p>2.1</p></td><td><p class="A5-1TextoAcordo">Silos</p></td>',
    '<td><p class="A5-1TextoAcordo">3917.32.90</p><p>3925.10.00</p></td></tr>',
    '<tr><td colspan="3"><p class="A8-2RemissaoAnt">Redação original, efeitos até 31.05.2020.</p></td></tr>',
    '<tr><td><p class="A9-2Tabelajustificadoverde">2.1</p></td><td><p class="A9-2Tabelajustificadoverde">Silos</p></td>',
    '<td><p class="A9-2Tabelajustificadoverde">7612.90.19</p></td></tr></table>',
    '<p class="RedaoAnt">Redação anterior com 8701.90.00.</p>',
  ].join('');
  const row = {
    publication_version_id: 'v1',
    content_text: 'texto completo 3917.32.90 3925.10.00 7612.90.19 8701.90.00',
    relevant_excerpt: null,
    presentation_html: presentation,
  };
  const selected = selectText(row);
  assert.equal(selected.currentWordingOnly, true);
  assert.deepEqual(
    extractNcmCandidates(selected.text).map((candidate) => candidate.code),
    ['39173290', '39251000'],
  );
  // Without previous-wording marks the stored content text is kept.
  const plain = selectText({ ...row, presentation_html: '<p class="TextoAcordo">8701.90.00</p>' });
  assert.equal(plain.currentWordingOnly, false);
  assert.equal(plain.text, row.content_text);
});

test('selectText excludes CONFAZ title, ementa, history and editorial notes', () => {
  const presentation = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 100/97</p>',
    '<p class="Ementa">Reduz o ICMS de 7612.90.19.</p>',
    '<p class="DataPublicao">Alterado pelo Convênio ICMS 52/91 e menciona 8701.90.00.</p>',
    '<p class="Remisso">Nova redação pelo Convênio ICMS 79/25, NCM 3925.10.00.</p>',
    '<p class="TextoAcordo">Cláusula primeira: produto 3102.10.90.</p>',
    '<p class="RedaoAnt">Redação anterior: produto 1006.30.11.</p>',
  ].join('');
  const row = {
    publication_version_id: 'v1',
    content_text: 'CONVÊNIO ICMS 100/97 7612.90.19 8701.90.00 3925.10.00 3102.10.90 1006.30.11',
    relevant_excerpt: null,
    presentation_html: presentation,
  };

  const selected = selectText(row);
  assert.equal(selected.currentWordingOnly, true);
  assert.match(selected.text, /3102\.10\.90/);
  assert.doesNotMatch(selected.text, /7612\.90\.19|8701\.90\.00|3925\.10\.00|1006\.30\.11|CONVÊNIO ICMS 100\/97/);
  assert.deepEqual(
    extractNcmCandidates(selected.text).map((candidate) => candidate.code),
    ['31021090'],
  );
});

test('selectText does not fall back to full content when every marked block is non-normative', () => {
  const row = {
    publication_version_id: 'v1',
    content_text: 'histórico 8701.90.00',
    relevant_excerpt: null,
    presentation_html: '<p class="DataPublicao">Histórico 8701.90.00.</p>',
  };
  const selected = selectText(row);
  assert.equal(selected.currentWordingOnly, true);
  assert.equal(selected.text, '');
  assert.deepEqual(extractNcmCandidates(selected.text), []);
});

test('currentWordingText excludes editorial notes nested inside current table rows', () => {
  const html = [
    '<table><tr>',
    '<td><p class="A5-1TextoAcordo">Produto vigente 3102.10.90</p></td>',
    '<td><p class="A8-1Remissao">Alterado pelo Convênio 79/25; histórico 8701.90.00.</p></td>',
    '</tr></table>',
  ].join('');

  const current = currentWordingText(html) ?? '';
  assert.match(current, /3102\.10\.90/);
  assert.doesNotMatch(current, /8701\.90\.00|Alterado pelo Convênio/);
});

test('currentWordingText omits revoked placeholders but keeps operative revocation clauses', () => {
  const html = [
    '<p class="DataPublicao">Alterado pelo Convênio ICMS 26/21.</p>',
    '<p class="TextoAcordo">II - REVOGADO</p>',
    '<p class="TextoAcordo">Ficam revogadas as disposições em contrário.</p>',
    '<p class="TextoAcordo">Cláusula primeira: texto vigente.</p>',
  ].join('');

  const current = currentWordingText(html) ?? '';
  assert.doesNotMatch(current, /II - REVOGADO/);
  assert.match(current, /Ficam revogadas as disposições em contrário/);
  assert.match(current, /Cláusula primeira: texto vigente/);
});

test('currentWordingText mirrors the real CV100/97 and CV52/91 editorial classes', () => {
  const html = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 100/97</p>',
    '<p class="DataPublicao">Alterado pelos Convs. ICMS 26/21 e 79/25; NCM 8701.90.00.</p>',
    '<p class="A2DataPublicacao">Prorrogado até 31.12.27; NCM 3925.10.00.</p>',
    '<p class="Ementa">Reduz a base de cálculo do ICMS; NCM 7612.90.19.</p>',
    '<p class="A8-1Remissao">Nova redação dada pelo Conv. ICMS 99/04; NCM 1006.20.99.</p>',
    '<p class="A5-1TextoAcordo">I - fertilizantes, NCM 3102.10.90.</p>',
    '<p class="A8-2RemissaoAnt">Redação original, efeitos até 18.10.04.</p>',
    '<p class="A8-3RedacaoAnt">I - redação anterior, NCM 1006.30.11.</p>',
    '<table><tr><td><p class="TabelaSubtituloverde">39.1</p></td>',
    '<td><p class="Tabelajustificadoverde">Máquinas antigas</p></td>',
    '<td><p class="TabelaSubtituloverde">8450.11.00</p></td></tr></table>',
    '<p class="TextoAcordo">Cláusula terceira REVOGADA</p>',
    '<p class="TextoAcordo">Ficam revogadas as disposições em contrário; NCM 9999.99.99.</p>',
  ].join('');

  const current = currentWordingText(html) ?? '';
  assert.match(current, /3102\.10\.90/);
  assert.match(current, /9999\.99\.99/);
  assert.doesNotMatch(
    current,
    /CONVÊNIO ICMS 100\/97|8701\.90\.00|3925\.10\.00|7612\.90\.19|1006\.20\.99|1006\.30\.11|8450\.11\.00|Cláusula terceira REVOGADA/,
  );
  assert.deepEqual(
    extractNcmCandidates(current).map((candidate) => candidate.code),
    ['31021090', '99999999'],
  );
});

test('classification includes active annex rows and excludes completely revoked annexes', () => {
  const html = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 100/97</p>',
    '<p class="TextoAcordo">Cláusula primeira: sementes.</p>',
    '<p>ANEXO I</p>',
    '<table><tr><td>Fertilizantes vigentes</td><td>3102.10.90</td></tr></table>',
    '<p>ANEXO II - REVOGADO</p>',
    '<table><tr><td>Máquinas históricas</td><td>8701.90.00</td></tr></table>',
    '<p>ANEXO III</p>',
    '<table><tr><td>Grãos vigentes</td><td>1006.30.11</td></tr>',
    '<tr><td class="TabelaSubtituloverde">Antiga redação</td><td>8450.11.00</td></tr></table>',
  ].join('');
  const text = currentWordingText(html) ?? '';
  assert.match(text, /Fertilizantes vigentes|3102\.10\.90/);
  assert.match(text, /Grãos vigentes|1006\.30\.11/);
  assert.doesNotMatch(text, /ANEXO I|ANEXO II|ANEXO III|8701\.90\.00|8450\.11\.00|Máquinas históricas/);
  const selection = selectText({
    publication_version_id: 'annex-one',
    content_text: '8701.90.00 3102.10.90 1006.30.11 8450.11.00',
    relevant_excerpt: null,
    presentation_html: html,
  });
  assert.deepEqual(
    extractNcmCandidates(selection.text).map((candidate) => candidate.code),
    ['31021090', '10063011'],
  );
});

test('historical annex alone does not fall back to full legal text', () => {
  const html = '<p>ANEXO ÚNICO — Redação anterior</p><table><tr><td>8701.90.00</td></tr></table>';
  assert.equal(currentWordingText(html), '');
  const selected = selectText({
    publication_version_id: 'annex-old',
    content_text: 'ANEXO ÚNICO 8701.90.00',
    relevant_excerpt: null,
    presentation_html: html,
  });
  assert.equal(selected.text, '');
});

test('source-verified segment statuses preserve valid cells and suppress historical cells in a mixed annex', () => {
  const html = sanitizeLegalPresentationHtml([
    '<p class="TituloAcordo">LEI COMPLEMENTAR 214/2025</p>',
    '<p data-legal-status="editorial">Historico fiscal, NCM 8701.90.00.</p>',
    '<p data-legal-status="current">Art. 1º Aplica-se a fertilizantes 3102.10.90.</p>',
    '<p>ANEXO I</p>',
    '<table><tr>',
    '<td data-legal-status="previous">Produto antigo 1006.30.11</td>',
    '<td data-legal-status="current">Produto vigente 3925.10.00</td>',
    '</tr></table>',
    '<p data-legal-status="unverified">Vigência pendente: 7612.90.19.</p>',
  ].join(''))!;
  assert.match(html, /data-legal-status="previous"/);
  assert.match(html, /data-legal-status="current"/);
  const extracted = currentWordingText(html)!;
  assert.match(extracted, /3102\.10\.90|3925\.10\.00/);
  assert.doesNotMatch(extracted, /8701\.90\.00|1006\.30\.11|7612\.90\.19|LEI COMPLEMENTAR|ANEXO I/);
  assert.deepEqual(
    extractNcmCandidates(extracted).map((item) => item.code),
    ['31021090', '39251000'],
  );
});

test('an excluded source-verified annex heading suppresses following unstyled rows until the next annex', () => {
  const html = [
    '<p data-legal-status="previous">ANEXO II</p>',
    '<table><tr><td>Histórico 8701.90.00</td></tr></table>',
    '<p>ANEXO III</p>',
    '<table><tr><td>Operativo 3102.10.90</td></tr></table>',
  ].join('');
  const selected = currentWordingText(html)!;
  assert.match(selected, /Operativo 3102\.10\.90/);
  assert.doesNotMatch(selected, /Histórico 8701\.90\.00|ANEXO II|ANEXO III/);
});

test('unknown or uncertain legal status cannot become affirmative evidence', () => {
  const html = sanitizeLegalPresentationHtml(
    '<p data-legal-status="unverified">NCM 8701.90.00</p>' +
    '<p data-legal-status="current">Produtos vigentes 3102.10.90</p>',
  )!;
  const text = currentWordingText(html)!;
  assert.match(text, /3102\.10\.90/);
  assert.doesNotMatch(text, /8701\.90\.00/);
  assert.deepEqual(
    extractNcmCandidates(text).map((item) => item.code),
    ['31021090'],
  );
});

test('general legal headings and publication notes do not classify in structured HTML', () => {
  const html = [
    '<h1>LEI COMPLEMENTAR Nº 214, DE 16 DE JANEIRO DE 2025</h1>',
    '<p>Publicado no Diário Oficial em 17/01/2025, NCM 8701.90.00.</p>',
    '<p>Alterado pela Lei nº 99/2026; NCM 7612.90.19.</p>',
    '<p>Art. 1º Incide o IBS sobre sementes, NCM 3102.10.90.</p>',
    '<p>Redação anterior: aplica-se às máquinas 1006.30.11.</p>',
    '<p>ANEXO I</p>',
    '<table><tr><td>Produto atual</td><td>3925.10.00</td></tr></table>',
  ].join('');
  const selected = currentWordingText(html) ?? '';
  assert.match(selected, /Art\. 1º Incide o IBS/);
  assert.match(selected, /3102\.10\.90|3925\.10\.00/);
  assert.doesNotMatch(selected, /LEI COMPLEMENTAR|8701\.90\.00|7612\.90\.19|1006\.30\.11|ANEXO I/);
});

test('a revoked cell in a mixed annex row is not classification evidence', () => {
  const html = [
    '<p>ANEXO I</p>',
    '<table><tr>',
    '<td>II - REVOGADO</td>',
    '<td>Insumos agropecuários vigentes: NCM 3102.10.90.</td>',
    '</tr><tr>',
    '<td>Produto anterior</td><td data-legal-status="previous">8701.90.00</td>',
    '<td data-legal-status="current">Produto novo 3925.10.00.</td>',
    '</tr></table>',
  ].join('');
  const wording = currentWordingText(html) ?? '';
  assert.doesNotMatch(wording, /II - REVOGADO|8701\.90\.00|ANEXO I/);
  assert.match(wording, /Insumos agropecuários vigentes|3102\.10\.90|3925\.10\.00/);
  assert.deepEqual(
    extractNcmCandidates(wording).map(item => item.code),
    ['31021090', '39251000'],
  );
});

test('an unverified annex heading prevents classification of all following unmarked rows', () => {
  const html = [
    '<p>Art. 1º: sementes com NCM 3102.10.90.</p>',
    '<p data-legal-status="unverified">ANEXO II</p>',
    '<table><tr><td>Vigência não confirmada: 8701.90.00</td></tr></table>',
    '<p>ANEXO III</p>',
    '<table><tr><td>Produto da nova seção: 3925.10.00</td></tr></table>',
  ].join('');
  const text = currentWordingText(html) ?? '';
  assert.doesNotMatch(text, /8701\.90\.00|ANEXO II|ANEXO III/);
  assert.match(text, /3102\.10\.90|3925\.10\.00/);
  assert.deepEqual(extractNcmCandidates(text).map(row => row.code), ['31021090', '39251000']);
});

test('R2 B1 mixed CONFAZ historical paragraph cannot suppress current sibling NCM', () => {
  const html = [
    '<p class="TituloAcordo">CONVÊNIO ICMS 52/91</p>',
    '<table><tr>',
    '<td><p class="A9-2Tabelajustificadoverde">8450.11.00</p></td>',
    '<td data-legal-status="current">7307.19.20 — produto atual</td>',
    '</tr></table>',
  ].join('');
  const text = currentWordingText(html) ?? '';
  assert.match(text, /7307\\.19\\.20/);
  assert.doesNotMatch(text, /8450\\.11\\.00/);
  assert.deepEqual(extractNcmCandidates(text).map(item => item.code), ['73071920']);
});

test('R2 B3 revoked annex in TH excludes following rows until next TH annex', () => {
  const html = [
    '<table><tr><th data-legal-status="revoked">ANEXO II</th></tr>',
    '<tr><td>8450.11.00</td></tr>',
    '<tr><th>ANEXO III</th></tr><tr><td>7307.19.20</td></tr></table>',
  ].join('');
  const text = currentWordingText(html) ?? '';
  assert.match(text, /7307\\.19\\.20/);
  assert.doesNotMatch(text, /8450\\.11\\.00|ANEXO II|ANEXO III/);
});

test('R2 B2 NCM detector fails closed on missing, raw, oversized, or unmarked HTML', () => {
  const row = {publication_version_id: 'r2', content_text: 'historical 8450.11.00', relevant_excerpt: 'past 8701.90.00', presentation_html: null as string | null};
  for (const presentation_html of [null, '<p>8450.11.00</p>', '<p data-legal-status="invalid">8450.11.00</p>']) {
    const result = selectText({ ...row, presentation_html });
    assert.equal(result.text, '');
    assert.equal(result.sourceField, 'NONE');
    assert.deepEqual(extractNcmCandidates(result.text), []);
  }
  const excerptOnly = selectText({ ...row, content_text: null, presentation_html: null });
  assert.equal(excerptOnly.sourceField, 'NONE');
});

test('saved official Convênios 100/97 and 52/91 preserve current body and ignore historical annex NCM', () => {
  const conv100 = readFileSync('ops/confaz/acts/CV100_97.html', 'utf8');
  const conv52 = readFileSync('ops/confaz/acts/CV052_91.html', 'utf8');
  const legalText = (html: string) => {
    const extracted = extractActBodyHtml(html);
    assert.ok(extracted, 'saved CONFAZ act must have an extractable legal body');
    const sanitized = sanitizeLegalPresentationHtml(extracted);
    assert.ok(sanitized, 'saved CONFAZ body should survive sanitization');
    return currentWordingText(sanitized) ?? '';
  };
  const current100 = legalText(conv100);
  assert.match(current100, /calcário e gesso/);
  assert.doesNotMatch(current100, /CONVÊNIO ICMS 100\/97|Publicado no DOU de 06\.11\.97/);

  const current52 = legalText(conv52);
  assert.match(current52, /7307\.19\.20/, 'current industrial annex NCM must be preserved');
  assert.doesNotMatch(current52, /8450\.11\.00/, 'historical green annex row must not classify');
  assert.doesNotMatch(current52, /CONVÊNIO ICMS 52\/91|Publicação DOU de 30\.09\.91/);
});

test('the sanitized CONFAZ presentation keeps the green previous-wording table styles', () => {
  const html = sanitizeLegalPresentationHtml(
    '<table><tr><td><p class="A7-2Tabelajustificado">Silos</p></td><td><p class="A9-2Tabelajustificadoverde">7612.90.19</p></td></tr></table>',
  );
  assert.ok(html?.includes('class="A9-2Tabelajustificadoverde"'));
  assert.ok(!html?.includes('A7-2Tabelajustificado"'));
  assert.equal(currentWordingText(html), '');
});
