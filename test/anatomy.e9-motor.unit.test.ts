import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareOfficialAct } from '../src/modules/anatomy/official-portal-preparation.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';

const typedPortal = (source: 'DOU' | 'CONFAZ' | 'PLANALTO', html: string, title: string) => {
  const officialAct = prepareOfficialAct(source, 'synthetic', html, title);
  assert.ok(officialAct);
  const result = analyzeAnatomy({ publicationVersionId: 'synthetic', referenceDate: '2026-11-19',
    ruleSet: { id: 'e9-test', version: '1' }, input: { source, representationId: 'synthetic', html, officialAct } });
  assert.ok(result.parts.every((part) => part.legalStatus === 'unknown'));
  assert.ok(result.sourceMap.every((row) => !row.pointer.sourceSpan
    || (row.pointer.sourceSpan.start >= officialAct.start && row.pointer.sourceSpan.end <= officialAct.end)));
  return result;
};

test('RFB requires a corroborated device and Roman sequence and preserves a struck block', () => {
  const html = '<section data-rfb-segment="1"><p>Art. 1º Vigência.</p></section>'
    + '<section data-rfb-segment="2" data-rfb-type="nao identificad"><p>I primeiro dispositivo;</p></section>'
    + '<section data-rfb-segment="3" data-rfb-type="nao identificad"><p>II segundo dispositivo.</p></section>'
    + '<section data-rfb-segment="4" data-rfb-type="nao identificad" data-rfb-tachado="true"><p>III riscado.</p></section>';
  const result = readAnatomyInput({ source: 'RFB', representationId: 'rfb:99', html });
  assert.equal(result.parts.filter((p) => p.type === 'inciso').length, 2);
  assert.ok(result.parts.some((p) => p.type === 'unidentified' && p.context === 'historical'));
});

test('DOU web reader excludes the outer portal and retains the act and annex offsets', () => {
  const title = 'PORTARIA Nº 20';
  const html = '<p>Navegação</p><article id="materia"><div class="texto-dou"><p class="identifica">' + title
    + '</p><p class="ementa">Exemplo.</p><p class="dou-paragraph">Art. 1º Vigência.</p>'
    + '<p class="anexo">ANEXO ÚNICO</p><table><tr><td>conteúdo</td></tr></table></div></article>';
  const r = typedPortal('DOU', html, title);
  assert.doesNotMatch(r.canonicalText, /Navegação/u);
  assert.ok(r.parts.some((p) => p.type === 'annex'));
  assert.equal(prepareOfficialAct('DOU', 'synthetic', html + html, title), null);
  assert.equal(prepareOfficialAct('DOU', 'synthetic', html, 'PORTARIA Nº 21'), null);
  const proof = prepareOfficialAct('DOU', 'synthetic', html, title)!;
  assert.throws(() => readAnatomyInput({ source: 'DOU', representationId: 'different', html, officialAct: proof }), /issued/u);
});

test('CONFAZ Plone identifies an ementa, a spaced title and a sole annex', () => {
  const title = 'CONVÊNIO ICMS 1/26';
  const html = '<main id="content-core"><div id="parent-fieldname-text"><p class="A1-1TituloAcordo">' + title
    + '</p><p class="A3Ementa">Ementa.</p><p class="A4AcordoTipo">C O N V Ê N I O</p><p>Cláusula primeira Teor.</p>'
    + '<p>ANEXO ÚNICO</p><table><tr><td>Conteúdo</td></tr></table></div></main>';
  const r = typedPortal('CONFAZ', html, title);
  assert.ok(r.parts.some((p) => p.type === 'summary' && p.context === 'prohibited'));
  assert.ok(r.parts.some((p) => p.ruleId.endsWith('confaz_plone_act_kind')));
  assert.ok(r.parts.some((p) => p.type === 'annex'));
});

test('Planalto uses a proved body and supports a separated or compact ordinal', () => {
  const title = 'LEI No 100, DE 1 DE JANEIRO DE 2026';
  const html = '<html><body><p>Casa Civil</p><p>' + title + '</p><p>Art. 1o Exemplo.</p></body></html>';
  assert.ok(typedPortal('PLANALTO', html, title).parts.some((p) => p.type === 'article'));
  assert.equal(prepareOfficialAct('PLANALTO', 'synthetic', html.replace('Casa Civil', 'Outro'), title), null);
  assert.throws(() => readAnatomyInput({ source: 'PLANALTO', representationId: 'synthetic', html }), /issued/u);
});

test('NORMAS-LEG refuses an unissued plan', () => {
  assert.throws(() => readAnatomyInput({ source: 'NORMAS-LEG', representationId: 'synthetic', html: '<p>Art. 1º.</p>' }), /requires/u);
});
