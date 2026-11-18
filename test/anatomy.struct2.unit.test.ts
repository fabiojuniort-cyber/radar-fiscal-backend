import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';

// ANAT-STRUCT-02. Synthetic fixtures only (invented "Exemplo" text): never the corpus, gold or reserve.
const run = (html: string, source: 'DOU' | 'CONFAZ' | 'RFB' = 'DOU') => analyzeAnatomy({ publicationVersionId: 's', referenceDate: '2026-10-31',
  ruleSet: { id: 's', version: '1' }, input: { source, representationId: 's://x', html }, catalog: { edition: 's', codes: ['84713012'] } });

test('caput: one structural child per article/clause over exactly its opening block, first in sibling order', () => {
  const r = run('<p>Art. 1º Fica criado o regime exemplo.</p><p>§ 1º Regra.</p><p>Art. 2º Outro.</p>');
  const arts = r.parts.filter((p) => p.type === 'article');
  for (const a of arts) {
    const caput = r.parts.find((p) => p.parentId === a.id && p.type === 'caput')!;
    assert.ok(caput, `caput of ${a.id}`);
    assert.equal(caput.id, `${a.id}-caput`);
    assert.equal(caput.order, 0);
    assert.equal(r.canonicalText.slice(caput.span.start, caput.span.end).trim().split('\n').length, 1, 'caput is the opening block only');
    assert.ok(caput.span.start === a.span.start && caput.span.end <= a.span.end);
    assert.equal(caput.context, a.context); assert.equal(caput.legalStatus, 'unknown');
  }
  const para = r.parts.find((p) => p.type === 'paragraph')!;
  assert.equal(r.parts.find((p) => p.id === para.parentId)!.type, 'article', 'paragraphs stay children of the article, not of the caput');
});

test('caput never takes ownership: entities and eligibility keep the article, and no part is renumbered', () => {
  const r = run('<p>Art. 1º Aplica-se à NCM 8471.30.12.</p><p>Art. 2º Fim.</p>', 'RFB');
  const ncm = r.entities.find((e) => e.domain === 'NCM')!;
  assert.equal(r.parts.find((p) => p.id === ncm.partId)!.type, 'article');
  assert.ok(!r.eligibility.some((e) => r.parts.find((p) => p.id === e.partId)?.type === 'caput'));
  const seq = r.parts.filter((p) => p.type !== 'caput').map((p) => p.id);
  assert.deepEqual(seq, seq.map((_, i) => `part-${i}`), 'sequential ids exclude caputs');
});

test('clauses get a caput too; historical context is inherited', () => {
  const r = run('<p class="TextoAcordo">Cláusula primeira Texto exemplo.</p><p class="RedaoAnt">Cláusula segunda Redação anterior.</p>', 'CONFAZ');
  const caputs = r.parts.filter((p) => p.type === 'caput');
  assert.equal(caputs.length, 2);
  assert.equal(caputs[1]!.context, 'historical');
});

test('Parágrafo único keeps the paragraph type with reason paragraph_sole; "§ 1º" keeps paragraph_marker; prose is not', () => {
  const r = run('<p>Art. 1º Texto.</p><p>Parágrafo único. Regra exemplo.</p><p>Art. 2º Texto.</p><p>§ 1º Primeiro.</p><p>PARÁGRAFO ÚNICO - caixa alta.</p>');
  const paras = r.parts.filter((p) => p.type === 'paragraph').map((p) => p.contextReasons[0]);
  assert.deepEqual(paras, ['paragraph_sole', 'paragraph_marker', 'paragraph_sole']);
  const prose = readAnatomyInput({ source: 'DOU', representationId: 'x', html: '<p>Art. 1º Conforme o parágrafo único do art. 2º.</p>' });
  assert.ok(!prose.parts.some((p) => p.type === 'paragraph'));
});

test('fidelity: canonical text, coverage and spans unchanged by caput; validated by the contract', () => {
  const html = '<p>Art. 1º Texto com acento ção e emoji 😀.</p><p>Parágrafo único. Fim.</p>';
  const r = run(html);
  assert.equal(r.coverage.accountedLength, r.canonicalText.length);
  const reader = readAnatomyInput({ source: 'DOU', representationId: 'x', html });
  assert.equal(r.canonicalText, reader.canonicalText);
});

test('with STRUCT-01 R1: caput coexists with nested items and with the annex return (R2-01: annex in its own container); ids not renumbered', () => {
  const r = run('<p>LIVRO I</p><p>Art. 1º Lista:</p><p>1. um;</p><p>1.1. sub;</p><div><p>ANEXO I</p><p>Texto.</p></div><p>LIVRO II</p><p>Art. 2º Fim.</p>');
  const byText = (pre: string) => r.parts.find((p) => p.type !== 'caput' && p.type !== 'document' && r.canonicalText.slice(p.span.start).startsWith(pre))!;
  const art1 = byText('Art. 1º');
  assert.ok(r.parts.some((p) => p.id === `${art1.id}-caput` && p.parentId === art1.id));
  assert.equal(byText('1. um').parentId, art1.id, 'items hang from the article, not from its caput');
  assert.equal(byText('1.1. sub').parentId, byText('1. um').id);
  assert.equal(r.parts.find((p) => p.id === byText('LIVRO II').parentId)!.type, 'document');
  const seq = r.parts.filter((p) => p.type !== 'caput').map((p) => p.id);
  assert.deepEqual(seq, seq.map((_, i) => `part-${i}`));
});

test('ANAT-D02: unmarked continuation blocks extend the caput until the next marker', () => {
  const html = '<html><body><p>Art. 1º Fica instituído o regime exemplo,</p><p>observadas as condições deste ato.</p><p>§ 1º Primeiro parágrafo.</p><p>Texto solto do parágrafo.</p><p>Art. 2º Outro.</p></body></html>';
  const r = readAnatomyInput({ source: 'DOU', representationId: 'd02', html });
  const caput = r.parts.find((p) => p.type === 'caput' && r.canonicalText.slice(p.span.start).startsWith('Art. 1º'))!;
  assert.equal(r.canonicalText.slice(caput.span.start, caput.span.end).replace(/\n/gu, ' ').trimEnd(), 'Art. 1º Fica instituído o regime exemplo, observadas as condições deste ato.');
  assert.ok(caput.contextReasons.includes('caput_continuation'));
  assert.equal(caput.sourcePointers.length, 2);
  const cont = r.parts.find((p) => r.canonicalText.slice(p.span.start).startsWith('observadas'))!;
  assert.equal(cont.parentId, caput.id, 'continuation nests under the caput');
  const loose = r.parts.find((p) => r.canonicalText.slice(p.span.start).startsWith('Texto solto'))!;
  assert.notEqual(r.parts.find((p) => p.id === loose.parentId)!.type, 'caput', 'after a marker, blocks are not caput');
  const caput2 = r.parts.find((p) => p.type === 'caput' && r.canonicalText.slice(p.span.start).startsWith('Art. 2º'))!;
  assert.equal(caput2.sourcePointers.length, 1);
});

test('R2-08: a table (or any other new child) closes the caput continuation', () => {
  const html = '<html><body><p>Art. 1º Ficam fixados os valores exemplo</p><table><tr><td>A</td><td>1</td></tr></table><p>conforme a tabela acima.</p><p>Art. 2º Outro.</p></body></html>';
  const r = readAnatomyInput({ source: 'DOU', representationId: 'r208', html });
  const caput = r.parts.find((p) => p.type === 'caput' && r.canonicalText.slice(p.span.start).startsWith('Art. 1º'))!;
  assert.equal(r.canonicalText.slice(caput.span.start, caput.span.end).trimEnd(), 'Art. 1º Ficam fixados os valores exemplo');
  assert.equal(caput.sourcePointers.length, 1);
  assert.ok(!caput.contextReasons.includes('caput_continuation'));
  const after = r.parts.find((p) => r.canonicalText.slice(p.span.start).startsWith('conforme'))!;
  assert.notEqual(after.parentId, caput.id, 'block after the table is not caput');
  const tbl = r.parts.find((p) => p.type === 'table')!;
  assert.ok(tbl.span.start >= caput.span.end, 'table is outside the caput');
});
