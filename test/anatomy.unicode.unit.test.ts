import assert from 'node:assert/strict';
import test from 'node:test';
import { anatomyOutputHash, sha256, validateAnatomyResult, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { extractAnatomyEntities } from '../src/modules/anatomy/entities.js';
import { anatomyResultToPrediction } from '../src/modules/anatomy/evaluation-adapter.js';
import { aggregate, evaluateEntry } from '../src/modules/anatomy/evaluation.js';
import { ANATOMY_GOLD_VERSION, type AnatomyGold } from '../src/modules/anatomy/gold.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, ProfileValidationError, validateProfile } from '../src/modules/anatomy/profile.js';
import { isNonNfcText, NON_NFC_TEXT, readAnatomyInput } from '../src/modules/anatomy/readers.js';

// ANAT-UNICODE-01a (issue #116): containment of non-NFC documents. SYNTHETIC inputs only.
const NFD = (s: string) => s.normalize('NFD');
const req = (html: string, source: AnatomyRequest['input']['source'] = 'RFB', extra: Partial<AnatomyRequest> = {}): AnatomyRequest => ({
  publicationVersionId: 'synthetic', referenceDate: '2026-10-20', ruleSet: { id: 'synthetic', version: '1' },
  input: { source, representationId: 'synthetic://unicode', html }, catalog: { edition: 'synthetic', codes: ['84713012', '84714100', '84719000', '8471'] }, ...extra });
const codes = (r: AnatomyResult) => r.limitations.map((l) => l.code);
function assertQuarantined(r: AnatomyResult, label: string) {
  assert.equal(r.status, 'partial', label);
  assert.ok(codes(r).includes(NON_NFC_TEXT), label);
  assert.deepEqual(r.entities, [], `${label}: no entities or relations`);
  assert.equal(r.eligibility.filter((e) => e.eligible).length, 0, `${label}: no positive selection`);
  assert.equal(r.eligibility.filter((e) => e.purpose === 'ncm').length, 0, `${label}: no NCM eligibility entries`);
}

test('UNICODE-01a: the NFD exception that was complete is now partial, non_nfc_text, with no entities', () => {
  const html = '<p>Art. 1º NCM 8471.41.00, excluída a NCM 8471.30.12.</p>';
  const nfc = analyzeAnatomy(req(html));
  assert.ok(nfc.entities.some((e) => e.domain === 'NCM_EXCEPTION'), 'NFC: exception relation recognised');
  assert.ok(!codes(nfc).includes(NON_NFC_TEXT));
  const nfd = analyzeAnatomy(req(NFD(html)));
  assertQuarantined(nfd, 'NFD exception');
  assert.ok(nfd.parts.some((p) => p.type === 'article'), 'structure stays available for inspection');
  const lim = nfd.limitations.find((l) => l.code === NON_NFC_TEXT)!;
  assert.deepEqual(lim.span, { start: 0, end: nfd.canonicalText.length });
  assert.match(lim.message, /extraction was not performed/);
});

test('UNICODE-01a: quarantine covers the whole document, including codes in NFC passages', () => {
  const nfcPart = '<p>Art. 1º Conforme Resolução nº 10, NCM 8471.41.00 até 8471.90.00.</p><table><tr><td>CÓDIGO NCM</td></tr><tr><td>8471.30.12</td></tr></table>';
  const mixedPart = `<p>Art. 2º NCM 8471, ${NFD('excluída')} a NCM 8471.30.12.</p>`;
  const r = analyzeAnatomy(req(nfcPart + mixedPart));
  assert.equal(analyzeAnatomy(req(nfcPart)).entities.filter((e) => e.domain === 'NCM').length > 0, true, 'the NFC part alone yields codes');
  assertQuarantined(r, 'mixed document');
  // Mixed forms inside one paragraph.
  assertQuarantined(analyzeAnatomy(req(`<p>Art. 1º Cláusula NCM 8471.41.00, ${NFD('excluída')} a NCM 8471.30.12 e Instrução Normativa 5.</p>`)), 'mixed paragraph');
});

test('UNICODE-01a: detection uses the NFC comparison (not a search for \\p{M}) across edge cases', () => {
  const flagged: [string, string][] = [
    ['decomposed accent', 'Cláusula'],
    ['emoji before decomposed accent', '😀é'],
    ['decomposed accent before emoji', 'é😀'],
    ['canonical singleton (Angstrom sign)', 'NCM Å 8471.30.12'],
    ['canonical singleton (Ohm sign)', 'Ω'],
    ['decomposed Hangul jamo', '가'],
    ['non-canonical mark order', 'ạ́'],
  ];
  const clean: [string, string][] = [
    ['NFC accents', 'Cláusula até'], ['NFC Hangul', '가'], ['astral characters', '𝔸 😀 👩‍💻 NCM'], ['combining mark without precomposed form', 'q́'],
    ['initial combining mark', '́abc'], ['empty', ''], ['lone surrogate', '\ud800x'],
  ];
  for (const [name, s] of flagged) assert.equal(isNonNfcText(s), true, name);
  for (const [name, s] of clean) assert.equal(isNonNfcText(s), false, name);
  for (const [name, s] of flagged) assertQuarantined(analyzeAnatomy(req(`<p>Art. 1º ${s} NCM 8471.30.12.</p>`)), name);
  for (const [name, s] of clean) assert.ok(!codes(analyzeAnatomy(req(`<p>Art. 1º ${s} NCM 8471.30.12.</p>`))).includes(NON_NFC_TEXT), name);
  // Empty input keeps its own diagnostics and is not flagged.
  const empty = analyzeAnatomy(req(''));
  assert.ok(codes(empty).includes('missing_body') && !codes(empty).includes(NON_NFC_TEXT));
});

test('UNICODE-01a: text, hashes and positions are the supplied ones; other diagnostics are kept', () => {
  const html = NFD('<p>Art. 1º Produtos da posição NCM 8471.</p>');
  const r = analyzeAnatomy(req(html, 'RFB', { attachments: [{ resourceId: 'synthetic-annex', sha256: null, state: 'missing' }] }));
  assertQuarantined(r, 'with missing resource');
  assert.equal(r.canonicalText, NFD('Art. 1º Produtos da posição NCM 8471.\n'), 'canonical text is not normalised');
  assert.equal(r.identity.inputTextHash, sha256(r.canonicalText));
  assert.equal(r.identity.inputPresentationHash, sha256(html));
  assert.equal(r.coverage.textLength, r.canonicalText.length);
  assert.ok(codes(r).includes('missing_resources'), 'missing resources still reported');
  const art = r.parts.find((p) => p.type === 'article')!;
  assert.equal(r.canonicalText.slice(art.span.start, art.span.end), NFD('Art. 1º Produtos da posição NCM 8471.\n').slice(art.span.start, art.span.end));
  // Plain text input and markup-only non-NFC (attributes) are flagged too.
  assert.ok(codes(readAnatomyInput({ source: 'RFB', representationId: 'x', text: NFD('ação') })).includes(NON_NFC_TEXT));
  const attr = readAnatomyInput({ source: 'CONFAZ', representationId: 'x', html: `<p class="${NFD('Redação')}">NCM 8471.30.12</p>` });
  const lim = attr.limitations.find((l) => l.code === NON_NFC_TEXT)!;
  assert.equal(attr.status, 'partial'); assert.equal(lim.span, null);
  // The contract validator accepts the limitation and refuses an improper "complete".
  validateAnatomyResult(r);
  const forced = structuredClone(r); forced.status = 'complete'; forced.outputHash = anatomyOutputHash(forced);
  assert.throws(() => validateAnatomyResult(forced));
});

test('UNICODE-01a: layer responsibilities — reader flags, engine skips, direct extraction refuses', () => {
  const text = NFD('NCM 8471.41.00, excluída a NCM 8471.30.12.');
  const read = readAnatomyInput({ source: 'RFB', representationId: 'x', html: `<p>${text}</p>` });
  assert.ok(read.limitations.some((l) => l.code === NON_NFC_TEXT));
  assert.throws(() => extractAnatomyEntities({ canonicalText: read.canonicalText, parts: read.parts }), /non_nfc_text/);
  // Configuration in NFD stays refused (configuration rule), independently of document detection.
  assert.throws(() => validateProfile({ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' }, fields: { labels: { clause: [NFD('Cláusula')] } } }), ProfileValidationError);
});

test('UNICODE-01a: adapter and evaluator carry non_nfc_text as pending, never as completeness', () => {
  const r = analyzeAnatomy(req(NFD('<p>Art. 1º NCM 8471.41.00, excluída a NCM 8471.30.12.</p>')));
  const p = anatomyResultToPrediction(r, { selections: [] });
  assert.equal(p.pending!.status, 'partial');
  assert.ok(p.pending!.limitations.some((l) => l.code === NON_NFC_TEXT));
  const text = r.canonicalText;
  const gold: AnatomyGold = { goldVersion: ANATOMY_GOLD_VERSION, id: '97', partition: 'development', preparation: 'synthetic/1', canonicalTextSha256: '0'.repeat(64),
    canonicalTextUtf16Length: text.length, status: 'prepared', annotator: 'synthetic', annotatedAt: '2026-10-20',
    parts: [{ id: 'd', parentId: null, order: 0, type: 'document', span: { start: 0, end: text.length }, context: 'unknown', contextReason: 'document', table: null }],
    entities: [{ id: 'g', partId: 'd', span: { start: text.indexOf('8471.41.00'), end: text.indexOf('8471.41.00') + 10 }, literal: '8471.41.00', domain: 'NCM', note: '' }],
    relations: [], gaps: [], review: { reviewer: null, status: 'requested', reviewedAt: null, approvedContentSha256: null, notes: '' } };
  const e = evaluateEntry('97', 'SYN', gold, p);
  assert.ok(e.pending!.limitations.some((l) => l.code === NON_NFC_TEXT));
  assert.deepEqual([e.R1.tp, e.R1.fn], [0, 1], 'no NCM credit from a quarantined document: the gold code counts as missed, not as complete');
  const agg = aggregate([e]);
  const group = Object.values(agg)[0]!;
  assert.ok(group.pending.nonCompleteEntries.includes('97') && group.pending.entriesWithPending.includes('97'));
});

// Review U01A-R1-01 (PR #250): a class decoded from character references can be non-NFC while both the raw markup
// and the canonical text are NFC. Reproduction with a valid profile that adds the NFC class "Histórica".
test('UNICODE-01a R1-01: decoded non-NFC attributes (character references) are detected and quarantined', () => {
  const profiles = structuredClone([...DEFAULT_PROFILES]) as typeof DEFAULT_PROFILES[number][];
  const confaz = profiles.find((p) => p.scope.level === 'source' && p.scope.source === 'CONFAZ')! as { fields: { classes: { historical: string[] } } };
  confaz.fields.classes.historical.push('Histórica');
  const run = (html: string) => analyzeAnatomy(req(html, 'CONFAZ', { profiles }));
  const clause = 'Cláusula primeira NCM 8471.30.12.';
  // NFC classes, literal or encoded (&#xF3; / &#243; decode to the precomposed ó): recognised as historical, no flag.
  for (const cls of ['Histórica', 'Hist&#xF3;rica', 'Hist&#243;rica']) {
    for (const html of [`<p class="${cls}">${clause}</p>`, `<div class="${cls}"><p>${clause}</p></div>`]) {
      const r = run(html);
      assert.ok(!codes(r).includes(NON_NFC_TEXT), html);
      assert.equal(r.parts.find((p) => p.type === 'clause')?.context, 'historical', html);
    }
  }
  // Non-NFC classes: literal NFD, decimal &#769; and hexadecimal &#x301; — on the block, an ancestor and a descendant.
  for (const cls of ['Histórica', 'Histo&#769;rica', 'Histo&#x301;rica']) {
    for (const html of [`<p class="${cls}">${clause}</p>`, `<div class="${cls}"><p>${clause}</p></div>`, `<p>${clause}<span class="${cls}">x</span></p>`]) {
      const raw = html;
      const r = run(raw);
      assertQuarantined(r, html);
      assert.equal(r.identity.inputPresentationHash, sha256(raw), 'presentation untouched');
      assert.equal(r.canonicalText, r.canonicalText.normalize('NFC'), 'text itself is NFC: the attribute alone triggers');
      if (!cls.includes('́')) assert.equal(r.limitations.find((l) => l.code === NON_NFC_TEXT)!.span, null);
    }
  }
  // Any other decoded attribute is covered too (superset of the consumed class attribute).
  assertQuarantined(run(`<p title="a&#x301;">${clause}</p>`), 'title attribute');
});
