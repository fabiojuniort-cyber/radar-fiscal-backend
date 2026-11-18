import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prepareRfbRepresentation } from '../src/modules/anatomy/json-preparation.js';
import { planRfbQuoteResume, verifyRfbQuoteResumePlan } from '../src/modules/anatomy/rfb-quote-resume.js';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { LOT_DIRS, snapshotDirOf } from '../ops/anatomy/official-lot-rfb.js';

// ANAT-L20 (#293 §17): review signal only. Classification never changes; synthetic cases modelled on IN 2.121.
const SIGNAL = 'rfb_quote_unclosed_resume_candidate';
const TYPES = [{ idTipoSegmento: 1, siglaTipoSegmento: 'ementa' }, { idTipoSegmento: 3, siglaTipoSegmento: 'artigo' }, { idTipoSegmento: 4, siglaTipoSegmento: 'fecho' },
  { idTipoSegmento: 5, siglaTipoSegmento: 'paragrafo' }, { idTipoSegmento: 9, siglaTipoSegmento: 'secao' }, { idTipoSegmento: 999, siglaTipoSegmento: 'nao identificado' }];
const ID = 900020;
const seg = (order: number, tipo: number, text: string, tachado = false) => ({ ordemSegmentoAto: order, idTipoSegmento: tipo, textoIntegra: text, ...(tachado ? { tachado: true } : {}) });
const bytesOf = (segs: Record<string, unknown>[]) => new TextEncoder().encode(JSON.stringify({ idAto: ID, tiposSegmento: TYPES,
  ementas: [seg(1, 1, '<p>Dispõe sobre o exemplo sintético.</p>')], outrosSegmentos: segs }));
const A705 = [seg(2, 3, '<p>Art. 705. Texto operativo anterior.</p>', true), seg(3, 3, '<p>Art. 705. Texto operativo vigente.</p>'), seg(4, 9, 'Seção II \n Da Aprovação')];
const OPEN = [seg(5, 3, '<p>Art. 706. Redação anterior do próprio artigo.</p>', true), seg(6, 999, '<p>"Art. 706. Nova redação do próprio artigo.</p>')];
const PAIRS = [seg(7, 5, '<p>§ 1º Parágrafo anterior.</p>', true), seg(8, 5, '<p>§ 1º Parágrafo vigente.</p>'),
  seg(9, 5, '<p>§ 2º Outro anterior.</p>', true), seg(10, 5, '<p>§ 2º Outro vigente.</p>')];
const GROUP = [seg(11, 9, 'Seção III \n Da Habilitação')];
const SUCC = [seg(12, 3, '<p>Art. 707. Artigo seguinte sem aspas.</p>'), seg(13, 4, 'FULANO EXEMPLO')];
const REAL_LIKE = [...A705, ...OPEN, ...PAIRS, ...GROUP, ...SUCC];

const run = (bytes: Uint8Array, plan: unknown, opts: { id?: string; html?: string } = {}) => {
  const p = prepareRfbRepresentation({ resourceId: 'rfb:x', bytes }, ID);
  return analyzeAnatomy({ publicationVersionId: 'rfb:x', referenceDate: '2026-11-07', ruleSet: { id: 'l20', version: '1' },
    input: { source: 'RFB', representationId: opts.id ?? 'rfb:x', html: opts.html ?? p.html, ...(plan === undefined ? {} : { rfbQuoteResume: plan as never }) }, catalog: { edition: 'none', codes: [] } });
};
const planOf = (bytes: Uint8Array) => planRfbQuoteResume({ resourceId: 'rfb:x', bytes }, ID);
/** Everything the signal must not change: text, parts (contexts, types), sourceMap, coverage and eligibility. */
const structural = (r: ReturnType<typeof run>) => createHash('sha256').update(JSON.stringify({ c: r.canonicalText, p: r.parts, s: r.sourceMap, v: r.coverage, e: r.eligibility })).digest('hex');
const signals = (r: ReturnType<typeof run>) => r.limitations.filter((l) => l.code === SIGNAL);

test('L20: the real-like case (struck 706, unclosed "Art. 706, struck+current pairs, declared Seção III, Art. 707) gets the signal and nothing else changes', () => {
  const bytes = bytesOf(REAL_LIKE); const plan = planOf(bytes);
  assert.ok(plan.candidate, JSON.stringify(plan.notCandidate));
  assert.deepEqual([plan.candidate!.opening.order, plan.candidate!.opening.article, plan.candidate!.successor.order, plan.candidate!.successor.article], [6, '706', 12, '707']);
  assert.deepEqual(plan.candidate!.evidence.E6.pairs.map((x) => [x.struckOrder, x.currentOrder]), [[7, 8], [9, 10]]);
  assert.deepEqual(plan.candidate!.evidence.E7, { kind: 'declared_grouping', order: 11, type: 'secao' });
  const without = run(bytes, undefined); const withPlan = run(bytes, plan);
  assert.equal(structural(withPlan), structural(without), 'parts, contexts, sourceMap, coverage and eligibility are identical');
  assert.equal(signals(without).length, 0); assert.equal(signals(withPlan).length, 1);
  assert.deepEqual(withPlan.limitations.filter((l) => l.code !== SIGNAL), without.limitations, 'only the signal is added');
  assert.equal(withPlan.status, 'partial');
  // everything after the opening stays quoted/prohibited, the successor included
  const after = withPlan.parts.filter((x) => x.type !== 'document' && /^("Art\. 706\. Nova|§ [12]º (Parágrafo|Outro) vigente|Seção III|Art\. 707)/u.test(withPlan.canonicalText.slice(x.span.start).trimStart()));
  assert.ok(after.length >= 5 && after.every((x) => x.context === 'prohibited'), 'no automatic resume');
  assert.match(signals(withPlan)[0]!.message, /HUMAN REVIEW ONLY/u);
});

test('L20: the successor preceded by its own struck pair satisfies E7 too', () => {
  const plan = planOf(bytesOf([...A705, ...OPEN, ...PAIRS, seg(11, 3, '<p>Art. 707. Redação anterior.</p>', true), ...SUCC]));
  assert.deepEqual(plan.candidate?.evidence.E7, { kind: 'struck_successor_pair', order: 11 });
});

const counter: [string, Record<string, unknown>[], string][] = [
  ['§16-1: §§ without struck pairs and Art. 707 right after (no grouping)', [...A705, ...OPEN, seg(7, 5, '<p>§ 1º Sem par.</p>'), ...SUCC], 'E7'],
  ['§16-2: declared grouping but §§ without pairs', [...A705, ...OPEN, seg(7, 5, '<p>§ 1º Sem par.</p>'), seg(8, 5, '<p>§ 2º Sem par.</p>'), ...GROUP, ...SUCC], 'E6'],
  ['§16-3: pairs but no grouping and no struck successor pair', [...A705, ...OPEN, ...PAIRS, ...SUCC], 'E7'],
  ['§15-1: introduced by an amending formula (quotation of another act)', [seg(2, 3, '<p>Art. 705. A IN nº 1, de 2020, passa a vigorar com as seguintes alterações:</p>'),
    seg(3, 3, '<p>Art. 706. Redação anterior.</p>', true), seg(4, 999, '<p>"Art. 706. Texto citado.</p>'), ...PAIRS, ...GROUP, ...SUCC], 'E2'],
  ['§15-2: no struck article N right before the opening', [...A705, seg(6, 999, '<p>"Art. 706. Texto citado.</p>'), ...PAIRS, ...GROUP, ...SUCC], 'E1'],
  ['§14.1: successor is not N+1', [...A705, ...OPEN, ...PAIRS, ...GROUP, seg(12, 3, '<p>Art. 709. Outro artigo.</p>')], 'E0'],
  ['§14.1: opening without an article label', [...A705, seg(5, 3, '<p>Art. 706. Anterior.</p>', true), seg(6, 999, '<p>"Texto citado sem rótulo.</p>'), ...PAIRS, ...GROUP, ...SUCC], 'E0'],
  ['IN 2.021 model: quotation closed later (678 → 682)', [...A705, seg(5, 999, '<p>"Art. 142. Texto citado.</p>'), seg(6, 999, '<p>§ 1º Continua citado." (NR)</p>'), ...SUCC], 'no_unclosed_quotation'],
];
for (const [name, segs, condition] of counter) test(`L20 counter-case — ${name}: prohibited preserved, no signal (${condition})`, () => {
  const bytes = bytesOf(segs); const plan = planOf(bytes);
  assert.equal(plan.candidate, null); assert.equal(plan.notCandidate?.condition, condition, plan.notCandidate?.detail);
  const a = run(bytes, undefined); const b = run(bytes, plan);
  assert.equal(structural(b), structural(a)); assert.deepEqual(b.limitations, a.limitations); assert.equal(signals(b).length, 0);
});

test('L20 E4: forged, copied, other-HTML, other-id and HTML-attribute plans give no signal; the engine refuses the plan for other sources', () => {
  const bytes = bytesOf(REAL_LIKE); const plan = planOf(bytes);
  const p = prepareRfbRepresentation({ resourceId: 'rfb:x', bytes }, ID);
  assert.equal(verifyRfbQuoteResumePlan(plan, p.html, 'rfb:x'), true);
  const copied = JSON.parse(JSON.stringify(plan)); const spread = { ...plan };
  for (const fake of [copied, spread, Object.freeze(structuredClone(plan))]) {
    assert.equal(verifyRfbQuoteResumePlan(fake, p.html, 'rfb:x'), false); assert.equal(signals(run(bytes, fake)).length, 0);
  }
  assert.equal(signals(run(bytes, plan, { id: 'rfb:other' })).length, 0, 'representationId mismatch');
  assert.equal(signals(run(bytes, plan, { html: p.html.replace('Artigo seguinte', 'Artigo seguinte!') })).length, 0, 'modified HTML');
  const other = planOf(bytesOf([...REAL_LIKE.slice(0, -1), seg(13, 4, 'OUTRO FECHO')]));
  assert.equal(signals(run(bytes, other)).length, 0, 'plan of another HTML');
  const marked = p.html.replace('<section data-rfb-segment="6"', '<section data-rfb-segment="6" data-rfb-quote-resume="707"');
  const r = readAnatomyInput({ source: 'RFB', representationId: 'rfb:x', html: marked });
  assert.equal(r.limitations.filter((l) => l.code === SIGNAL).length, 0, 'an HTML attribute is never evidence');
  assert.throws(() => analyzeAnatomy({ publicationVersionId: 'd', referenceDate: '2026-11-07', ruleSet: { id: 'l20', version: '1' },
    input: { source: 'DOU', representationId: 'rfb:x', html: p.html, rfbQuoteResume: plan }, catalog: { edition: 'none', codes: [] } }), /only valid for source RFB/u);
});

test('L20 official lot: only IN 2.121 gets the signal (4008/706 → 4014/707; E1 4007; E6 4009/4010, 4011/4012; E7 Seção III 4013); reader output identical for the 7 acts', () => {
  const ids = LOT_DIRS.flatMap((d) => readdirSync(d).filter((f) => /^\d+\.json$/u.test(f)).map((f) => Number(f.slice(0, -5)))).sort((a, b) => a - b);
  assert.equal(ids.length, 10, '7 INs + 3 acts of E9 P2-c');
  for (const id of ids) {
    const bytes = new Uint8Array(readFileSync(join(snapshotDirOf(id), `${id}.json`)));
    const p = prepareRfbRepresentation({ resourceId: `rfb:${id}`, bytes }, id);
    const plan = planRfbQuoteResume({ resourceId: `rfb:${id}`, bytes }, id);
    const go = (extra: object) => analyzeAnatomy({ publicationVersionId: `rfb:${id}`, referenceDate: '2026-11-05', ruleSet: { id: 'official-lot-rfb', version: '1' },
      input: { source: 'RFB', representationId: `rfb:${id}`, html: p.html, ...extra }, catalog: { edition: 'none', codes: [] } });
    const a = go({}); const b = go({ rfbQuoteResume: plan });
    assert.equal(structural(b), structural(a), `${id}: parts, contexts, sourceMap, coverage and eligibility unchanged`);
    assert.deepEqual(b.limitations.filter((l) => l.code !== SIGNAL), a.limitations, `${id}: only the signal may be added`);
    if (id !== 127905) { assert.equal(signals(b).length, 0, `${id}: no signal`); continue; }
    const c = plan.candidate!;
    assert.deepEqual([c.opening.order, c.opening.article, c.successor.order, c.successor.article, c.evidence.E1.struckArticleOrder], [4008, '706', 4014, '707', 4007]);
    assert.deepEqual(c.evidence.E6.pairs.map((x) => [x.struckOrder, x.currentOrder]), [[4009, 4010], [4011, 4012]]);
    assert.deepEqual(c.evidence.E7, { kind: 'declared_grouping', order: 4013, type: 'secao' });
    assert.equal(signals(b).length, 1);
  }
});
