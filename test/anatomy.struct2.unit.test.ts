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
