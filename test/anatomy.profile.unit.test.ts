import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
  const profiles = [def(), src('DOU', { classes: { signature: ['assina'] }, ncm: { columnHeaders: ['NCM'] } }),
    fam('DOU', 'Despacho', { classes: { signature: ['cargo'] } })];
  const e = resolveEffectiveProfile(profiles, { source: 'DOU', family: 'Despacho' });
  assert.deepEqual(e.fields.classes.signature, ['cargo'], 'family wins');
  assert.deepEqual(e.fields.ncm.columnHeaders, ['NCM'], 'source override kept');
  assert.deepEqual(e.fields.ncm.columnBlockers, def().fields.ncm!.columnBlockers, 'default inherited');
  assert.deepEqual(e.chain.map((c) => c.scope.level), ['default', 'source', 'family']);
  // A family without a source profile inherits straight from the default.
  const f = resolveEffectiveProfile([def(), fam('RFB', 'Solução de Consulta', { lists: { tokens: ['a'] } })], { source: 'RFB', family: 'Solução de Consulta' });
  assert.deepEqual(f.fields.lists.tokens, ['a']); assert.deepEqual(f.chain.map((c) => c.scope.level), ['default', 'family']);
  // An unrelated family is not applied; an empty list is a valid override meaning "none".
  assert.deepEqual(resolveEffectiveProfile(profiles, { source: 'DOU', family: 'Portaria' }).fields.classes.signature, ['assina']);
  assert.deepEqual(resolveEffectiveProfile([def(), src('CONFAZ', { quotes: { closeSuffix: [] } })], { source: 'CONFAZ' }).fields.quotes.closeSuffix, []);
  // Inputs are never mutated.
  const before = JSON.stringify(profiles); resolveEffectiveProfile(profiles, { source: 'DOU', family: 'Despacho' }); assert.equal(JSON.stringify(profiles), before);
});

test('deterministic hashes: order and formatting do not matter; content does; behaviour hash ignores provenance', () => {
  const a = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' });
  const b = resolveEffectiveProfile([...DEFAULT_PROFILES].reverse(), { source: 'CONFAZ' });
  assert.equal(a.effectiveHash, b.effectiveHash);
  // Same profile with keys in another order hashes the same.
  const reordered = JSON.parse(JSON.stringify(DEFAULT_PROFILES[1]), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assert.equal(profileHash(reordered), profileHash(DEFAULT_PROFILES[1]!));
  // One literal changes the hash.
  const changed = [...DEFAULT_PROFILES.slice(0, 1), src('CONFAZ', { classes: { epigraph: ['TituloAcordo', 'NovaClasse'] } })];
  assert.notEqual(resolveEffectiveProfile(changed, { source: 'CONFAZ' }).effectiveHash, resolveEffectiveProfile([DEFAULT_PROFILES[0]!, src('CONFAZ', { classes: { epigraph: ['TituloAcordo'] } })], { source: 'CONFAZ' }).effectiveHash);
  // Same effective fields through a different chain → same behaviour hash, different provenance.
  const direct = def(); (direct.fields.classes as Record<string, unknown>).epigraph = ['X'];
  const viaSource = resolveEffectiveProfile([def(), src('RFB', { classes: { epigraph: ['X'] } })], { source: 'RFB' });
  const viaDefault = resolveEffectiveProfile([direct], { source: 'RFB' });
  assert.equal(viaSource.effectiveHash, viaDefault.effectiveHash);
  assert.notDeepEqual(viaSource.chain, viaDefault.chain);
  // List order is semantic content: reordering a list changes the hash.
  const r1 = def(); const r2 = def(); (r2.fields.quotes as Record<string, string[]>).open = ['“', '"'];
  assert.notEqual(resolveEffectiveProfile([r1], { source: 'DOU' }).effectiveHash, resolveEffectiveProfile([r2], { source: 'DOU' }).effectiveHash);
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

// Fidelity of the extracted defaults to the rules CURRENTLY hard-coded in the engine (read as source text; the
// engine is not imported or changed). Class lists must be exactly equal; every other literal must be accepted
// by the corresponding current rule, and the documented variants must all be present.
const readers = readFileSync(new URL('../src/modules/anatomy/readers.ts', import.meta.url), 'utf8');
const entities = readFileSync(new URL('../src/modules/anatomy/entities.ts', import.meta.url), 'utf8');
const alternation = (re: RegExp, text: string) => { const m = re.exec(text); assert.ok(m, String(re)); return m![1]!.split('|').sort(); };
const regexFrom = (text: string, anchor: string) => {
  const line = text.split('\n').find((l) => l.includes(anchor)); assert.ok(line, anchor);
  const m = /(?<![\w)])\/((?:\\\/|[^/\s])(?:\\\/|[^/])*?)\/([a-z]*)\.(?:test|exec)\(/u.exec(line!); assert.ok(m, `regex on line with ${anchor}`);
  return new RegExp(m![1]!, m![2]!);
};

test('fidelity: CONFAZ class lists equal the current reader constants exactly', () => {
  const confaz = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' }).fields.classes;
  assert.deepEqual([...confaz.historical].sort(), alternation(/const historical = \/\^\(\?:([^)]+)\)\$\//u, readers));
  assert.deepEqual([...confaz.editorialNote].sort(), alternation(/const notes = \/\^\(\?:([^)]+)\)\$\//u, readers));
  assert.deepEqual([...confaz.body].sort(), alternation(/\/\^\(\?:(TextoAcordo[^)]+)\)\$\/\.test/u, readers));
  assert.ok(readers.includes("classes.includes('TituloAcordo')") && readers.includes("classes.includes('Ementa')"));
  const dou = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'DOU' }).fields;
  for (const c of ['identifica', 'ementa', 'assina', 'cargo']) assert.ok(readers.includes(`own.includes('${c}')`), c);
  assert.deepEqual([dou.classes.epigraph, dou.classes.summary, dou.classes.signature], [['identifica'], ['ementa'], ['assina', 'cargo']]);
});

test('fidelity: every default literal is accepted by the current rule it was extracted from', () => {
  const d = resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'DOU' }).fields;
  const preamble = regexFrom(readers, "type: 'preamble'");
  for (const s of d.blockStarts.preamble) assert.ok(preamble.test(`${s} resolve:`), s);
  const original = regexFrom(readers, 'dou_rectification_original'); const corrected = regexFrom(readers, 'dou_rectification_corrected');
  for (const s of d.blockStarts.rectificationOriginal) assert.ok(original.test(`${s} "x"`), s);
  for (const s of d.blockStarts.rectificationCorrected) assert.ok(corrected.test(`${s} "x"`), s);
  const header = regexFrom(readers, 'columns.add(cell.table.column)'); const blocker = regexFrom(readers, 'columns.delete(cell.table.column)');
  for (const s of d.ncm.columnHeaders) assert.ok(header.test(s), s);
  for (const s of d.ncm.columnBlockers) assert.ok(blocker.test(s), s);
  const annex = regexFrom(readers, "type: 'annex'"); const clause = regexFrom(readers, "type: 'clause'");
  const article = regexFrom(readers, "type: 'article'"); const paragraph = regexFrom(readers, "type: 'paragraph'");
  for (const s of d.labels.annex) assert.ok(annex.test(`${s} I`), s);
  for (const s of d.labels.clause) assert.ok(clause.test(`${s} primeira`), s);
  for (const s of d.labels.article) assert.ok(article.test(`${s} 1º`), s);
  for (const s of d.labels.paragraph) assert.ok(paragraph.test(s === '§' ? '§ 1º' : s), s);
  const listRe = regexFrom(entities, 'const list = '); for (const s of d.lists.tokens) assert.ok(listRe.test(` ${s} `), s);
  const bridgeRe = /^\s*(?:a|at[eé]|[-–—])\s*$/iu; assert.ok(entities.includes(String(bridgeRe).slice(1, -3)));
  for (const s of d.ranges.operators) assert.ok(bridgeRe.test(` ${s} `), s);
  const exceptionRe = /\b(?:exceto|excetuad[oa]s?|exclu[ií]d[oa]s?|salvo|exclusive)\b/iu; assert.ok(entities.includes(String(exceptionRe).slice(1, -3)));
  for (const s of d.exceptions.markers) assert.ok(new RegExp(`^${exceptionRe.source}$`, 'iu').test(s), s);
  const marker = /\bNCM(?:\/SH)?\b/iu; for (const s of d.ncm.markers) assert.ok(marker.test(s), s);
  for (const q of d.quotes.open) assert.ok(readers.includes(`["“]`) && '"“'.includes(q), q);
  // The current closing rule is `/[”"](?:\s*\(NR\)\.?)?\s*$/u`; every default close/suffix literal must satisfy it.
  const closeRe = regexFrom(readers, ')) openQuotation = false');
  for (const c of d.quotes.close) for (const suffix of ['', ...d.quotes.closeSuffix.map((s) => ` ${s}`)]) assert.ok(closeRe.test(`texto${c}${suffix}`), `${c}${suffix}`);
});
