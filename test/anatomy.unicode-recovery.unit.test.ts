import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sha256, validateAnatomyResult, type AnatomyResult } from '../src/modules/anatomy/contract.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { extractAnatomyEntities, extractRecoveredEntities } from '../src/modules/anatomy/entities.js';
import { anatomyResultToPrediction } from '../src/modules/anatomy/evaluation-adapter.js';
import { NfcQuarantineError } from '../src/modules/anatomy/nfc-recovery.js';
import { DEFAULT_PROFILES } from '../src/modules/anatomy/profile.js';
import { readAnatomyInput, shadowContextOf } from '../src/modules/anatomy/readers.js';

// ANAT-UNICODE-01b/B2 (issue #116, COORD authorisation 6315618204). SYNTHETIC inputs only; Node 24 / Unicode 17.0.
const NFD = (s: string) => s.normalize('NFD');
const req = (html: string, source: AnatomyRequest['input']['source'] = 'RFB', extra: Partial<AnatomyRequest> = {}): AnatomyRequest => ({
  publicationVersionId: 'synthetic', referenceDate: '2026-10-21', ruleSet: { id: 'synthetic', version: '1' },
  input: { source, representationId: 'synthetic://b2', html }, catalog: { edition: 'synthetic', codes: ['84713012', '84714100', '84719000', '8471'] }, ...extra });
const codes = (r: AnatomyResult) => r.limitations.map((l) => l.code);
const view = (r: AnatomyResult) => ({
  parts: r.parts.map((p) => `${p.type}:${p.context}:${p.contextReasons.join('+')}`),
  entities: r.entities.map((e) => ({ domain: e.domain, normalized: e.domain.startsWith('NCM') ? e.normalized : e.normalized.normalize('NFC'),
    validation: e.validation.status, relation: e.relation && { kind: e.relation.kind, operator: e.relation.operator,
      condition: e.relation.condition?.normalize('NFC') ?? null, targets: e.relation.targetEntityIds.length } })) });
function assertRecovered(r: AnatomyResult, label: string) {
  validateAnatomyResult(r);
  assert.equal(r.status, 'partial', label);
  assert.ok(codes(r).includes('non_nfc_text') && codes(r).includes('nfc_shadow_matching'), `${label}: ${codes(r).join(',')}`);
  assert.equal(r.eligibility.filter((e) => e.eligible).length, 0, `${label}: zero positive selections`);
  for (const e of r.entities) assert.equal(r.canonicalText.slice(e.span.start, e.span.end), e.literal, `${label}: original literal`);
}
function assertQuarantined(r: AnatomyResult, label: string, code?: string) {
  validateAnatomyResult(r);
  assert.equal(r.status, 'partial', label);
  assert.ok(codes(r).includes('non_nfc_text') || (code !== undefined && codes(r).includes(code)), `${label}: ${codes(r).join(',')}`);
  if (code) assert.ok(codes(r).includes(code), `${label}: expects ${code} in ${codes(r).join(',')}`);
  assert.deepEqual(r.entities, [], `${label}: no entities or relations`);
  assert.equal(r.eligibility.filter((e) => e.purpose === 'ncm').length, 0, `${label}: no NCM eligibility`);
  assert.equal(r.eligibility.filter((e) => e.eligible).length, 0, label);
}

test('B2: recovery of clause, preamble, rectification, citation, revenue code, NCM header, range and exception', () => {
  const cases: [string, AnatomyRequest['input']['source'], string][] = [
    ['clause', 'CONFAZ', '<p>Cl\u00e1usula primeira NCM 8471.30.12.</p>'],
    ['preamble', 'DOU', '<p>A Secret\u00e1ria Executiva resolve NCM 8471.30.12</p><p>Art. 1\u00ba NCM 8471.41.00.</p>'],
    ['rectification', 'DOU', '<p>Onde se l\u00ea: NCM 8471.30.12</p><p>Leia-se: NCM 8471.41.00</p>'],
    ['citation and revenue code', 'RFB', '<p>Art. 1\u00ba Conforme Resolu\u00e7\u00e3o n\u00ba 8471.30.12 e C\u00f3digo de receita 1234, NCM 8471.41.00.</p>'],
    ['NCM header', 'RFB', '<table><tr><td>C\u00d3DIGO NCM</td><td>Descri\u00e7\u00e3o</td></tr><tr><td>8471.30.12</td><td>M\u00e1quinas</td></tr></table>'],
    ['range with ate', 'RFB', '<p>Art. 1\u00ba NCM 8471.30.12 at\u00e9 8471.41.00.</p>'],
    ['exception excluida', 'RFB', '<p>Art. 1\u00ba NCM 8471, exclu\u00edda a NCM 8471.30.12.</p>'],
    ['mixed document', 'RFB', `<p>Art. 1\u00ba Cl\u00e1usula NCM 8471.41.00 at\u00e9 8471.90.00.</p><p>Art. 2\u00ba NCM 8471, ${NFD('exclu\u00edda')} a NCM 8471.30.12.</p>`],
  ];
  for (const [name, source, html] of cases) {
    const nfc = analyzeAnatomy(req(html.normalize('NFC'), source));
    assert.ok(!codes(nfc).includes('non_nfc_text'), `${name}: NFC control`);
    const nfd = analyzeAnatomy(req(NFD(html), source));
    assertRecovered(nfd, name);
    assert.deepEqual(view(nfd), view(nfc), `${name}: same recognition as the NFC equivalent`);
    assert.ok(nfd.entities.length > 0 || name === 'rectification', `${name}: something recognised`);
  }
});

test('B2: original sourceMap, spans, literals and hashes; entities after emoji and reordering are exact', () => {
  const html = '<p>Art. 1\u00ba \u{1F469}\u200d\u{1F4BB} a\u0301\u0323 NCM 8471.30.12, exclui\u0301da a NCM 8471.41.00.</p>';
  const r = analyzeAnatomy(req(html));
  assertRecovered(r, 'emoji and reordering');
  assert.equal(r.identity.inputPresentationHash, sha256(html));
  assert.equal(r.identity.inputTextHash, sha256(r.canonicalText));
  const read = readAnatomyInput({ source: 'RFB', representationId: 'synthetic://b2', html });
  assert.equal(r.canonicalText, read.canonicalText, 'canonical text is the supplied text');
  assert.deepEqual(r.sourceMap, read.sourceMap);
  for (const code of ['8471.30.12', '8471.41.00']) {
    const e = r.entities.find((x) => x.domain === 'NCM' && x.literal === code)!;
    assert.equal(e.span.start, r.canonicalText.indexOf(code), `${code} at its original UTF-16 offset`);
  }
  const exc = r.entities.find((e) => e.domain === 'NCM_EXCEPTION')!;
  assert.equal(exc.relation!.operator, 'exclu\u00edda', 'operator: derived NFC form');
  assert.equal(exc.relation!.condition, r.canonicalText.slice(r.canonicalText.indexOf('exclui\u0301da'), exc.span.end), 'condition: original slice');
  assert.match(exc.literal, /exclui\u0301da/u, 'literal stays decomposed');
  // Relations reference existing entities only (no dangling or duplicated identities).
  const ids = new Set(r.entities.map((e) => e.id));
  assert.equal(ids.size, r.entities.length);
  for (const e of r.entities) for (const t of e.relation?.targetEntityIds ?? []) assert.ok(ids.has(t), t);
});

test('B2: whole-document quarantine for unsafe boundaries, attributes, widening and late failures', () => {
  const quarantined: [string, string, string | undefined, AnatomyRequest['input']['source']?][] = [
    ['Hangul L|V across nodes', '<p>Art. 1\u00ba <b>\u1100</b>\u1161 NCM 8471.30.12.</p>', 'nfc_shadow_unusable'],
    ['Hangul LV|T across nodes', '<p>Art. 1\u00ba <b>\uac00</b>\u11a8 NCM 8471.30.12.</p>', 'nfc_shadow_unusable'],
    ['accent across nodes', '<p>Art. 1\u00ba <b>Cla</b>\u0301usula NCM 8471.30.12.</p>', 'nfc_shadow_unusable'],
    ['reordering across nodes', '<p>Art. 1\u00ba <b>a\u0301</b>\u0323 NCM 8471.30.12.</p>', 'nfc_shadow_unusable'],
    ['NFD attribute literal', `<p class="${NFD('Reda\u00e7\u00e3o')}">Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.30.12.</p>`, undefined],
    ['NFD attribute decimal', `<p title="a&#769;">Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.30.12.</p>`, undefined],
    ['NFD attribute hexadecimal', `<p title="a&#x301;">Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.30.12.</p>`, undefined],
    // Entity widening: a code followed by a combining mark that does not compose (the mark is in the code's segment).
    ['widened entity', `<p>Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.30.12\u0359 e 8471.41.00.</p>`, 'nfc_span_widened'],
    // Operator widening, discovered after the codes were mapped (late failure): the whole extraction is discarded.
    ['widened operator (late)', `<p>Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.41.00, exceto\u0359 8471.30.12.</p>`, 'nfc_span_widened'],
  ];
  for (const [name, html, code] of quarantined) {
    const r = analyzeAnatomy(req(html));
    assertQuarantined(r, name, code);
    assert.ok(r.parts.length > 0, `${name}: structure stays available`);
    assert.equal(r.canonicalText, readAnatomyInput({ source: 'RFB', representationId: 'x', html }).canonicalText);
  }
  // The operator case: the codes alone would be recognised; none is published (never "codes without the exception").
  const late = analyzeAnatomy(req(`<p>Art. 1\u00ba ${NFD('Cl\u00e1usula')} NCM 8471.41.00, exceto\u0359 8471.30.12.</p>`));
  assert.ok(late.limitations.find((l) => l.code === 'nfc_span_widened')!.message.includes('was not performed'));
  // Markup-only non-NFC with NFC text stays out of scope (quarantine), as in 01a.
  assertQuarantined(analyzeAnatomy(req('<p title="a&#x301;">Art. 1\u00ba NCM 8471.30.12.</p>')), 'attribute only');
});

test('B2: incompatible runtime keeps the quarantine (fail closed), NFC documents are unaffected', () => {
  const html = NFD('<p>Art. 1\u00ba NCM 8471.41.00, exclu\u00edda a NCM 8471.30.12.</p>');
  const saved = Object.getOwnPropertyDescriptor(process.versions, 'unicode')!;
  Object.defineProperty(process.versions, 'unicode', { ...saved, value: '16.0' });
  try {
    assertQuarantined(analyzeAnatomy(req(html)), 'runtime 16.0', 'unicode_runtime_unsupported');
    const nfc = analyzeAnatomy(req(html.normalize('NFC')));
    assert.ok(nfc.entities.some((e) => e.domain === 'NCM_EXCEPTION') && !codes(nfc).some((c) => c.startsWith('nfc_') || c === 'unicode_runtime_unsupported'));
  } finally { Object.defineProperty(process.versions, 'unicode', saved); }
  assertRecovered(analyzeAnatomy(req(html)), 'runtime restored');
});

test('B2: NFC path never uses the shadow and reproduces the pre-B2 engine (q\\u0301, lone surrogate + mark, emoji ZWJ)', () => {
  const frozen = JSON.parse(readFileSync(new URL('./fixtures/anatomy/unicode-b2-nfc-equivalence.json', import.meta.url), 'utf8')).documents as { id: string; s: unknown }[];
  const docs: Record<string, [AnatomyRequest['input']['source'], string]> = {
    'q-mark': ['RFB', '<p>Art. 1\u00ba q\u0301 NCM 8471.30.12, exceto 8471.41.00.</p>'],
    'lone-surrogate-mark': ['RFB', '<p>Art. 1\u00ba \ud800\u0301 NCM 8471.30.12 at\u00e9 8471.41.00.</p>'],
    'emoji-zwj': ['CONFAZ', '<p>Cl\u00e1usula primeira \u{1F469}\u200d\u{1F4BB} NCM 8471.30.12.</p>'],
  };
  for (const { id, s } of frozen) {
    const [source, html] = docs[id]!;
    const request = { publicationVersionId: 's', referenceDate: '2026-10-21', ruleSet: { id: 's', version: '1' }, input: { source, representationId: `s://${id}`, html }, catalog: { edition: 's', codes: ['84713012', '84714100'] } };
    const { identity: _i, analysisId: _a, outputHash: _o, ...structure } = analyzeAnatomy(request);
    assert.deepEqual(JSON.parse(JSON.stringify(structure)), s, id);
    assert.equal(shadowContextOf(readAnatomyInput({ source, representationId: 'x', html })), undefined, `${id}: no shadow context`);
  }
});

test('B2: no bypass — direct extraction refuses non-NFC, forged or copied reader results carry no context', () => {
  const html = NFD('<p>NCM 8471.41.00, exclu\u00edda a NCM 8471.30.12.</p>');
  const read = readAnatomyInput({ source: 'RFB', representationId: 'x', html });
  assert.ok(shadowContextOf(read), 'the reader built a context for its own result');
  assert.throws(() => extractAnatomyEntities({ canonicalText: read.canonicalText, parts: read.parts }), /non_nfc_text/);
  assert.throws(() => extractRecoveredEntities(structuredClone(read), {}), NfcQuarantineError, 'a copy has no context');
  assert.throws(() => extractRecoveredEntities({ canonicalText: read.canonicalText, parts: read.parts }, {}), NfcQuarantineError, 'a forged object has no context');
  // Request options cannot carry a map, a hash or a Unicode version (strict request schema).
  assert.throws(() => analyzeAnatomy({ ...req(html), nfcShadow: { usable: true } } as never));
  // Profile protections still apply on the recovery path (shipped floor).
  const weakened = structuredClone([...DEFAULT_PROFILES]) as { scope: { level: string; source?: string }; fields: { exceptions?: { markers: string[] } } }[];
  weakened.find((p) => p.scope.level === 'default')!.fields.exceptions!.markers = ['salvo'];
  assert.throws(() => analyzeAnatomy(req(html, 'RFB', { profiles: weakened })), (e: unknown) => (e as { code?: string }).code === 'protection_weakened');
});

test('B2: adapter and evaluator keep partial + diagnostics; an NFC operator absent from the NFD literal stays unresolved', () => {
  const r = analyzeAnatomy(req(NFD('<p>Art. 1\u00ba NCM 8471.41.00, exclu\u00edda a NCM 8471.30.12.</p>')));
  const p = anatomyResultToPrediction(r, { selections: [] });
  assert.equal(p.pending!.status, 'partial');
  assert.ok(p.pending!.limitations.some((l) => l.code === 'nfc_shadow_matching'));
  const exc = p.relations.find((x) => x.kind === 'exception')!;
  assert.equal(exc.operatorSpan, null, 'no guessed operator span');
  assert.ok(p.pending!.unresolved.some((u) => u.kind === 'operator_span'), 'kept as pending');
});

// Review B2-R1 (PR #253, BLOCK on 69a8229). Synthetic reproductions of both findings.
test('B2-R1-01: no exported way to attach a recovery context to a result the reader refused', async () => {
  const recovery = await import('../src/modules/anatomy/nfc-recovery.js');
  assert.equal('registerShadowContext' in recovery, false, 'no exported setter');
  const readers = await import('../src/modules/anatomy/readers.js');
  assert.deepEqual(Object.keys(readers).filter((k) => /regist|issue|attach/iu.test(k)), [], 'no setter on the reader either');
  const { buildNfcShadow } = await import('../src/modules/anatomy/nfc-shadow.js');
  const read = readAnatomyInput({ source: 'DOU', representationId: 'synthetic://forge', html: '<p class="Histo&#769;rica">Art. 1º NCM 8471.30.12.</p>' });
  assert.ok(read.limitations.some((l) => l.code === 'non_nfc_text'));
  assert.equal(shadowContextOf(read), undefined, 'a refused document has no context');
  void buildNfcShadow(read.canonicalText); // building a map by hand gives no way to register it
  assert.throws(() => extractRecoveredEntities(read, {}), NfcQuarantineError);
  assert.equal(recovery.decideRecovery(read.canonicalText, [], true).mode, 'quarantine', 'the decision itself refuses non-NFC attributes');
});

test('B2-R1-02: a recovered span that crosses an incompatible part quarantines the whole document', () => {
  const sig = '<p>Art. 1º ' + 'Resolução'.normalize('NFD') + '</p><p class="assina">8471.30.12</p><p>Art. 2º NCM 8471.41.00.</p>';
  const r = analyzeAnatomy(req(sig, 'DOU'));
  assertQuarantined(r, 'citation into signature', 'nfc_shadow_unusable');
  assert.match(r.limitations.find((l) => l.code === 'nfc_shadow_unusable')!.message, /crosses signature/u);
  // Historical/editorial zone inside an operative container (CONFAZ subtree classes).
  const hist = `<div><p>Cláusula primeira ${NFD('Resolução')}</p><p class="RedaoAnt">8471.30.12</p></div>`;
  const h = analyzeAnatomy(req(hist, 'CONFAZ'));
  assertQuarantined(h, 'citation into historical wording', 'nfc_shadow_unusable');
  // Compatible traversals stay recovered: across inline nodes of one block and into a child paragraph of the article
  // (same context). An adjacent unidentified block (context unknown) is not compatible and would quarantine.
  const ok = '<p>Art. 1\u00ba <b>' + 'Resolu\u00e7\u00e3o'.normalize('NFD') + '</b> n\u00ba <i>8471.30.12</i>, NCM 8471.41.00.</p><p>\u00a7 1\u00ba NCM 8471.30.12.</p>';
  const c = analyzeAnatomy(req(ok, 'DOU'));
  assertRecovered(c, 'compatible traversal');
  assert.deepEqual(view(c), view(analyzeAnatomy(req(ok.normalize('NFC'), 'DOU'))), 'same as the NFC equivalent');
});
