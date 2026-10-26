import assert from 'node:assert/strict';

import test from 'node:test';
import { LEGACY } from './support/anatomy-legacy-rules.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, PROFILE_LIMITS, ProfileValidationError, profileHash, resolveEffectiveProfile, validateProfile,
  type AnatomyProfile } from '../src/modules/anatomy/profile.js';

// SYNTHETIC profiles only. Nothing here runs the engine, reads the corpus or touches the reserve.
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof ProfileValidationError, String(e)); return e.code; } return 'no-error'; };
const clone = <T>(v: T): T => structuredClone(v);
const def = () => clone(DEFAULT_PROFILES[0]!) as AnatomyProfile & { fields: Record<string, Record<string, unknown>> };
const src = (source: string, fields: unknown) => ({ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source }, fields });
const fam = (source: string, family: string, fields: unknown) => ({ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source, family }, fields });

test('default profiles validate and resolve for every source', () => {
  for (const p of DEFAULT_PROFILES) validateProfile(p);
  for (const source of ['CONFAZ', 'DOU', 'DOE-SP', 'RFB']) {
    const e = resolveEffectiveProfile([...DEFAULT_PROFILES], { source });
    assert.equal(e.fields.table.ambiguousGeometry, 'unknown_partial');
    assert.match(e.effectiveHash, /^[0-9a-f]{64}$/);
  }
  const confaz = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' });
  assert.deepEqual(confaz.fields.classes.epigraph, ['TituloAcordo']);
  assert.deepEqual(confaz.fields.classes.signature, [], 'inherited from default');
  assert.deepEqual(confaz.chain.map((c) => c.scope.level), ['default', 'source']);
  const doeSp = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'DOE-SP' });
  assert.deepEqual(doeSp.chain.map((c) => c.scope.level), ['default'], 'no DOE-SP specialisation');
  assert.deepEqual(doeSp.fields.classes.historical, []);
});

test('inheritance default → source → family replaces per field and inherits omitted ones', () => {
  const profiles = [def(), src('RFB', { classes: { signature: ['assina'] }, ncm: { columnHeaders: ['NCM'] } }),
    fam('RFB', 'Despacho', { classes: { signature: ['cargo'] } })];
  const e = resolveEffectiveProfile(profiles, { source: 'RFB', family: 'Despacho' });
  assert.deepEqual(e.fields.classes.signature, ['cargo'], 'family wins');
  assert.deepEqual(e.fields.ncm.columnHeaders, ['NCM'], 'source override kept');
  assert.deepEqual(e.fields.ncm.columnBlockers, def().fields.ncm!.columnBlockers, 'default inherited');
  assert.deepEqual(e.chain.map((c) => c.scope.level), ['default', 'source', 'family']);
  // A family without a source profile inherits straight from the default.
  const f = resolveEffectiveProfile([def(), fam('RFB', 'Solução de Consulta', { lists: { tokens: ['a'] } })], { source: 'RFB', family: 'Solução de Consulta' });
  assert.deepEqual(f.fields.lists.tokens, ['a']); assert.deepEqual(f.chain.map((c) => c.scope.level), ['default', 'family']);
  // An unrelated family is not applied; an empty list is a valid override meaning "none".
  assert.deepEqual(resolveEffectiveProfile(profiles, { source: 'RFB', family: 'Portaria' }).fields.classes.signature, ['assina']);
  assert.deepEqual(resolveEffectiveProfile([def(), src('RFB', { quotes: { closeSuffix: [] } })], { source: 'RFB' }).fields.quotes.closeSuffix, []);
  // Inputs are never mutated.
  const before = JSON.stringify(profiles); resolveEffectiveProfile(profiles, { source: 'RFB', family: 'Despacho' }); assert.equal(JSON.stringify(profiles), before);
});

test('deterministic hashes: order and formatting do not matter; content does; behaviour hash ignores provenance', () => {
  const a = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' });
  const b = resolveEffectiveProfile([...DEFAULT_PROFILES].reverse(), { source: 'CONFAZ' });
  assert.equal(a.effectiveHash, b.effectiveHash);
  // Same profile with keys in another order hashes the same.
  const reordered = JSON.parse(JSON.stringify(DEFAULT_PROFILES[1]), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assert.equal(profileHash(reordered), profileHash(DEFAULT_PROFILES[1]!));
  // One literal changes the hash.
  const confazClasses = (DEFAULT_PROFILES[1]!.fields as { classes: Record<string, string[]> }).classes;
  const changed = [...DEFAULT_PROFILES.slice(0, 1), src('CONFAZ', { classes: { ...confazClasses, epigraph: ['TituloAcordo', 'NovaClasse'] } })];
  assert.notEqual(resolveEffectiveProfile(changed, { source: 'CONFAZ' }).effectiveHash, resolveEffectiveProfile([DEFAULT_PROFILES[0]!, src('CONFAZ', { classes: { ...confazClasses } })], { source: 'CONFAZ' }).effectiveHash);
  // Same effective fields through a different chain → same behaviour hash, different provenance.
  const direct = def(); (direct.fields.classes as Record<string, unknown>).epigraph = ['X'];
  const viaSource = resolveEffectiveProfile([def(), src('RFB', { classes: { epigraph: ['X'] } })], { source: 'RFB' });
  const viaDefault = resolveEffectiveProfile([direct], { source: 'RFB' });
  assert.equal(viaSource.effectiveHash, viaDefault.effectiveHash);
  assert.notDeepEqual(viaSource.chain, viaDefault.chain);
  // List order is semantic content: reordering a list changes the hash.
  const r1 = def(); const r2 = def(); (r2.fields.quotes as Record<string, string[]>).open = ['“', '"'];
  assert.notEqual(resolveEffectiveProfile([r1], { source: 'RFB' }).effectiveHash, resolveEffectiveProfile([r2], { source: 'RFB' }).effectiveHash);
});

test('limits: 64 items per field, 64 UTF-16 units per literal, 64 KiB per profile', () => {
  const at = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
  assert.deepEqual(PROFILE_LIMITS, { maxItemsPerField: 64, maxLiteralUtf16: 64, maxProfileBytes: 65536 });
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: at(64) } }))), 'no-error');
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: at(65) } }))), 'invalid_fields');
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: ['x'.repeat(64)] } }))), 'no-error');
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: ['x'.repeat(65)] } }))), 'invalid_fields');
  // UTF-16 units, not characters: 32 emoji = 64 units is accepted, 33 = 66 units is not.
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: ['😀'.repeat(32)] } }))), 'no-error');
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: ['😀'.repeat(33)] } }))), 'invalid_fields');
  // Fill every list field with 64 literals of 64 units (~100 KiB) to cross the 64 KiB profile limit.
  const big = def(); const lit = (i: number) => `${String(i).padStart(3, '0')}${'é'.repeat(61)}`;
  for (const g of Object.keys(big.fields)) for (const f of Object.keys(big.fields[g]!)) if (Array.isArray(big.fields[g]![f])) big.fields[g]![f] = Array.from({ length: 64 }, (_, i) => lit(i));
  assert.equal(code(() => validateProfile(big)), 'profile_too_large');
});

test('fail closed on malformed literals, structure, versions and the mandatory table policy', () => {
  const bad: [string, unknown][] = [
    ['control char', src('DOU', { lists: { tokens: ['a\u0007'] } })],
    ['newline', src('DOU', { lists: { tokens: ['a\nb'] } })],
    ['leading space', src('DOU', { lists: { tokens: [' a'] } })],
    ['trailing space', src('DOU', { lists: { tokens: ['a '] } })],
    ['empty literal', src('DOU', { lists: { tokens: [''] } })],
    ['duplicate', src('DOU', { lists: { tokens: ['a', 'a'] } })],
    ['non-string', src('DOU', { lists: { tokens: [1] } })],
    ['unknown group', src('DOU', { regex: { any: ['.*'] } })],
    ['unknown field in group', src('DOU', { classes: { script: ['x'] } })],
    ['table policy relaxed', src('DOU', { table: { ambiguousGeometry: 'trust' } })],
  ];
  for (const [name, p] of bad) assert.equal(code(() => validateProfile(p)), 'invalid_fields', name);
  assert.equal(code(() => validateProfile({ ...src('DOU', {}), profileVersion: 'ANAT-PROFILE/2' })), 'invalid_profile');
  assert.equal(code(() => validateProfile({ ...src('DOU', {}), extra: true })), 'invalid_profile');
  assert.equal(code(() => validateProfile(src('XYZ', {}))), 'invalid_profile');
  assert.equal(code(() => validateProfile({ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source: 'DOU', family: ' ' }, fields: {} })), 'invalid_profile');
  const incomplete = def(); delete (incomplete.fields as Record<string, unknown>).quotes;
  assert.equal(code(() => validateProfile(incomplete)), 'incomplete_default');
  const relaxed = def(); (relaxed.fields.table as Record<string, unknown>).ambiguousGeometry = 'original';
  assert.equal(code(() => validateProfile(relaxed)), 'incomplete_default');
});

test('resolution errors: one default, one profile per scope, valid target', () => {
  assert.equal(code(() => resolveEffectiveProfile([src('DOU', {})], { source: 'DOU' })), 'missing_default');
  assert.equal(code(() => resolveEffectiveProfile([def(), def()], { source: 'DOU' })), 'duplicate_scope');
  assert.equal(code(() => resolveEffectiveProfile([def(), src('DOU', {}), src('DOU', {})], { source: 'DOU' })), 'duplicate_scope');
  assert.equal(code(() => resolveEffectiveProfile([def(), fam('DOU', 'A', {}), fam('DOU', 'A', {})], { source: 'DOU' })), 'duplicate_scope');
  assert.equal(code(() => resolveEffectiveProfile([def()], { source: 'XYZ' })), 'invalid_target');
  assert.equal(code(() => resolveEffectiveProfile([def()], { source: 'DOU', family: '' })), 'invalid_target');
  assert.equal(code(() => resolveEffectiveProfile([def(), { not: 'a profile' }], { source: 'DOU' })), 'invalid_profile');
});

// Review of PR #248 (GPT/Codex, issue #116 comment 6260301226).

test('semantic duplicates are rejected under the matching semantics of each field', () => {
  const ci: [string, unknown][] = [
    ['case', src('DOU', { exceptions: { markers: ['exceto', 'EXCETO'] } })],
    ['mixed case', src('DOU', { lists: { tokens: ['Salvo', 'salvo'] } })],
    ['header case', src('DOU', { ncm: { columnHeaders: ['ncm', 'NCM'] } })],
    ['operator', src('DOU', { ranges: { operators: ['ATÉ', 'até'] } })],
  ];
  for (const [name, p] of ci) assert.equal(code(() => validateProfile(p)), 'semantic_conflict', name);
  // Exact fields: CSS classes and quote characters are case-sensitive, but still NFC-normalised.
  assert.equal(code(() => validateProfile(src('CONFAZ', { classes: { body: ['Remisso', 'remisso'] } }))), 'no-error', 'CSS classes are case-sensitive');
  // Accent variants stay distinct on purpose (the current rules accept both spellings).
  assert.equal(code(() => validateProfile(src('DOU', { lists: { tokens: ['até', 'ate'] } }))), 'no-error');
  // The same literal in two different fields is not a duplicate.
  assert.equal(code(() => validateProfile(src('DOU', { ncm: { markers: ['NCM'], columnHeaders: ['NCM'] } }))), 'no-error');
  // The default profile itself has no semantic duplicate.
  for (const p of DEFAULT_PROFILES) assert.equal(code(() => validateProfile(p)), 'no-error');
});

test('a header cannot be allowed and blocked at once — inside one profile or after inheritance', () => {
  const both: [string, unknown][] = [
    ['equal', src('DOU', { ncm: { columnHeaders: ['NCM'], columnBlockers: ['NCM'] } })],
    ['equal ignoring case', src('DOU', { ncm: { columnHeaders: ['Código NCM'], columnBlockers: ['CÓDIGO NCM'] } })],
    ['blocker as prefix with /', src('DOU', { ncm: { columnHeaders: ['NCM/SH'], columnBlockers: ['NCM'] } })],
    ['blocker as prefix with spaced /', src('DOU', { ncm: { columnHeaders: ['NCM / SH'], columnBlockers: ['ncm'] } })],
  ];
  for (const [name, p] of both) assert.equal(code(() => validateProfile(p)), 'semantic_conflict', name);
  // Not a conflict: different words, or a blocker that is only a word prefix without "/".
  assert.equal(code(() => validateProfile(src('DOU', { ncm: { columnHeaders: ['CÓDIGO NCM'], columnBlockers: ['CÓDIGO'] } }))), 'no-error');
  // Each profile valid alone, conflict only in the effective profile: a source header blocked by an inherited blocker…
  const header = src('DOU', { ncm: { columnHeaders: ['TIPI'] } });
  assert.equal(code(() => validateProfile(header)), 'no-error');
  assert.equal(code(() => resolveEffectiveProfile([def(), header], { source: 'DOU' })), 'effective_conflict');
  // …or a family blocker that blocks an inherited header.
  const blocker = fam('DOU', 'Portaria', { ncm: { columnBlockers: ['NCM'] } });
  assert.equal(code(() => validateProfile(blocker)), 'no-error');
  assert.equal(code(() => resolveEffectiveProfile([def(), blocker], { source: 'DOU', family: 'Portaria' })), 'effective_conflict');
  // Overriding both lists consistently resolves it.
  const consistent = fam('RFB', 'Portaria', { ncm: { columnHeaders: ['NCM'], columnBlockers: ['NBM', 'TIPI', 'SH', 'CÓDIGO', 'CODIGO', 'NALADI'] } });
  assert.deepEqual(resolveEffectiveProfile([def(), consistent], { source: 'RFB', family: 'Portaria' }).fields.ncm.columnBlockers.at(-1), 'NALADI');
  // The shipped defaults resolve without conflict for every source.
  for (const source of ['CONFAZ', 'DOU', 'DOE-SP', 'RFB']) assert.equal(code(() => resolveEffectiveProfile([...DEFAULT_PROFILES], { source })), 'no-error', source);
});

// Fidelity of the extracted defaults to the rules that were hard-coded before P1.B. Since P1.B those constants live in
// the profile, so the original rules are kept verbatim as an oracle (test/support/anatomy-legacy-rules.ts, from 585f5a49).
const alternation = (re: RegExp) => /^\^\(\?:([^)]+)\)\$$/u.exec(re.source)![1]!.split('|').sort();

test('fidelity: CONFAZ and DOU class lists equal the original reader constants exactly', () => {
  const confaz = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' }).fields.classes;
  assert.deepEqual([...confaz.historical].sort(), alternation(LEGACY.historical));
  assert.deepEqual([...confaz.editorialNote].sort(), alternation(LEGACY.notes));
  assert.deepEqual([...confaz.body].sort(), alternation(LEGACY.body));
  assert.deepEqual([confaz.epigraph, confaz.summary], [LEGACY.confazEpigraph, LEGACY.confazSummary]);
  const dou = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'DOU' }).fields.classes;
  assert.deepEqual([dou.epigraph, dou.summary, dou.signature], [LEGACY.douEpigraph, LEGACY.douSummary, LEGACY.douSignature]);
});

test('fidelity: every default literal is accepted by the original rule it was extracted from', () => {
  const d = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'DOU' }).fields;
  const L = LEGACY;
  for (const s of d.blockStarts.preamble) assert.ok(L.preamble.test(`${s} resolve:`), s);
  for (const s of d.blockStarts.rectificationOriginal) assert.ok(L.rectificationOriginal.test(`${s} "x"`), s);
  for (const s of d.blockStarts.rectificationCorrected) assert.ok(L.rectificationCorrected.test(`${s} "x"`), s);
  for (const s of d.ncm.columnHeaders) assert.ok(L.ncmHeader.test(s), s);
  for (const s of d.ncm.columnBlockers) assert.ok(L.ncmBlocker.test(s), s);
  for (const s of d.labels.annex) assert.ok(L.annex.test(`${s} I`), s);
  for (const s of d.labels.clause) assert.ok(L.clause.test(`${s} primeira`), s);
  for (const s of d.labels.article) assert.ok(L.article.test(`${s} 1º`), s);
  for (const s of d.labels.paragraph) assert.ok(L.paragraph.test(s === '§' ? '§ 1º' : s), s);
  for (const s of d.lists.tokens) assert.ok(L.codeList.test(` ${s} `), s);
  for (const s of d.ranges.operators) assert.ok(L.rangeBridge.test(` ${s} `), s);
  for (const s of d.exceptions.markers) assert.ok(new RegExp(`^${L.exceptionMarker.source}$`, 'iu').test(s), s);
  for (const s of d.ncm.markers) assert.ok(new RegExp(L.ncmMarker.source, 'iu').test(s), s);
  for (const q of d.quotes.open) assert.ok(L.quoteOpen.test(q) && L.quoteBlockOpen.test(` ${q}`), q);
  for (const c of d.quotes.close) for (const suffix of ['', ...d.quotes.closeSuffix.map((s) => ` ${s}`)]) assert.ok(L.quoteClose.test(`texto${c}${suffix}`), `${c}${suffix}`);
});

