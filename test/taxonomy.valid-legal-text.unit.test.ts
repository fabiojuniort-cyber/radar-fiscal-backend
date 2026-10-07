import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentWordingText,
  sanitizeLegalPresentationHtml,
} from '../src/modules/collection/legal-presentation.js';
import {
  planCuratedClassification,
  type CuratedConceptInput,
} from '../src/modules/taxonomy/classification/classification.curated.js';
import {
  extractNcmCandidates,
  selectText,
} from '../src/modules/taxonomy/ncm/publication-ncm.detector.js';

function concept(label: string): CuratedConceptInput {
  return {
    releaseConceptId: 'rc-' + label.toLowerCase().replace(/\W+/g, '-'),
    code: 'test.' + label.toLowerCase().replace(/\W+/g, '-'),
    label,
    classifyByLabel: true,
    aliases: [],
    ncmPrefixes: [],
    cclasstribCodes: [],
  };
}

test('structured CONFAZ text keeps only the operative legal body', () => {
  const html = sanitizeLegalPresentationHtml(
    '<p class="TituloAcordo">CONVÊNIO ICMS 100/97</p>' +
      '<p class="DataPublicao">Alterado pelos Convênios ICMS 40/98 e 79/25. NCM 7612.90.19.</p>' +
      '<p class="Ementa">Reduz a base de cálculo do ICMS.</p>' +
      '<p class="TextoAcordo">Cláusula primeira Fica reduzida a base de cálculo do ICMS para fertilizantes. NCM 7312.00.00.</p>' +
      '<p class="A8-1Remissao">Nova redação dada pelo Convênio ICMS 99/04 para sementes.</p>' +
      '<p class="A5-1TextoAcordo">II - REVOGADO</p>' +
      '<p class="A8-2RemissaoAnt">Redação original, efeitos até 31.12.21.</p>' +
      '<p class="A8-3RedacaoAnt">Texto anterior sobre defensivos.</p>' +
      '<table>' +
        '<tr><td>8424.81.19</td><td>equipamento vigente</td></tr>' +
        '<tr><td class="A9-2Tabelajustificadoverde">8701.90.90</td><td>linha anterior</td></tr>' +
      '</table>',
  );

  assert.ok(html);
  const current = currentWordingText(html);
  assert.ok(current);
  assert.match(current, /ICMS para fertilizantes/);
  assert.match(current, /7312\.00\.00/);
  assert.match(current, /8424\.81\.19/);
  assert.doesNotMatch(current, /CONVÊNIO ICMS 100\/97/);
  assert.doesNotMatch(current, /Alterado pelos/);
  assert.doesNotMatch(current, /Reduz a base de cálculo do ICMS\.$/m);
  assert.doesNotMatch(current, /Nova redação dada/);
  assert.doesNotMatch(current, /REVOGADO/);
  assert.doesNotMatch(current, /Redação original/);
  assert.doesNotMatch(current, /defensivos/);
  assert.doesNotMatch(current, /7612\.90\.19/);
  assert.doesNotMatch(current, /8701\.90\.90/);
});

test('curated taxonomy never uses the publication title as evidence', () => {
  const titleOnly = planCuratedClassification({
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    taxonomyReleaseId: '00000000-0000-4000-8000-000000000002',
    title: 'Convênio sobre crédito presumido',
    contentText: 'Cláusula primeira. Esta norma disciplina operações internas.',
    ncmCodes: [],
    concepts: [concept('Crédito presumido')],
  });
  assert.equal(titleOnly.assertions.length, 0);

  const inLegalBody = planCuratedClassification({
    publicationVersionId: '00000000-0000-4000-8000-000000000001',
    taxonomyReleaseId: '00000000-0000-4000-8000-000000000002',
    title: 'Título sem evidência',
    contentText: 'Cláusula primeira. Fica concedido crédito presumido.',
    ncmCodes: [],
    concepts: [concept('Crédito presumido')],
  });
  assert.equal(inLegalBody.assertions.length, 1);
  assert.match(inLegalBody.assertions[0]!.excerpt, /crédito presumido/i);
});

test('NCM selection ignores header/history/previous wording and keeps current legal NCMs', () => {
  const presentationHtml = sanitizeLegalPresentationHtml(
    '<p class="TituloAcordo">CONVÊNIO ICMS 52/91 7612.90.19</p>' +
      '<p class="DataPublicao">Alterado pelo Convênio 100/97: 8701.90.90.</p>' +
      '<p class="TextoAcordo">Cláusula primeira. Mercadoria 7312.00.00.</p>' +
      '<p class="A8-1Remissao">Nova redação: 8424.81.19.</p>' +
      '<p class="RedaoAnt">Redação anterior: 8432.80.00.</p>',
  );

  const selected = selectText({
    publication_version_id: '00000000-0000-4000-8000-000000000001',
    content_text: 'fallback must not be used',
    relevant_excerpt: null,
    presentation_html: presentationHtml ?? null,
  });

  assert.equal(selected.currentWordingOnly, true);
  assert.deepEqual(
    extractNcmCandidates(selected.text).map((candidate) => candidate.code),
    ['73120000'],
  );
});
