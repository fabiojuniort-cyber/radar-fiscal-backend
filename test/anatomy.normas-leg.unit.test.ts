import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { analyzeAnatomy } from '../src/modules/anatomy/engine.js';
import { NormasLegProvenanceError } from '../src/modules/anatomy/readers.js';
import { prepareNormasLegPage, verifyNormasLegPreparation, NormasLegPreparationError, isCamaraNoteHref, type NormasLegPreparation } from '../src/modules/anatomy/normas-leg-preparation.js';
import type { AnatomyResult } from '../src/modules/anatomy/contract.js';
import { computeRegression, REGRESSION_BASELINE } from '../ops/anatomy/lleg-regression.js';

// L-LEG-01 (#116 c.6708512598 §7; docs/anatomy/L-LEG-01-DESIGN.md §4, §10, §11, §12). Offline only; no request.
const DIR = 'ops/anatomy/official-identification/leg-normas/';
const URL0 = 'https://normas.leg.br/api/public/binario/00000000-0000-0000-0000-000000000000/texto';
const URN = 'urn:lex:br:federal:lei:2002-12-30;10637';
const C = 'https://www2.camara.leg.br/legin/fed/lei/2008/lei-1-norma-pl.html';
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const page = (body: string) => `<html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const a = (text: string, href = C) => `<a href="${href}" style="text-decoration:none"><span class="Hyperlink" style="font-style:italic">${text}</span></a>`;
const prep = (bytes: Uint8Array, over: Partial<Parameters<typeof prepareNormasLegPage>[0]> = {}) => prepareNormasLegPage({ resourceId: 'r1', url: URL0, urn: URN, version: 'atualizada', bytes, ...over });
const req = (html: string, input: Record<string, unknown>, catalog?: { edition: string; codes: string[] }) => analyzeAnatomy({ publicationVersionId: 'v', referenceDate: '2026-11-07',
  ruleSet: { id: 't', version: '1' }, input: { representationId: 'r1', html, ...input } as never, ...(catalog ? { catalog } : {}) });
const readNL = (p: NormasLegPreparation, catalog?: { edition: string; codes: string[] }) => req(p.html, { source: 'NORMAS-LEG', normasLeg: p }, catalog);
const readDOU = (html: string, catalog?: { edition: string; codes: string[] }) => req(html, { source: 'DOU' }, catalog);
const both = (body: string) => { const p = prep(enc(page(body))); return { p, nl: readNL(p), dou: readDOU(p.html) }; };
const textOf = (r: AnatomyResult, id: string) => { const x = r.parts.find((y) => y.id === id)!; return r.canonicalText.slice(x.span.start, x.span.end); };
const at = (r: AnatomyResult, starts: string, type?: string) => r.parts.find((x) => (!type || x.type === type) && !['caput', 'editorial_note', 'document'].includes(x.type) && r.canonicalText.slice(x.span.start).startsWith(starts))!;
const notes = (r: AnatomyResult) => r.parts.filter((x) => x.type === 'editorial_note');
const key = (x: { type: string; span: { start: number; end: number } }) => `${x.type}@${x.span.start}-${x.span.end}`;
/** Parts other than the new notes, compared by region (design §11.5: ids/orders may change). */
const byRegion = (r: AnatomyResult) => new Map(r.parts.filter((x) => !(x.type === 'editorial_note' && x.contextReasons.some((c) => c.startsWith('normas_leg_')))).map((x) => [key(x), x]));
/** Selections without any context exclusion (the would-be-eligible set), by region (design §11.6). */
const candidates = (r: AnatomyResult) => new Set(r.eligibility.filter((e) => e.exclusionReasons.every((x) => x === 'missing_approved_evidence')).map((e) => `${e.purpose}@${e.span.start}-${e.span.end}`));
const sameExceptNotes = (nl: AnatomyResult, dou: AnatomyResult, allowed: Set<string> = new Set()) => {
  assert.equal(nl.canonicalText, dou.canonicalText); assert.deepEqual(nl.sourceMap, dou.sourceMap);
  const b = byRegion(dou); const n = byRegion(nl);
  assert.deepEqual([...n.keys()].sort(), [...b.keys()].sort(), 'same structural parts by region and type');
  for (const [k, x] of n) {
    const y = b.get(k)!;
    if (allowed.has(k)) continue;
    assert.equal(x.context, y.context, `context of ${k}`);
  }
  for (const c of candidates(nl)) assert.ok(candidates(dou).has(c), `no new candidate region ${c}`);
  assert.ok(nl.eligibility.every((e) => !e.eligible)); assert.ok(nl.parts.every((x) => x.legalStatus === 'unknown'));
};
const real = (f: string) => { const m = JSON.parse(readFileSync(`${DIR}${f}.meta.json`, 'utf8')) as { url: string; urn: string; sha256: string; bytes: number };
  const bytes = new Uint8Array(readFileSync(`${DIR}${f}.html`));
  return { m, bytes, p: prepareNormasLegPage({ resourceId: f, url: m.url, urn: m.urn, version: 'atualizada', bytes, expected: { sha256: m.sha256, bytes: m.bytes } }) };
};
const readReal = (f: string) => { const { p, bytes } = real(f); const r = (s: Record<string, unknown>) => analyzeAnatomy({ publicationVersionId: f, referenceDate: '2026-11-07', ruleSet: { id: 't', version: '1' }, input: { representationId: f, html: p.html, ...s } as never });
  return { p, bytes, nl: r({ source: 'NORMAS-LEG', normasLeg: p }), dou: r({ source: 'DOU' }) }; };
const L637 = readReal('lei-10637-2002-atualizada');
const L833 = readReal('lei-10833-2003-atualizada');
const regionBytes = (bytes: Uint8Array, s: { start: number; end: number }) => sha(bytes.subarray(s.start, s.end)).slice(0, 16);

test('cases 1, 8 and 15 (real 10.637 art. 1º): caput unchanged; the note split over two anchors is ONE editorial_note; the Vide is another; regions match §6', () => {
  const { nl, dou, p, bytes } = L637;
  const art = at(nl, 'Art. 1º A Contribuição', 'article'); const artDou = at(dou, 'Art. 1º A Contribuição', 'article');
  assert.deepEqual([art.span, art.context, art.contextReasons], [artDou.span, artDou.context, artDou.contextReasons]);
  const caput = nl.parts.find((x) => x.parentId === art.id && x.type === 'caput')!;
  const kids = notes(nl).filter((x) => x.parentId === caput.id);
  assert.equal(kids.length, 2, 'one split note + one Vide');
  const [redacao, vide] = kids;
  assert.match(textOf(nl, redacao!.id), /^\(“Caput” do artigo com redação dada pela Medida Provisória nº 627, de 11\/11\/2013, convertida na Lei nº 12\.973, de 13\/5\/2014, em vigor a partir de 1\/1\/2015\)$/u);
  assert.deepEqual([redacao!.context, redacao!.contextReasons, redacao!.sourcePointers.length], ['prohibited', ['normas_leg_editorial_note'], 2]);
  assert.deepEqual([vide!.contextReasons, textOf(nl, vide!.id)], [['normas_leg_vide'], '(Vide Lei Complementar nº 214, de 16/1/2025)']);
  const block = p.plan.blocks.find((b) => b.notes.some((n) => n.anchors[0]!.byteSpan.start === 16846))!;
  const [n1, n2] = block.notes;
  assert.deepEqual(n1!.anchors.map((x) => x.byteSpan), [{ start: 16846, end: 17162 }, { start: 17202, end: 17485 }], '§6 caso 15: the two anchors');
  assert.deepEqual([regionBytes(bytes, n1!.anchors[0]!.byteSpan), regionBytes(bytes, n1!.anchors[1]!.byteSpan)], ['0a9cc8521414ecd8', 'eb342badc4232441']);
  assert.deepEqual([n2!.region.byteSpan, regionBytes(bytes, n2!.region.byteSpan), n2!.kind], [{ start: 17540, end: 17835 }, '9f2e3775696c460e', 'vide']);
  assert.ok(nl.parts.every((x) => x.context !== 'historical'), 'nothing historical');
});

test('cases 2 and 16 (real): "IV - (Revogada …)" and "IV - (Revogado a partir de …)" are prohibited placeholders; no date is inferred; legalStatus unknown', () => {
  for (const [{ nl, dou, p, bytes }, start, noteBytes, noteSha] of [[L637, 'IV - (Revogada pela Lei nº 11.727', { start: 20590, end: 20921 }, '49057e79a3e71e6d'], [L833, 'IV - (Revogado a partir de 1/10/2008', { start: 21441, end: 21752 }, '7b1bc248d40686ed']] as const) {
    const inc = at(nl, start, 'inciso'); const incDou = at(dou, start, 'inciso');
    assert.deepEqual([inc.span, inc.type, incDou.context], [incDou.span, 'inciso', 'operative_candidate']);
    assert.deepEqual([inc.context, inc.contextReasons.at(-1), inc.legalStatus], ['prohibited', 'normas_leg_revoked_placeholder', 'unknown']);
    const n = notes(nl).filter((x) => x.parentId === inc.id); assert.equal(n.length, 1);
    const planned = p.plan.blocks.flatMap((b) => b.notes).find((x) => x.region.byteSpan.start === noteBytes.start)!;
    assert.deepEqual([planned.region.byteSpan, regionBytes(bytes, planned.region.byteSpan), planned.kind], [noteBytes, noteSha, 'revocation']);
    assert.ok(!nl.limitations.some((l) => /vig[êe]ncia|efeito|date/iu.test(l.code)), 'no validity or date inference');
  }
});

test('cases 3 and 4: revocation never spreads — neighbours and the paragraphs of a revoked article stay as read', () => {
  const { nl, dou } = both(`<p>Art. 1º Texto do artigo.</p><p>I - primeiro inciso com texto;</p><p>II - ${a('(Revogado pela Lei nº 1, de 1/1/2001)')}</p><p>III - terceiro inciso com texto.</p>`
    + `<p>Art. 5º ${a('(Revogado pela Lei nº 2, de 2/2/2002)')}</p><p>§ 1º Parágrafo com texto próprio.</p><p>§ 2º Outro parágrafo.</p>`);
  const allowed = new Set([key(at(dou, 'II - ', 'inciso')), key(at(dou, 'Art. 5º', 'article')), key(dou.parts.find((x) => x.type === 'caput' && dou.canonicalText.slice(x.span.start).startsWith('Art. 5º'))!)]);
  sameExceptNotes(nl, dou, allowed);
  assert.deepEqual(['I - ', 'II - ', 'III - ', 'Art. 5º', '§ 1º', '§ 2º'].map((s) => at(nl, s).context), ['operative_candidate', 'prohibited', 'operative_candidate', 'prohibited', 'operative_candidate', 'operative_candidate']);
});

test('cases 5, 8, 24 and 26: Vide, two notes, nested parentheses and two groups in one anchor', () => {
  const { nl, dou } = both(`<p>§ 1º Texto do parágrafo. ${a('(Vide Lei nº 3)')}</p><p>§ 2º Outro texto. ${a('(Parágrafo com redação dada pela Lei nº 4)')} ${a('(Vide Lei nº 5)')}</p>`
    + `<p>§ 3º Mais texto. ${a('(“Caput” do artigo com redação dada pela Lei nº 6 (art. 2º))')}</p><p>§ 4º Texto. ${a('(Artigo acrescido pela Lei nº 7) (Vide Lei nº 8)')}</p>`);
  sameExceptNotes(nl, dou);
  const by = (s: string) => notes(nl).filter((x) => x.parentId === at(nl, s).id).map((x) => [textOf(nl, x.id), x.contextReasons[0]]);
  assert.deepEqual(by('§ 1º'), [['(Vide Lei nº 3)', 'normas_leg_vide']]);
  assert.deepEqual(by('§ 2º'), [['(Parágrafo com redação dada pela Lei nº 4)', 'normas_leg_editorial_note'], ['(Vide Lei nº 5)', 'normas_leg_vide']], 'two disjoint parts');
  assert.deepEqual(by('§ 3º'), [['(“Caput” do artigo com redação dada pela Lei nº 6 (art. 2º))', 'normas_leg_editorial_note']]);
  assert.deepEqual(by('§ 4º'), [['(Artigo acrescido pela Lei nº 7) (Vide Lei nº 8)', 'normas_leg_editorial_note']], 'one anchor = one region');
});

test('cases 6 and 7: legitimate parentheses do nothing; a note-looking parenthetical outside a proven Câmara anchor sends the block to unknown, nothing cut', () => {
  const { nl, dou } = both(`<p>Art. 2º A Contribuição para o PIS/Pasep (Pasep) incide sobre a receita (inciso I do art. 3º).</p>`
    + `<p>§ 1º O texto (Redação dada pela Lei nº 1) continua no período.</p><p>§ 2º Texto final. (Incluído pela Lei nº 2)</p>`
    + `<p>§ 3º Texto final. ${a('(Incluído pela Lei nº 3)', 'https://www.example.com/legin/fed/lei.html')}</p>`);
  const amb = ['§ 1º', '§ 2º', '§ 3º'].map((s) => key(at(dou, s)));
  sameExceptNotes(nl, dou, new Set(amb));
  assert.equal(at(nl, 'Art. 2º', 'article').context, 'operative_candidate');
  for (const s of ['§ 1º', '§ 2º', '§ 3º']) { const x = at(nl, s); assert.deepEqual([x.context, x.contextReasons.at(-1)], ['unknown', 'normas_leg_note_ambiguous']); }
  assert.equal(notes(nl).length, 0, 'nothing cut');
  assert.equal(nl.limitations.filter((l) => l.code === 'normas_leg_note_ambiguous').length, 3);
});

test('cases 9, 11 and 28: no plan → refusal; forged/copied/stale plan → refusal; a forged class read as DOU changes nothing', () => {
  const html = page(`<p>§ 1º Texto. ${a('(Vide Lei nº 1)')}</p>`); const p = prep(enc(html));
  assert.throws(() => req(p.html, { source: 'NORMAS-LEG' }), NormasLegProvenanceError);
  assert.throws(() => req(p.html, { source: 'NORMAS-LEG', normasLeg: JSON.parse(JSON.stringify(p)) }), NormasLegProvenanceError, 'serialized copy');
  assert.throws(() => req(p.html, { source: 'NORMAS-LEG', normasLeg: { ...p } }), NormasLegProvenanceError, 'look-alike object');
  assert.throws(() => req(p.html.replace('Texto', 'Textx'), { source: 'NORMAS-LEG', normasLeg: p }), NormasLegProvenanceError, 'HTML changed after the preparation');
  assert.throws(() => req(p.html, { source: 'DOU', normasLeg: p }), /only valid for source NORMAS-LEG/u);
  const dou = readDOU(p.html); assert.equal(notes(dou).length, 0); assert.ok(dou.parts.every((x) => !x.contextReasons.some((c) => c.startsWith('normas_leg'))));
  assert.throws(() => prep(enc(html), { expected: { sha256: sha(enc(html)), bytes: enc(html).byteLength + 1 } }), (e: unknown) => e instanceof NormasLegPreparationError && e.code === 'identity_mismatch');
  assert.throws(() => prep(enc(html), { expected: { sha256: '0'.repeat(64), bytes: enc(html).byteLength } }), (e: unknown) => e instanceof NormasLegPreparationError && e.code === 'identity_mismatch');
});

test('cases 10, 14 and 29: only the "atualizada" representation is prepared; the original stays on the citation rules; another representation id is refused', () => {
  for (const f of ['lei-10637-2002-original', 'lei-10833-2003-original']) {
    const m = JSON.parse(readFileSync(`${DIR}${f}.meta.json`, 'utf8')) as { url: string; urn: string };
    assert.throws(() => prepareNormasLegPage({ resourceId: f, url: m.url, urn: m.urn, version: 'original', bytes: new Uint8Array(readFileSync(`${DIR}${f}.html`)) }),
      (e: unknown) => e instanceof NormasLegPreparationError && e.code === 'unsupported_version');
    const html = new TextDecoder().decode(readFileSync(`${DIR}${f}.html`)).replace(/^﻿/u, '');
    const dou = readDOU(html); assert.equal(notes(dou).length, 0, 'no new note on the original text');
  }
  const { p } = L637; assert.throws(() => req(p.html, { source: 'NORMAS-LEG', normasLeg: p }), NormasLegProvenanceError, 'representationId r1 is not the prepared resource');
  assert.throws(() => req(L833.p.html, { representationId: 'lei-10637-2002-atualizada', source: 'NORMAS-LEG', normasLeg: L637.p }), NormasLegProvenanceError, 'same URN family, other HTML');
});

test('case 12: eligibility with a synthetic NCM catalog — the candidate set after ⊆ before, nothing eligible (real files and a synthetic page)', () => {
  const syn = page(`<p>Art. 1º Fica reduzida a alíquota dos produtos classificados no código NCM 2201.10.00. ${a('(Redação dada pela Lei nº 1)')}</p>`
    + `<p>I - ${a('(Revogado pela Lei nº 2, que tratava do NCM 2202.10.00)')}</p><p>II - produtos do código NCM 2203.00.00;</p>`);
  const p = prep(enc(syn)); const catalog = { edition: 'synthetic', codes: ['22011000', '22021000', '22030000'] };
  const nl = readNL(p, catalog); const dou = readDOU(p.html, catalog);
  assert.ok(candidates(dou).size > 0); for (const c of candidates(nl)) assert.ok(candidates(dou).has(c), c);
  const inNote = [...candidates(dou)].find((c) => c.startsWith('ncm@') && dou.canonicalText.slice(Number(c.split('@')[1]!.split('-')[0])).startsWith('2202'));
  assert.ok(inNote, 'read as DOU, the NCM inside the revocation note is a candidate'); assert.ok(!candidates(nl).has(inNote), 'with the plan it is not');
  assert.ok(candidates(nl).size < candidates(dou).size);
  for (const { p: rp } of [L637, L833]) {
    const codes = [...new Set([...rp.html.matchAll(/\b(\d{4})\.(\d{2})(?:\.(\d{2}))?\b/gu)].map((m) => m.slice(1).join('')))].filter((c) => c.length >= 4 && c.length <= 8).slice(0, 40);
    const cat = { edition: 'synthetic', codes };
    const n = analyzeAnatomy({ publicationVersionId: 'v', referenceDate: '2026-11-07', ruleSet: { id: 't', version: '1' }, input: { source: 'NORMAS-LEG', representationId: rp.resource.resourceId, html: rp.html, normasLeg: rp }, catalog: cat });
    const d = analyzeAnatomy({ publicationVersionId: 'v', referenceDate: '2026-11-07', ruleSet: { id: 't', version: '1' }, input: { source: 'DOU', representationId: rp.resource.resourceId, html: rp.html }, catalog: cat });
    for (const c of candidates(n)) assert.ok(candidates(d).has(c), c); assert.ok(n.eligibility.every((e) => !e.eligible));
  }
});

test('case 13 (real 10.833 art. 94 "Ficam revogados"): a revoking device with its own text is operative text, not a note nor a placeholder', () => {
  const { nl, dou, p } = L833;
  const art = at(nl, 'Art. 94. Ficam revogados', 'article');
  assert.deepEqual([art.span, art.context, art.contextReasons], [at(dou, 'Art. 94. Ficam revogados', 'article').span, at(dou, 'Art. 94. Ficam revogados', 'article').context, at(dou, 'Art. 94. Ficam revogados', 'article').contextReasons]);
  assert.ok(!p.plan.blocks.some((b) => b.htmlSpan.start <= 379758 && b.htmlSpan.end >= 379883), 'no planned block over §6 [379758, 379883)');
});

test('cases 17 and 23: an unclosed note and a note between two sentences are ambiguous; nothing is cut', () => {
  const { nl, dou } = both(`<p>§ 1º Texto do parágrafo. ${a('(Redação dada pela Lei nº 1,')}</p><p>§ 2º Primeira frase. ${a('(Redação dada pela Lei nº 2)')} Segunda frase operativa.</p>`);
  sameExceptNotes(nl, dou, new Set(['§ 1º', '§ 2º'].map((s) => key(at(dou, s)))));
  assert.deepEqual(['§ 1º', '§ 2º'].map((s) => at(nl, s).context), ['unknown', 'unknown']); assert.equal(notes(nl).length, 0);
  const p = prep(enc(page(`<p>§ 1º Texto do parágrafo. ${a('(Redação dada pela Lei nº 1,')}</p><p>§ 2º Primeira frase. ${a('(Redação dada pela Lei nº 2)')} Segunda frase operativa.</p>`)));
  assert.deepEqual(p.plan.blocks.map((b) => b.ambiguous?.code), ['unclosed', 'not_last']);
});

test('cases 18 and 19: a look-alike Câmara host and a relative href are not note anchors; the legacy camara.gov.br LegIn viewer is (measured)', () => {
  assert.equal(isCamaraNoteHref('https://camara.leg.br.example/legin/x.html', URL0), false);
  assert.equal(isCamaraNoteHref('https://evilcamara.leg.br/legin/x.html', URL0), false);
  assert.equal(isCamaraNoteHref('/legin/fed/lei.html', URL0), false, 'relative href resolves to normas.leg.br');
  assert.equal(isCamaraNoteHref('(Inciso%20acrescido%20pela%20Lei)', URL0), false, 'broken href (real case) resolves to normas.leg.br');
  assert.equal(isCamaraNoteHref('ftp://www2.camara.leg.br/legin/x', URL0), false);
  assert.equal(isCamaraNoteHref('http://www2.camara.gov.br/internet/legislacao/legin.html/textos/visualizarTexto.html?ideNorma=1', URL0), true);
  assert.equal(isCamaraNoteHref('http://www2.camara.leg.br/internet/legislacao/legin.html/textos/visualizarTexto.html', URL0), false, 'the legacy viewer is accepted only on camara.gov.br');
  const { nl } = both(`<p>§ 1º Texto. ${a('(Incluído pela Lei nº 1)', 'https://camara.leg.br.example/legin/x.html')}</p><p>§ 2º Texto. ${a('(Incluído pela Lei nº 2)', '/legin/fed/x.html')}</p>`);
  assert.deepEqual(['§ 1º', '§ 2º'].map((s) => at(nl, s).context), ['unknown', 'unknown']); assert.equal(notes(nl).length, 0);
});

test('cases 20, 21 and 22: entities inside the word, a BOM and a non-BMP character keep exact UTF-16 and byte regions', () => {
  const body = `<p>Art. 1º Texto com 😀 antes da região.</p><p>§ 1º Texto. ${a('(Reda&ccedil;&atilde;o dada pela Lei nº 1)')}</p>`;
  const html = page(body); const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(html)]);
  const p = prep(withBom); const n = p.plan.blocks[0]!.notes[0]!;
  assert.deepEqual([p.resource.bomPresent, p.html === html], [true, true]);
  assert.equal(n.text, '(Redação dada pela Lei nº 1)', 'decoded for the grammar');
  assert.equal(p.html.slice(n.region.htmlSpan.start, n.region.htmlSpan.end).includes('&ccedil;'), true, 'raw region keeps the entity');
  const before = p.html.slice(0, n.region.htmlSpan.start);
  assert.equal(n.region.byteSpan.start, 3 + enc(before).byteLength, 'bytes = BOM + UTF-8 of the prefix (😀 = 4 bytes, 2 UTF-16 units)');
  assert.equal(sha(withBom.subarray(n.region.byteSpan.start, n.region.byteSpan.end)), n.region.sha256);
  const nl = readNL(p); const x = notes(nl)[0]!;
  assert.equal(textOf(nl, x.id), '(Redação dada pela Lei nº 1)');
  assert.deepEqual(x.sourcePointers[0]!.sourceSpan, n.anchors[0]!.htmlSpan);
});

test('case 25: a citation of an earlier wording (quoted amendment with "(NR)") gets no note and keeps the citation rules', () => {
  const { nl, dou } = both(`<p>Art. 3º O art. 1º da Lei nº 9 passa a vigorar com a seguinte redação:</p><p>“Art. 1º Nova redação do dispositivo citado.” (NR)</p>`);
  sameExceptNotes(nl, dou); assert.equal(notes(nl).length, 0);
});

test('case 27: revoked text preserved with a revocation note is NOT a placeholder; a label-only revoked device is', () => {
  const { nl, dou } = both(`<p>§ 2º Texto preservado pela compilação. ${a('(Revogado pela Lei nº 1)')}</p><p>§ 3º ${a('(Revogado pela Lei nº 1)')}</p><p>§ 4º ${a('(Vide Lei nº 2)')}</p>`);
  assert.deepEqual(['§ 2º', '§ 3º', '§ 4º'].map((s) => [at(nl, s).context, at(nl, s).contextReasons.at(-1)]),
    [['operative_candidate', at(dou, '§ 2º').contextReasons.at(-1)], ['prohibited', 'normas_leg_revoked_placeholder'], ['unknown', 'normas_leg_note_ambiguous']]);
  assert.equal(notes(nl).length, 2, 'the label-only Vide block is ambiguous and nothing is cut there');
});

test('§11 on the real files: text, sourceMap and coverage unchanged; only planned blocks change, never upwards; caput continuation kept; counts measured', () => {
  for (const [{ nl, dou, p }, expected] of [[L637, { notes: 106, anchors: 134, placeholders: 23, ambiguous: 30 }], [L833, { notes: 314, anchors: 391, placeholders: 40, ambiguous: 3 }]] as const) {
    assert.deepEqual(p.plan.counts, expected, 'design §12 numbers, regenerated here');
    assert.equal(notes(nl).length, expected.notes);
    const planned = new Set(p.plan.blocks.map((b) => b.htmlSpan.start));
    const allowed = new Set<string>();
    for (const x of nl.parts) if (x.contextReasons.includes('normas_leg_revoked_placeholder') || x.contextReasons.includes('normas_leg_note_ambiguous')) allowed.add(key(x));
    sameExceptNotes(nl, dou, allowed);
    const d = byRegion(dou);
    for (const k of allowed) { const before = d.get(k)!.context; const after = byRegion(nl).get(k)!.context; assert.ok(before === after || (before === 'operative_candidate' && ['prohibited', 'unknown'].includes(after)) || (before === 'unknown' && after === 'unknown'), `${k}: ${before} → ${after}`); }
    for (const x of nl.parts.filter((y) => allowed.has(key(y)))) assert.ok(x.sourcePointers.some((s) => s.sourceSpan && planned.has(s.sourceSpan.start)), `${key(x)} changed only through a planned block`);
    assert.deepEqual([nl.coverage.textLength, nl.coverage.accountedLength], [dou.coverage.textLength, dou.coverage.accountedLength]);
    assert.ok(nl.parts.every((x) => x.legalStatus === 'unknown' && x.context !== 'historical'));
    for (const x of notes(nl)) { const parent = nl.parts.find((y) => y.id === x.parentId)!; assert.ok(parent.span.start <= x.span.start && x.span.end <= parent.span.end); }
    const caputs = (r: AnatomyResult) => r.parts.filter((x) => x.type === 'caput').map((x) => `${x.span.start}-${x.span.end}:${x.contextReasons.includes('caput_continuation')}`);
    assert.deepEqual(caputs(nl), caputs(dou), 'D02 caput continuation is not closed by the notes');
    assert.ok(nl.limitations.some((l) => l.code === 'normas_leg_local_preparation_only'));
    assert.ok(!nl.limitations.some((l) => l.code === 'normas_leg_plan_block_unmatched'));
    assert.equal(verifyNormasLegPreparation(p, p.html, p.resource.resourceId), true);
  }
});

test('preparation refuses a non-HTTPS URL, another host, a bad URN and non-UTF-8 bytes', () => {
  const b = enc(page('<p>x</p>'));
  const code = (over: Partial<Parameters<typeof prepareNormasLegPage>[0]>, bytes = b) => { try { prep(bytes, over); return 'ok'; } catch (e) { return (e as NormasLegPreparationError).code; } };
  assert.deepEqual([code({ url: URL0.replace('https', 'http') }), code({ url: 'https://normas.leg.br.example/x' }), code({ url: 'https://normas.leg.br:8443/x' }), code({ urn: 'lei 10637' }), code({}, new Uint8Array([0xff, 0xfe]))],
    ['not_https', 'not_normas_leg_host', 'not_normas_leg_host', 'invalid_urn', 'not_utf8']);
});

test('regression of the other sources: payload digests without identity are identical to the baseline recorded before the change', () => {
  const base = JSON.parse(readFileSync(REGRESSION_BASELINE, 'utf8')) as ReturnType<typeof computeRegression>;
  assert.deepEqual(computeRegression(), base);
  assert.equal(base.cases.length, 37);
});
