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

test('R4 DOU authentic classes preserve the signature and bare annex title', () => {
  const title = 'DECRETO Nº 100';
  const html = '<article id="materia"><div class="texto-dou"><p class="identifica">DECRETO Nº 100</p>'
    + '<p>Art. 1º Dispositivo.</p><p class="assinaPr">NOME DA AUTORIDADE</p>'
    + '<p class="anexo">ANEXO</p><table><tr><td>Dado</td></tr></table></div></article>';
  const result = typedPortal('DOU', html, title);
  assert.equal(result.status, 'complete');
  assert.ok(result.parts.some((p) => p.type === 'signature' && p.context === 'prohibited'));
  const annex = result.parts.find((p) => p.type === 'annex');
  assert.ok(annex && result.parts.some((p) => p.type === 'table' && p.parentId === annex.id));
  assert.equal(typedPortal('DOU', html.replace('class="assinaPr"', ''), title).status, 'partial');
  assert.equal(typedPortal('DOU', html.replace('class="anexo"', ''), title).status, 'partial');
});

test('R4 CONFAZ appendix instructions require an annex and remain non-operative', () => {
  const title = 'CONVÊNIO ICMS 100/26';
  const annex = '<p>ANEXO ÚNICO</p>';
  const appendix = '<p class="A7-2Tabelajustificado">(1) Item: informar número sequencial</p>';
  const html = '<div id="content-core"><div id="parent-fieldname-text"><p class="A1-1TituloAcordo">' + title
    + '</p>' + annex + appendix + '</div></div>';
  const result = typedPortal('CONFAZ', html, title);
  assert.equal(result.status, 'complete');
  assert.ok(result.parts.some((p) => p.ruleId.endsWith('confaz_plone_appendix_text') && p.context === 'unknown'));
  assert.equal(typedPortal('CONFAZ', html.replace(annex, ''), title).status, 'partial');
});

test('R4 DOU split CGSN epigraph requires one matching title and the explicit issuer', () => {
  const title = 'RESOLUÇÃO CGSN Nº 140';
  const heading = '<p class="identifica">RESOLUÇÃO Nº 140, DE 22 DE MAIO DE 2018</p>';
  const html = '<div>Menu</div><article id="materia"><div class="texto-dou"><p class="dou-paragraph"></p>'
    + '<p class="titulo">COMITÊ GESTOR DO SIMPLES NACIONAL</p>' + heading
    + '<p>Art. 1º Dispositivo.</p></div></article><div>Rodapé</div>';
  const result = typedPortal('DOU', html, title);
  assert.equal(result.status, 'complete');
  assert.ok(result.parts.some((p) => p.type === 'publication_header' && p.context === 'prohibited'));
  assert.doesNotMatch(result.canonicalText, /Menu|Rodapé/u);
  for (const altered of [html.replace('140,','141,'), html.replace('COMITÊ GESTOR DO SIMPLES NACIONAL','OUTRO ÓRGÃO'), html.replace(heading, heading + heading)]) {
    assert.equal(prepareOfficialAct('DOU', 'synthetic', altered, title), null);
  }
});

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

test('R3 proved portal whitespace is structural without losing text, offsets or unknown content', () => {
  const title = 'PORTARIA N\u00ba 20';
  const code = '<p class="identifica">' + title + '</p> \n<p>&nbsp;</p><p class="dou-paragraph">Art. 1\u00ba Vig\u00eancia.</p>';
  const wrap = (html: string) => '<article id="materia"><div class="texto-dou">' + html + '</div></article>';
  const valid = typedPortal('DOU', wrap(code), title);
  assert.equal(valid.status, 'complete');
  assert.match(valid.canonicalText, /\u00a0/u);
  assert.equal(valid.coverage.accountedLength, valid.canonicalText.length);
  assert.ok(valid.coverage.segments.every((segment) => segment.classification === 'recognized'));
  for (const unknown of ['Texto real sem marca\u00e7\u00e3o', '\u200b']) {
    const partial = typedPortal('DOU', wrap(unknown + code + '<p>' + unknown + '</p>'), title);
    assert.equal(partial.status, 'partial');
    assert.ok(partial.coverage.segments.some(({ span, classification }) => classification === 'unidentified'
      && partial.canonicalText.slice(span.start, span.end).includes(unknown)));
  }
  const generic = readAnatomyInput({ source: 'DOU', representationId: 'unproved', html: wrap(code) });
  assert.equal(generic.status, 'partial');
  assert.ok(generic.parts.some((part) => part.type === 'unidentified'));
});

test('R3 walks a proved nested DOU body and preserves quotes, tables and original pointers', () => {
  const title = 'PORTARIA N\u00ba 20';
  const nested = '<html><head></head><body><p class="identifica">' + title + '</p>'
    + '<p>Art. 1\u00ba Publica\u00e7\u00e3o.</p><blockquote><p>Art. 88 Texto citado.</p>'
    + '<table><tr><td>Quadro citado</td></tr></table></blockquote><p>Art. 2\u00ba Vig\u00eancia.</p></body></html>';
  const html = (part: string) => '<header>Navega\u00e7\u00e3o</header><article id="materia"><div class="texto-dou">' + part + '</div></article>';
  const value = html(nested);
  const result = typedPortal('DOU', value, title);
  const articles = result.parts.filter((part) => part.type === 'article');
  assert.equal(articles.length, 2);
  assert.ok(result.parts.some((part) => part.type === 'quoted_text' && part.context === 'prohibited'
    && result.canonicalText.slice(part.span.start, part.span.end).includes('Art. 88')));
  assert.ok(result.parts.some((part) => part.type === 'cell' && part.context === 'prohibited'));
  const firstSourceSpan = articles[0]!.sourcePointers[0]!.sourceSpan!;
  assert.equal(value.slice(firstSourceSpan.start, firstSourceSpan.end), '<p>Art. 1\u00ba Publica\u00e7\u00e3o.</p>');
  assert.doesNotMatch(result.canonicalText, /Navega/u);
  const generic = readAnatomyInput({ source: 'DOU', representationId: 'unproved', html: value });
  assert.ok(generic.parts.every((part) => part.type !== 'article'));
  const withImage = typedPortal('DOU', html(nested.replace('</body>', '<img src="page.jpg"></body>')), title);
  assert.equal(withImage.status, 'partial');
  assert.ok(withImage.limitations.some((limitation) => limitation.code === 'image_without_ocr'));
  assert.ok(withImage.parts.every((part) => part.type !== 'article'));

  const confazTitle = 'CONV\u00caNIO ICMS 1/26';
  const confaz = '<main id="content-core"><div id="parent-fieldname-text"><html><body>'
    + '<p class="A1-1TituloAcordo">' + confazTitle + '</p><p>Cl\u00e1usula primeira Teor.</p></body></html></div></main>';
  assert.ok(typedPortal('CONFAZ', confaz, confazTitle).parts.every((part) => part.type !== 'clause'));
});

test('R5 Planalto requires chapter, signature and strike evidence without dropping live text', () => {
  const title = 'LEI N\u00ba 100, DE 1 DE JANEIRO DE 2026';
  const read = (body: string) => typedPortal('PLANALTO', '<html><body><p>Casa Civil</p><p>' + title + '</p>'
    + '<p>Art. 1\u00ba Exemplo.</p>' + body + '</body></html>', title);
  const chapter = '<p align="center">cap\u00edtulo I</p>';
  const article = '<p>Art. 2\u00ba Dispositivo do cap\u00edtulo.</p>';
  const heading = '<p align="center">DO IMPOSTO SOBRE A RENDA</p>';
  const oldText = '<p><s>XI</s> <span style="text-decoration: line-through">Reda\u00e7\u00e3o anterior.</span></p>';
  const date = '<p>Bras\u00edlia, 1 de janeiro de 2026; 205o da Independ\u00eancia e 138o da Rep\u00fablica.</p>';
  const signature = '<p>NOME DO PRESIDENTE<br><em>Outro Signat\u00e1rio</em></p>';
  const complete = read(chapter + heading + article + oldText + date + signature + '<p>&nbsp;</p>');
  assert.equal(complete.status, 'complete');
  const chapterGroup = complete.parts.find(part => part.contextReasons.includes('planalto_chapter'));
  const nestedArticle = complete.parts.find(part => part.type === 'article' && part.parentId === chapterGroup?.id);
  assert.equal(chapterGroup?.type, 'group');
  assert.equal(chapterGroup.context, 'operative_candidate');
  assert.equal(nestedArticle?.context, 'operative_candidate');
  const parts = new Map(complete.parts.map(part => [part.id, part]));
  for (let parentId = nestedArticle.parentId; parentId !== null;) {
    const ancestor = parts.get(parentId);
    assert.ok(ancestor);
    assert.notEqual(ancestor.context, 'prohibited', ancestor.id);
    parentId = ancestor.parentId;
  }
  for (const reason of ['planalto_chapter_title', 'planalto_struck_block', 'planalto_signatories']) {
    const part = complete.parts.find(p => p.contextReasons.includes(reason));
    assert.equal(part?.context, 'prohibited', reason);
    assert.ok(part?.sourcePointers[0]?.sourceSpan, reason);
  }
  const titlePart = complete.parts.find(part => part.contextReasons.includes('planalto_chapter_title'));
  assert.equal(titlePart?.parentId, chapterGroup.id);
  assert.match(complete.canonicalText, /Reda\u00e7\u00e3o anterior/u);
  for (const unproven of [heading, signature, oldText.replace('</p>', ' Texto vivo.</p>'),
    chapter + '<p align="center">Da obriga\u00e7\u00e3o geral</p>', '<p>*</p>', '<p>\u200b</p>']) {
    assert.equal(read(unproven).status, 'partial', unproven);
  }
  const struck = read(chapter + heading + '<p>Art. 2\u00ba <strike>Trecho anterior.</strike></p>'
    + '<p>\u00a7 1\u00ba Texto dependente.</p><p>Art. 3\u00ba Dispositivo seguinte.</p>');
  const dependent = struck.parts.find(part => part.type === 'paragraph');
  const nextArticle = struck.parts.find(part => part.type === 'article' && part.label.startsWith('Art. 3'));
  assert.equal(dependent?.context, 'prohibited');
  assert.ok(dependent.contextReasons.includes('planalto_prohibited_ancestor'));
  assert.equal(nextArticle?.context, 'operative_candidate');

  const quote = read('<blockquote>' + chapter + heading + '</blockquote>');
  assert.ok(quote.parts.some(part => part.type === 'quoted_text' && part.context === 'prohibited'));
  assert.ok(!quote.parts.some(part => part.contextReasons.includes('planalto_chapter_title')));
});

test('R5 Planalto preserves ordinal-only strike and restores anchored article incisos', () => {
  const title = 'LEI N\u00ba 100, DE 1 DE JANEIRO DE 2026';
  const read = (body: string) => typedPortal('PLANALTO', '<html><body><p>Casa Civil</p><p>' + title + '</p>'
    + '<p>Art. 1<strike>\u00ba</strike> Caput e remiss\u00e3o ao art. 8<strike>\u00b0</strike>.</p>'
    + body + '</body></html>', title);
  const article = '<p><a name="art62"></a>Art. 62. Pode operar em:</p>';
  const historical = '<p><strike>Par\u00e1grafo \u00fanico. Trecho antigo.</strike></p>';
  const replacement = (anchor: string) => '<p><a name="' + anchor + '"></a>I - reda\u00e7\u00e3o substitutiva;</p>'
    + '<p>II - reda\u00e7\u00e3o subsequente.</p>';
  const r = read('<p>\u00a7 1\u00ba (Revogado pela Lei n\u00ba 321, de 2001)</p>' + article + historical + replacement('art62i.'));
  assert.equal(r.parts.find(part => part.type === 'article' && part.label.startsWith('Art. 1'))?.context, 'operative_candidate');
  assert.equal(r.parts.find(part => part.contextReasons.includes('planalto_repealed_placeholder'))?.context, 'prohibited');
  const owner = r.parts.find(part => part.type === 'article' && part.label.startsWith('Art. 62.'));
  assert.ok(owner);
  const incisos = r.parts.filter(part => part.type === 'inciso');
  assert.deepEqual(incisos.map(part => [part.parentId, part.context]), [
    [owner.id, 'operative_candidate'], [owner.id, 'operative_candidate'],
  ]);
  for (const anchor of ['art63i.', 'art62\u00a71i.']) {
    assert.ok(read(article + historical + replacement(anchor)).parts.filter(part => part.type === 'inciso')
      .every(part => part.context === 'prohibited'));
  }
});

test('R6 RFB corroborates bare ordinals without promoting historical versions or crossing devices', () => {
  const segment = (n: number, type: string, text: string, struck = false) =>
    '<section data-rfb-segment="' + n + '" data-rfb-type="' + type + '"'
    + (struck ? ' data-rfb-tachado="true"' : '') + '><p>' + text + '</p></section>';
  const unknown = 'nao identificad';
  const html = segment(1, 'artigo', 'Art. 1 Applies to the following:')
    + segment(2, unknown, 'I Descri\u00e7\u00e3o:')
    + segment(3, 'alinea', 'a) condi\u00e7\u00e3o;')
    + segment(4, unknown, 'II 50% do valor.', true)
    + segment(5, 'inciso', 'II - 25% do valor.')
    + segment(6, 'artigo', 'Art. 2 Dispositivo seguinte.')
    + segment(7, unknown, 'III Texto isolado.');
  const r = readAnatomyInput({ source: 'RFB', representationId: 'r6-fixture', html });
  const part = (label: string) => r.parts.find(p => p.label.startsWith(label));
  assert.equal(part('I Descri')?.type, 'inciso');
  assert.equal(part('a) condi')?.parentId, part('I Descri')?.id);
  assert.equal(part('II 50%')?.context, 'historical');
  assert.equal(part('II - 25%')?.context, 'operative_candidate');
  assert.equal(part('III Texto')?.type, 'unidentified');
});
