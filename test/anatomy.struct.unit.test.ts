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
