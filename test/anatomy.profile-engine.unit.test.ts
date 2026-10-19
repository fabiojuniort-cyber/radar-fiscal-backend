import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { structuralOutput } from '../ops/anatomy/synthetic-snapshot.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, ProfileValidationError } from '../src/modules/anatomy/profile.js';
import { compileProfileRules, defaultRules } from '../src/modules/anatomy/profile-rules.js';
import { readAnatomyInput } from '../src/modules/anatomy/readers.js';
import { LEGACY } from './support/anatomy-legacy-rules.js';

// SYNTHETIC inputs only. The seven real development entries are NOT analysed here (separate authorisation).

test('equivalence: the default profile reproduces the pre-integration engine output on every synthetic document', () => {
  const frozen = JSON.parse(readFileSync(new URL('./fixtures/anatomy/synthetic-equivalence.json', import.meta.url), 'utf8')).documents as { id: string; structure: unknown }[];
  const now = structuralOutput();
  assert.equal(now.length, frozen.length);
  for (let i = 0; i < frozen.length; i++) assert.deepEqual(now[i], frozen[i], frozen[i]!.id);
});

// Differential check of every compiled default matcher against the original regex (oracle), on synthetic variants.
const variants = (bases: string[]) => bases.flatMap((b) => [b, b.toUpperCase(), b.toLowerCase(), ` ${b}`, `${b} `, `${b}x`, `${b}1`, `${b}.`, `${b},`, `${b} texto`, b.replace(/ /g, '  '), b.replace(/ /g, '\t'), `x${b}`]);
function differential(name: string, legacy: RegExp, compiled: RegExp, inputs: string[], expectedDiffs: string[] = []) {
  const l = new RegExp(legacy.source, legacy.flags.replace('g', '')); const c = new RegExp(compiled.source, compiled.flags.replace('g', ''));
  const diffs = [...new Set(inputs)].filter((s) => l.test(s) !== c.test(s));
  assert.deepEqual(diffs.sort(), [...expectedDiffs].sort(), `${name}: differences against the original rule`);
}
const sampleText = 'O Conselho Nacional resolve; A Receita Federal informa; CONSIDERANDOS; O Secretario; A Secretária; O Presidente; O Ministro; O Governador';

test('oracle: compiled default matchers equal the original rules (documented preamble differences only)', () => {
  const dou = defaultRules('DOU'); const confaz = defaultRules('CONFAZ');
  const preambleBases = ['O Conselho', 'O Ministro', 'O Secretário', 'O Secretario', 'O Governador', 'O Presidente', 'A Secretária', 'A Secretaria', 'A Receita Federal', 'CONSIDERANDO', 'O Diretor', 'A Lei', 'Considerando'];
  // Two deliberate, documented differences (docs/anatomy/profile-engine.md): block starts end at a word boundary, and
  // every space inside a literal accepts any whitespace run. The original only bounded CONSIDERANDO and used a single
  // literal space inside "Receita Federal".
  const glued = ['O Conselho', 'O Ministro', 'O Secretário', 'O Secretario', 'O Governador', 'O Presidente', 'A Secretária', 'A Secretaria', 'A Receita Federal']
    .flatMap((l) => [`${l}x`, `${l}1`]);
  differential('preamble', LEGACY.preamble, dou.preamble, [...variants(preambleBases), ...sampleText.split('; ')], [...glued, 'A  Receita  Federal', 'A	Receita	Federal']);
  differential('rectification original', LEGACY.rectificationOriginal, dou.rectificationOriginal, variants(['Onde se lê', 'Onde se le', 'Onde se lêem', 'Onde lê']));
  differential('rectification corrected', LEGACY.rectificationCorrected, dou.rectificationCorrected, variants(['Leia-se', 'Leia-seguinte', 'Leia se']));
  differential('quote block open', LEGACY.quoteBlockOpen, dou.quoteBlockOpen, ['"a', '“a', '  "a', '”a', "'a", 'a"', '«a']);
  differential('quote open', LEGACY.quoteOpen, dou.quoteOpen, ['"a', '“a', ' "a', '”a', 'a']);
  differential('quote close', LEGACY.quoteClose, dou.quoteClose, ['a"', 'a”', 'a" (NR)', 'a”(NR).', 'a" (NR) ', 'a“', 'a (NR)', 'a" (nr)', 'a"x']);
  differential('quote only', LEGACY.quoteOnly, dou.quoteOnly, ['"', '“', '”', '""', ' "', 'a']);
  differential('annex', LEGACY.annex, dou.annex, variants(['ANEXO I', 'ANEXO 12', 'ANEXO II -', 'ANEXO III: Tabela', 'ANEXO IV (', 'ANEXO citado', 'Anexo V']));
  differential('clause', LEGACY.clause, dou.clause, variants(['Cláusula primeira', 'Clausula segunda', 'Cláusula 3', 'Cláusula sétima', 'Cláusula setima', 'Cláusula única', 'Clausula']));
  differential('article', LEGACY.article, dou.article, variants(['Art. 1º', 'Art 1', 'Artigo 2', 'Art.12', 'Art. 3°', 'Arte 4', 'Art. A']));
  differential('paragraph', LEGACY.paragraph, dou.paragraph, variants(['§ 1º', '§1', '§ único', 'Parágrafo único', 'Paragrafo unico', 'Parágrafo 2', 'Paragrafo único']));
  differential('ncm header', LEGACY.ncmHeader, dou.ncmHeader, variants(['NCM', 'NCM/SH', 'NCM / SH', 'CÓDIGO NCM', 'CODIGO NCM', 'CÓDIGO NCM/SH', 'CODIGO  NCM / SH', 'CÓDIGO', 'NBM', 'NCM SH']));
  differential('ncm blocker', LEGACY.ncmBlocker, dou.ncmBlocker, variants(['NBM', 'NBM/SH', 'TIPI', 'SH', 'CÓDIGO', 'CODIGO', 'CÓDIGO DA NBM/SH', 'NCM', 'SH /x']));
  differential('ncm marker', LEGACY.ncmMarker, dou.ncmMarker, ['NCM 0101', 'NCM/SH: 0101', 'ncm códigos 0101', 'NCM nº 0101', 'NCMs', 'xNCM', 'NCM/SHx', 'NBM 0101', 'NCM-0101', 'NCM = 0101']);
  differential('code list', LEGACY.codeList, dou.codeList, [' 0101 a 0102', ' 0101 até 0102', ' 0101 ate 0102', ' 0101 atéx', ' 0101 ate1', ' 0101 e 0102', ' 0101, exceto 0102', ' excetuados 0102', ' excluídos 0102',
    ' excluidas 0102', ' salvo 0102', ' exclusive', ' inclusive', ' de 2026', ' ou', ' x', ' 0101 ex', ' 0101 a1', ' 0101 eç', ' (0101)', ' 0101 – 0102']);
  differential('range bridge', LEGACY.rangeBridge, dou.rangeBridge, [' a ', ' até ', ' ate ', '-', ' – ', ' — ', ' e ', ' a  ', 'A', 'ATÉ', ' ao ', '']);
  differential('exception marker', LEGACY.exceptionMarker, dou.exceptionMarker, variants(['exceto', 'excetuado', 'excetuadas', 'excluído', 'excluidas', 'salvo', 'exclusive', 'exceção', 'salvos', 'inclusive']));
  // Classes are sets: the compiled CONFAZ sets are exactly the original alternations.
  const alt = (re: RegExp) => /^\^\(\?:([^)]+)\)\$$/u.exec(re.source)![1]!.split('|').sort();
  assert.deepEqual([...confaz.classes.historical].sort(), alt(LEGACY.historical));
  assert.deepEqual([...confaz.classes.editorialNote].sort(), alt(LEGACY.notes));
  assert.deepEqual([...confaz.classes.body].sort(), alt(LEGACY.body));
  assert.deepEqual([confaz.classScope, dou.classScope, defaultRules('RFB').classScope], ['subtree', 'own', 'own']);
});

const base = (html: string, source: AnatomyRequest['input']['source'] = 'CONFAZ', extra: Partial<AnatomyRequest> = {}): AnatomyRequest => ({
  publicationVersionId: 'synthetic', referenceDate: '2026-10-19', ruleSet: { id: 'synthetic', version: '1' },
  input: { source, representationId: 'synthetic://p1b', html }, catalog: { edition: 'synthetic', codes: ['84713012', '84714100', '84714900', '84715000'] }, ...extra });
const withSource = (source: string, fields: unknown) => [...DEFAULT_PROFILES.filter((p) => !(p.scope.level === 'source' && p.scope.source === source)),
  { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source }, fields: { ...(DEFAULT_PROFILES.find((p) => p.scope.level === 'source' && p.scope.source === source)?.fields ?? {}), ...(fields as object) } }];
const reasons = (r: ReturnType<typeof analyzeAnatomy>) => r.parts.map((p) => `${p.type}:${p.contextReasons[0]}:${p.context}`);
const ncmLiterals = (r: ReturnType<typeof analyzeAnatomy>) => r.entities.filter((e) => e.domain === 'NCM').map((e) => e.literal);

test('configuration effects: each editable field changes the engine as configured (synthetic)', () => {
  // A new CONFAZ historical class makes its block historical.
  const hist = '<p class="NovaHist">Cláusula primeira NCM 8471.30.12.</p>';
  assert.ok(reasons(analyzeAnatomy(base(hist))).some((r) => r === 'clause:clause_marker:operative_candidate'));
  const confaz = DEFAULT_PROFILES.find((p) => p.scope.level === 'source' && p.scope.source === 'CONFAZ')!.fields as { classes: Record<string, string[]> };
  assert.ok(reasons(analyzeAnatomy(base(hist, 'CONFAZ', { profiles: withSource('CONFAZ', { classes: { ...confaz.classes, historical: [...confaz.classes.historical!, 'NovaHist'] } }) })))
    .some((r) => r === 'clause:clause_marker:historical'));
  // A new DOU signature class is recognised on its own block, with the class in the reason.
  const sig = '<p>Art. 1º Texto.</p><p class="assinatura2">FULANO</p>';
  assert.ok(!reasons(analyzeAnatomy(base(sig, 'DOU'))).some((r) => r.startsWith('signature')));
  assert.ok(reasons(analyzeAnatomy(base(sig, 'DOU', { profiles: withSource('DOU', { classes: { epigraph: ['identifica'], summary: ['ementa'], signature: ['assina', 'cargo', 'assinatura2'] } }) })))
    .includes('signature:dou_assinatura2:prohibited'));
  // A new NCM column header opens the column for code recognition.
  const table = '<table><tr><td>Classificação</td></tr><tr><td>8471.30.12</td></tr></table>'; // no NCM word: only the header can open it
  const defaults = DEFAULT_PROFILES[0]!.fields as { ncm: Record<string, string[]>; lists: Record<string, string[]>; ranges: Record<string, string[]>; exceptions: Record<string, string[]>; blockStarts: Record<string, string[]> };
  assert.deepEqual(ncmLiterals(analyzeAnatomy(base(table, 'RFB'))), []);
  assert.deepEqual(ncmLiterals(analyzeAnatomy(base(table, 'RFB', { profiles: withSource('RFB', { ncm: { columnHeaders: [...defaults.ncm.columnHeaders!, 'Classificação'] } }) }))), ['8471.30.12']);
  // A new list token lets the NCM list continue.
  const list = '<p>Art. 1º NCM 8471.30.12 bem como 8471.41.00.</p>';
  assert.deepEqual(ncmLiterals(analyzeAnatomy(base(list, 'RFB'))), ['8471.30.12']);
  assert.deepEqual(ncmLiterals(analyzeAnatomy(base(list, 'RFB', { profiles: withSource('RFB', { lists: { tokens: [...defaults.lists.tokens!, 'bem como'] } }) }))), ['8471.30.12', '8471.41.00']);
  // A new range operator creates a bounded range (never expanded).
  const range = '<p>Art. 1º NCM 8471.30.12 ao 8471.49.00.</p>';
  const ranged = (r: ReturnType<typeof analyzeAnatomy>) => r.entities.filter((e) => e.domain === 'NCM_RANGE').length;
  const withAo = { ranges: { operators: [...defaults.ranges.operators!, 'ao'] }, lists: { tokens: [...defaults.lists.tokens!, 'ao'] } };
  assert.equal(ranged(analyzeAnatomy(base(range, 'RFB'))), 0);
  const r1 = analyzeAnatomy(base(range, 'RFB', { profiles: withSource('RFB', withAo) }));
  assert.equal(ranged(r1), 1); assert.deepEqual(r1.entities.find((e) => e.domain === 'NCM_RANGE')!.relation!.expansion, []);
  // A new exception marker creates an exception compound.
  const exc = '<p>Art. 1º NCM 8471.30.12, menos 8471.41.00.</p>';
  const excepted = (r: ReturnType<typeof analyzeAnatomy>) => r.entities.filter((e) => e.domain === 'NCM_EXCEPTION').length;
  assert.equal(excepted(analyzeAnatomy(base(exc, 'RFB'))), 0);
  assert.equal(excepted(analyzeAnatomy(base(exc, 'RFB', { profiles: withSource('RFB', { exceptions: { markers: [...defaults.exceptions.markers!, 'menos'] }, lists: { tokens: [...defaults.lists.tokens!, 'menos'] } }) }))), 1);
  // A new block start makes a preamble (prohibited zone).
  const pre = '<p>O Diretor resolve:</p>';
  assert.ok(!reasons(analyzeAnatomy(base(pre, 'RFB'))).some((r) => r.startsWith('preamble')));
  assert.ok(reasons(analyzeAnatomy(base(pre, 'RFB', { profiles: withSource('RFB', { blockStarts: { ...defaults.blockStarts, preamble: [...defaults.blockStarts.preamble!, 'O Diretor'] } }) })))
    .includes('preamble:preamble_marker:prohibited'));
  // A family profile applies only when the request names that family.
  const famProfiles = [...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source: 'RFB', family: 'Despacho' }, fields: { blockStarts: { preamble: ['O Diretor'] } } }];
  assert.ok(!reasons(analyzeAnatomy(base(pre, 'RFB', { profiles: famProfiles }))).some((r) => r.startsWith('preamble')));
  assert.ok(reasons(analyzeAnatomy(base(pre, 'RFB', { profiles: famProfiles, family: 'Despacho' }))).includes('preamble:preamble_marker:prohibited'));
});

test('identity: ruleSetHash follows the effective profile; engineHash is the regenerated build hash', () => {
  const html = '<p class="TextoAcordo">Cláusula primeira NCM 8471.30.12.</p>';
  const a = analyzeAnatomy(base(html));
  const sameEffective = analyzeAnatomy(base(html, 'CONFAZ', { profiles: [...DEFAULT_PROFILES].reverse() }));
  assert.equal(sameEffective.identity.ruleSetHash, a.identity.ruleSetHash, 'same effective profile, any order');
  const changed = analyzeAnatomy(base(html, 'CONFAZ', { profiles: withSource('CONFAZ', { quotes: { open: ['"'], close: ['"'], closeSuffix: ['(NR)'] } }) }));
  assert.notEqual(changed.identity.ruleSetHash, a.identity.ruleSetHash);
  assert.notEqual(changed.analysisId, a.analysisId);
  assert.equal(a.identity.engineHash, ANATOMY_ENGINE_BUILD_HASH);
  assert.notEqual(ANATOMY_ENGINE_BUILD_HASH, 'ad69d28524ad6478764b203dc962c9d8a0600fbeac07aa985854b18868ab9d9d', 'engine identity changed explicitly with P1.B');
  // The compiled rules carry the behaviour hash of the profile they came from.
  assert.equal(compileProfileRules({ fields: DEFAULT_PROFILES[0]!.fields as never, effectiveHash: 'h' }, 'CONFAZ').effectiveHash, 'h');
  assert.match(defaultRules('CONFAZ').effectiveHash, /^[0-9a-f]{64}$/);
});

test('fixed protections cannot be configured away (synthetic)', () => {
  // The schema has no field for domain patterns, limits, excluded tags or a relaxed table policy.
  const relaxed = withSource('RFB', { table: { ambiguousGeometry: 'original' } });
  assert.throws(() => analyzeAnatomy(base('<p>x</p>', 'RFB', { profiles: relaxed })), ProfileValidationError);
  assert.throws(() => analyzeAnatomy(base('<p>x</p>', 'RFB', { profiles: withSource('RFB', { domains: { CNPJ: [] } }) })), ProfileValidationError);
  // Protected domains still win over an NCM list, even with extra list tokens configured.
  const defaults = DEFAULT_PROFILES[0]!.fields as { lists: Record<string, string[]> };
  const protectedText = '<p>Art. 1º NCM 8471.30.12 e CNPJ 12.345.678/0001-90 e processo SEI nº 12345.678901/2026-12.</p>';
  const r = analyzeAnatomy(base(protectedText, 'RFB', { profiles: withSource('RFB', { lists: { tokens: [...defaults.lists.tokens!, 'CNPJ', 'processo', 'SEI', 'nº'] } }) }));
  assert.deepEqual(ncmLiterals(r), ['8471.30.12']);
  assert.ok(r.entities.some((e) => e.domain === 'CNPJ') && r.entities.some((e) => e.domain === 'PROCESS'));
  // Prohibited zones never yield an NCM, whatever the markers: an epigraph class with an NCM inside.
  const epi = analyzeAnatomy(base('<p class="TituloAcordo">CONVÊNIO NCM 8471.30.12</p>'));
  assert.deepEqual(ncmLiterals(epi), []);
  // Executable content stays excluded and ambiguous table geometry stays unknown/partial.
  const unsafe = analyzeAnatomy(base('<script>NCM 8471.30.12</script><table><tr><td rowspan="x">NCM</td></tr></table>', 'RFB'));
  assert.ok(!unsafe.canonicalText.includes('8471.30.12'));
  assert.ok(unsafe.parts.some((p) => p.table?.geometry === 'unknown') && unsafe.status === 'partial');
  // Nothing is ever eligible: positive selection still requires approved evidence.
  assert.ok(r.eligibility.every((s) => !s.eligible));
});

test('fail closed: invalid profiles, wrong-source rules, and conflicting effective profiles are rejected', () => {
  assert.throws(() => analyzeAnatomy(base('<p>x</p>', 'RFB', { profiles: [] })), ProfileValidationError, 'no default');
  assert.throws(() => analyzeAnatomy(base('<p>x</p>', 'RFB', { profiles: [{ not: 'a profile' }] })), ProfileValidationError);
  const defaults = DEFAULT_PROFILES[0]!.fields as { ncm: Record<string, string[]> };
  assert.throws(() => analyzeAnatomy(base('<p>x</p>', 'RFB', { profiles: withSource('RFB', { ncm: { columnHeaders: [...defaults.ncm.columnHeaders!, 'TIPI'] } }) })), ProfileValidationError);
  assert.throws(() => readAnatomyInput({ source: 'DOU', representationId: 'x', html: '<p>x</p>', rules: defaultRules('CONFAZ') }), TypeError);
});
