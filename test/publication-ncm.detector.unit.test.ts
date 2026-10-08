import assert from 'node:assert/strict';
import test from 'node:test';

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

test('the sanitized CONFAZ presentation keeps the green previous-wording table styles', () => {
  const html = sanitizeLegalPresentationHtml(
    '<table><tr><td><p class="A7-2Tabelajustificado">Silos</p></td><td><p class="A9-2Tabelajustificadoverde">7612.90.19</p></td></tr></table>',
  );
  assert.ok(html?.includes('class="A9-2Tabelajustificadoverde"'));
  assert.ok(!html?.includes('A7-2Tabelajustificado"'));
  assert.equal(currentWordingText(html), '');
});
