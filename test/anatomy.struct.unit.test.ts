import assert from 'node:assert/strict';
import test from 'node:test';
import { ANATOMY_CONTRACT_VERSION, anatomyIdentityHash, anatomyOutputHash, sha256, validateAnatomyResult, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { readAnatomyInput, type AnatomyReaderInput } from '../src/modules/anatomy/readers.js';

// ANAT-STRUCT-01. Synthetic fixtures only (invented text, "Exemplo" acts): never the corpus, gold or reserve.
function read(html: string, source: AnatomyReaderInput['source'] = 'DOU'): AnatomyResult {
  const reader = readAnatomyInput({ source, html, representationId: 'synthetic-html' });
  const identity = { publicationVersionId: 'synthetic-version', representationId: 'synthetic-html', inputTextHash: sha256(reader.canonicalText),
    inputPresentationHash: sha256('synthetic'), attachmentManifestHash: sha256('[]'), engineVersion: 'synthetic-struct-test', engineHash: sha256('synthetic-struct-engine'),
    ruleSetId: 'synthetic', ruleSetVersion: '1', ruleSetHash: sha256('synthetic'), contractVersion: ANATOMY_CONTRACT_VERSION };
  const result: AnatomyResult = { ...reader, identity, analysisId: anatomyIdentityHash(identity), contractVersion: ANATOMY_CONTRACT_VERSION,
    referenceDate: '2026-10-31', entities: [], evidence: [], eligibility: [], outputHash: sha256('placeholder') };
  result.outputHash = anatomyOutputHash(result);
  return validateAnatomyResult(result);
}
const html = (...blocks: string[]) => `<html><body>${blocks.map((b) => `<p>${b}</p>`).join('')}</body></html>`;
/** Each part as "type(reason) < parent type", in document order, for compact structural assertions. */
function tree(r: AnatomyResult) {
  const byId = new Map(r.parts.map((p) => [p.id, p]));
  return r.parts.filter((p) => !['document', 'body'].includes(p.type)).map((p) => {
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    return `${p.type}:${r.canonicalText.slice(p.span.start, p.span.end).split('\n')[0]!.slice(0, 18)}<${parent?.type ?? '-'}`;
  });
}

test('Livro > Título > Capítulo > Seção > Subseção nest above articles, with the level in the reason', () => {
  const r = read(html('LIVRO I', 'DA PARTE GERAL EXEMPLO', 'TÍTULO I - DAS DISPOSIÇÕES', 'CAPÍTULO II', 'Seção I', 'Subseção Única',
    'Art. 1º Texto fictício.', 'Parágrafo único. Regra fictícia.', 'CAPÍTULO III', 'Art. 2º Outro texto.'));
  const groups = r.parts.filter((p) => p.type === 'group');
  assert.deepEqual(groups.map((g) => g.contextReasons[0]), ['group_book', 'group_title', 'group_chapter', 'group_section', 'group_subsection', 'group_chapter']);
  const byId = new Map(r.parts.map((p) => [p.id, p]));
  const parentType = (label: RegExp) => { const p = r.parts.find((x) => label.test(r.canonicalText.slice(x.span.start, x.span.end)) && x.type !== 'group')!; return byId.get(p.parentId!)!; };
  assert.equal(parentType(/^Art\. 1º/u).contextReasons[0], 'group_subsection');
  // A new chapter closes the previous section/subsection and the article under it belongs to the new chapter.
  const art2 = r.parts.find((p) => r.canonicalText.slice(p.span.start).startsWith('Art. 2º'))!;
  assert.equal(byId.get(art2.parentId!)!.contextReasons[0], 'group_chapter');
  assert.ok(r.canonicalText.slice(byId.get(art2.parentId!)!.span.start).startsWith('CAPÍTULO III'));
  // Fidelity: coverage stays complete and no text is lost or reordered.
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
});

test('headings without accents and in title case are recognised; prose mentioning a chapter is not', () => {
  const r = read(html('TITULO II', 'CAPITULO I', 'SECAO III', 'Art. 3º Conforme o Capítulo I deste Título, aplica-se a regra.', 'Capítulo é palavra comum aqui.'));
  assert.deepEqual(r.parts.filter((p) => p.type === 'group').map((g) => g.contextReasons[0]), ['group_title', 'group_chapter', 'group_section']);
  assert.ok(!r.parts.some((p) => p.type === 'group' && r.canonicalText.slice(p.span.start).startsWith('Capítulo é')));
});

test('considerandos are preamble-like, kept out of positive selection, and do not open structure', () => {
  const r = read(html('O Secretário Exemplo, no uso das atribuições,', 'CONSIDERANDO a necessidade fictícia;', 'CONSIDERANDO o disposto no ato exemplo,', 'RESOLVE:', 'Art. 1º Fica criado o procedimento exemplo.'));
  const cons = r.parts.filter((p) => p.type === 'consideration');
  assert.equal(cons.length, 2);
  assert.ok(cons.every((c) => c.context === 'prohibited' && c.contextReasons[0] === 'consideration_marker'));
  assert.ok(r.parts.some((p) => p.type === 'article'));
});

test('items numbered under an alínea nest under it; an alínea closes items and a new article closes all', () => {
  const r = read(html('Art. 1º São exemplos:', 'I - primeiro inciso:', 'a) alínea exemplo:', '1. item um;', '2. item dois;', '1.1. subitem;', 'b) outra alínea;', 'Art. 2º Fim.'));
  const t = tree(r);
  assert.ok(t.includes('item:1. item um;<alinea'), t.join(' | '));
  assert.ok(t.includes('item:2. item dois;<alinea'));
  assert.ok(t.includes('alinea:b) outra alínea;<inciso'));
  assert.ok(t.includes('article:Art. 2º Fim.<-') || t.some((x) => x.startsWith('article:Art. 2º') && !x.endsWith('<alinea')));
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
});

test('a numbered date or value inside prose is not an item, and legal status stays unknown for every new type', () => {
  const r = read(html('Art. 1º O prazo é de 30 dias.', '2026. Ano de referência fictício sem marcador.'));
  assert.ok(!r.parts.some((p) => p.type === 'item' && r.canonicalText.slice(p.span.start).startsWith('2026')));
  const r2 = read(html('CAPÍTULO I', 'CONSIDERANDO x;', 'Art. 1º a:', 'a) b:', '1. c.'));
  assert.ok(r2.parts.every((p) => p.legalStatus === 'unknown'), 'structure never sets validity');
});

const at = (r: AnatomyResult, prefix: string, n = 0) => r.parts.filter((p) => r.canonicalText.slice(p.span.start).startsWith(prefix) && !['document', 'body', 'caput'].includes(p.type))[n]!;
const parentOf = (r: AnatomyResult, id: string) => r.parts.find((p) => p.id === r.parts.find((x) => x.id === id)!.parentId)!;

test('R2-01: a heading at the body top level inside a flat annex is NOT moved out on level alone; the ambiguity is recorded', () => {
  const r = read(html('CAPÍTULO I', 'Art. 1º Corpo.', 'ANEXO I', 'CAPÍTULO I', 'Art. 1º Dentro do anexo.'));
  const annex = at(r, 'ANEXO I'); const cap2 = at(r, 'CAPÍTULO I', 1); const art = at(r, 'Art. 1º Dentro');
  assert.equal(cap2.parentId, annex.id, 'second chapter stays inside the annex');
  assert.equal(art.parentId, cap2.id);
  assert.equal(annex.span.end, r.canonicalText.length, 'annex span runs to the end');
  const amb = r.limitations.filter((l) => l.code === 'annex_return_ambiguous');
  assert.equal(amb.length, 1);
  assert.equal(r.canonicalText.slice(amb[0]!.span!.start, amb[0]!.span!.end).trim(), 'CAPÍTULO I');
  assert.equal(r.coverage.accountedLength, r.canonicalText.length, 'no text lost');
});

test('R2-01: same flat case with LIVRO/TÍTULO levels also stays inside the annex (formerly closed by level)', () => {
  const r = read(html('LIVRO I', 'Art. 1º Corpo.', 'ANEXO I', 'Item do anexo.', 'LIVRO II', 'Art. 2º Texto.'));
  assert.equal(at(r, 'LIVRO II').parentId, at(r, 'ANEXO I').id);
  assert.ok(r.limitations.some((l) => l.code === 'annex_return_ambiguous'));
});

test('R2-01: structural evidence (annex in its own container, heading outside it) returns to the body', () => {
  const r = read('<html><body><p>LIVRO I</p><p>Art. 1º Corpo.</p><div><p>ANEXO I</p><p>CAPÍTULO I</p><p>Item do anexo.</p></div><p>LIVRO II</p><p>Art. 2º Corpo de novo.</p></body></html>');
  const annex = at(r, 'ANEXO I'); const livro2 = at(r, 'LIVRO II');
  assert.equal(parentOf(r, livro2.id).type, 'document', 'LIVRO II is outside the annex container');
  assert.ok(annex.span.end <= livro2.span.start);
  assert.equal(at(r, 'CAPÍTULO I').parentId, annex.id, 'lower level inside the container stays in the annex');
  assert.equal(at(r, 'Art. 2º').parentId, livro2.id);
  assert.ok(!r.limitations.some((l) => l.code === 'annex_return_ambiguous'));
});

test('R2-01: inside the annex container, a body-level heading stays in the annex even when levels match', () => {
  const r = read('<html><body><p>TÍTULO I</p><p>Art. 1º Corpo.</p><div><p>ANEXO I</p><p>TÍTULO I</p><p>Art. 1º Do anexo.</p></div></body></html>');
  assert.equal(at(r, 'TÍTULO I', 1).parentId, at(r, 'ANEXO I').id);
  assert.ok(r.limitations.some((l) => l.code === 'annex_return_ambiguous'));
});

test('R1-A: a historical annex never passes its historical context to body provisions after it', () => {
  const r = read(`<html><body><p>CAPÍTULO I</p><p>Art. 1º Corpo.</p><p class="RedaoAnt">ANEXO I</p><p class="RedaoAnt">Texto anterior.</p><p>CAPÍTULO II</p><p>Art. 2º Corpo atual.</p></body></html>`, 'CONFAZ');
  const annex = at(r, 'ANEXO I');
  assert.equal(annex.context, 'historical');
  const art2 = at(r, 'Art. 2º');
  assert.equal(art2.context, 'operative_candidate', 'not contaminated by the historical annex');
  assert.ok(!art2.contextReasons.includes('historical_ancestor'));
  assert.equal(parentOf(r, at(r, 'CAPÍTULO II').id).type, 'document');
});

test('R1-A: groups before, inside and with no body grouping (annex keeps them); a second annex closes the first', () => {
  const r = read(html('Art. 1º Sem agrupamento.', 'ANEXO I', 'CAPÍTULO I', 'Art. 1º Anexo I.', 'ANEXO II', 'CAPÍTULO I', 'Art. 1º Anexo II.'));
  const a1 = at(r, 'ANEXO I'); const a2 = at(r, 'ANEXO II');
  assert.equal(parentOf(r, a2.id).type, 'document');
  assert.equal(at(r, 'CAPÍTULO I', 0).parentId, a1.id);
  assert.equal(at(r, 'CAPÍTULO I', 1).parentId, a2.id);
});

test('R1-B: 1. > 1.1. > 1.1.1. nest by depth; a shallower level closes the deeper ones', () => {
  const r = read(html('Art. 1º Lista:', '1. um;', '1.1. um-um;', '1.1.1. um-um-um;', '1.2. um-dois;', '2. dois;', '2.1. dois-um.', 'Art. 2º Fim.'));
  const id = (p: string) => at(r, p).id;
  assert.equal(at(r, '1.1. ').parentId, id('1. um'));
  assert.equal(at(r, '1.1.1. ').parentId, id('1.1. '));
  assert.equal(at(r, '1.2. ').parentId, id('1. um'), '1.2. closes 1.1.1. and 1.1.');
  assert.equal(at(r, '2. dois').parentId, at(r, '1. um').parentId, '2. is a sibling of 1.');
  assert.equal(at(r, '2.1. ').parentId, id('2. dois'));
  assert.equal(parentOf(r, at(r, 'Art. 2º').id).type, 'document');
  assert.deepEqual(['1. um', '1.1. ', '1.1.1. '].map((p) => at(r, p).contextReasons[0]), ['item_marker', 'item_level_2', 'item_level_3']);
});

test('R1-B: items inside an alínea, and numbers that are not items (prose, dates, values, table cells)', () => {
  const r = read(html('Art. 1º Exemplo:', 'a) alínea:', '1. item;', '1.1. subitem;', 'b) outra.'));
  assert.equal(parentOf(r, at(r, '1. item').id).type, 'alinea');
  assert.equal(at(r, '1.1. subitem').parentId, at(r, '1. item').id);
  assert.equal(parentOf(r, at(r, 'b) outra').id).type, 'article', 'b) closes the items of a) and returns to the article');
  const n = read(html('Art. 1º O valor é 1.000,00 reais.', '31.12.2026 é a data.', '2026 ano.'));
  assert.ok(!n.parts.some((p) => p.type === 'item'), 'values/dates/years are not items');
  const t = readAnatomyInput({ source: 'DOU', representationId: 't', html: '<table><tr><td>1.1.</td><td>x</td></tr></table>' });
  assert.ok(!t.parts.some((p) => p.type === 'item'));
});

test('R1-C: exact fidelity — canonical text, UTF-16 spans, sourceMap continuity, source pointers and hashes (non-BMP, NFC, mixed annex)', () => {
  const html1 = html('CAPÍTULO I', 'Art. 1º 𝔄𝔫𝔞𝔱𝔬𝔪𝔦𝔞 😀 ção.', 'ANEXO I', '1. item 𐐷;', '1.1. sub 🇧🇷.');
  const r = read(html1);
  assert.equal(r.canonicalText, 'CAPÍTULO I\nArt. 1º 𝔄𝔫𝔞𝔱𝔬𝔪𝔦𝔞 😀 ção.\nANEXO I\n1. item 𐐷;\n1.1. sub 🇧🇷.\n');
  let at0 = 0;
  for (const m of r.sourceMap) { assert.equal(m.span.start, at0); at0 = m.span.end; }
  assert.equal(at0, r.canonicalText.length, 'sourceMap covers the text contiguously in UTF-16 units');
  for (const p of r.parts.filter((x) => x.type !== 'document')) {
    const t = r.canonicalText.slice(p.span.start, p.span.end);
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(t) && !/[\uD800-\uDBFF]$/u.test(t), `span of ${p.id} does not split a surrogate pair`);
    assert.ok(p.sourcePointers.length >= 1 && p.sourcePointers.every((s) => !s.sourceSpan || html1.slice(s.sourceSpan.start, s.sourceSpan.end).length > 0));
  }
  const again = read(html1);
  assert.equal(again.outputHash, r.outputHash, 'deterministic output hash');
  assert.equal(again.identity.inputTextHash, sha256(r.canonicalText));
});

test('R1-C: decomposed (NFD) text is kept as supplied and flagged, never silently normalised', () => {
  const nfd = 'Art. 1º Disposição.';
  const raw = readAnatomyInput({ source: 'DOU', representationId: 'n', html: `<p>${nfd}</p>` });
  assert.ok(raw.canonicalText.includes(nfd), 'NFD text preserved byte for byte');
  assert.ok(raw.limitations.some((l) => /nfc/u.test(l.code)), 'flagged as non-NFC');
});

test('R2-02: a sub-item never takes a parent with an incompatible number; missing parent is recorded', () => {
  const r = read(html('Art. 1º Lista:', '1. Primeiro.', '2.1. Subitem do item 2 ausente.'));
  const art = at(r, 'Art. 1º'); const i1 = at(r, '1. Primeiro'); const i21 = at(r, '2.1.');
  assert.notEqual(i21.parentId, i1.id, '2.1 is not a child of 1');
  assert.equal(i21.parentId, art.id, 'attached to the enclosing device');
  assert.ok(i21.contextReasons.includes('item_parent_missing'));
  const lim = r.limitations.find((l) => l.code === 'item_parent_missing')!;
  assert.equal(r.canonicalText.slice(lim.span!.start, lim.span!.end).trim(), '2.1. Subitem do item 2 ausente.');
  assert.equal(r.canonicalText.slice(i21.span.start, i21.span.end).trim(), '2.1. Subitem do item 2 ausente.', 'text and span preserved');
  assert.ok(i1.span.end <= i21.span.start);
});

test('R2-02: valid sequences 1 / 1.1 / 1.1.1 and sibling changes nest by exact prefix, with no limitation', () => {
  const r = read(html('Art. 1º Lista:', '1. Um.', '1.1. Um-um.', '1.1.1. Um-um-um.', '1.2. Um-dois.', '2. Dois.', '2.1. Dois-um.'));
  const id = (p: string) => at(r, p).id;
  assert.equal(at(r, '1.1. Um-um').parentId, id('1. Um'));
  assert.equal(at(r, '1.1.1.').parentId, id('1.1. Um-um'));
  assert.equal(at(r, '1.2.').parentId, id('1. Um'));
  assert.equal(at(r, '2.1.').parentId, id('2. Dois'));
  assert.equal(at(r, '2. Dois').parentId, id('Art. 1º'));
  assert.ok(!r.limitations.some((l) => l.code === 'item_parent_missing'));
});

test('R2-02: a deeper sub-item under the wrong branch (1.1 open, then 2.1.1) is not grafted onto 1.1', () => {
  const r = read(html('Art. 1º Lista:', '1. Um.', '1.1. Um-um.', '2.1.1. Órfão.'));
  assert.equal(at(r, '2.1.1.').parentId, at(r, 'Art. 1º').id);
  assert.ok(r.limitations.some((l) => l.code === 'item_parent_missing'));
});

test('R2-01: container evidence also works for a fragment without <html>/<body>', () => {
  const r = read('<p>LIVRO I</p><p>Art. 1º Corpo.</p><div><p>ANEXO I</p><p>Item.</p></div><p>LIVRO II</p><p>Art. 2º Corpo.</p>');
  assert.equal(parentOf(r, at(r, 'LIVRO II').id).type, 'document');
  const flat = read('<p>LIVRO I</p><p>Art. 1º Corpo.</p><p>ANEXO I</p><p>Item.</p><p>LIVRO II</p>');
  assert.equal(at(flat, 'LIVRO II').parentId, at(flat, 'ANEXO I').id, 'flat fragment: no evidence, stays');
});
