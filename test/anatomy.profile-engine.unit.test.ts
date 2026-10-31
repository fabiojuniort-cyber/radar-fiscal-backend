import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { structuralOutput } from '../ops/anatomy/synthetic-snapshot.js';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import { analyzeAnatomy, type AnatomyRequest } from '../src/modules/anatomy/engine.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION, ProfileValidationError, resolveEffectiveProfile, validateProfile } from '../src/modules/anatomy/profile.js';
import { compileProfileRules, defaultRules } from '../src/modules/anatomy/profile-rules.js';
import { extractAnatomyEntities } from '../src/modules/anatomy/entities.js';
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

test('oracle: compiled default matchers equal the original rules, preamble included (no differences)', () => {
  const dou = defaultRules('DOU'); const confaz = defaultRules('CONFAZ');
  const preambleBases = ['O Conselho', 'O Ministro', 'O Secretário', 'O Secretario', 'O Governador', 'O Presidente', 'A Secretária', 'A Secretaria', 'A Receita Federal', 'CONSIDERANDO', 'O Diretor', 'A Lei', 'Considerando'];
  // Review of PR #249: the two preamble changes of fef9d51 (word boundary after every start, flexible inner spaces)
  // were not approved and are reverted, so the preamble now has no difference at all, including the edge cases below.
  const edges = ['O Conselhox', 'A Receita Federal1', 'A  Receita  Federal', 'A\tReceita\tFederal', 'A\u00a0Receita Federal', 'A Receita\u00a0Federal',
    'CONSIDERANDOé', 'CONSIDERANDO_', 'CONSIDERANDO\u0301', 'A Secreta\u0301ria', 'O\u00a0Conselho', 'O\nConselho'];
  differential('preamble', LEGACY.preamble, dou.preamble, [...variants(preambleBases), ...sampleText.split('; '), ...edges]);
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
  const famProfiles = [...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source: 'RFB', family: 'Despacho' }, fields: { blockStarts: { preamble: [...defaults.blockStarts.preamble!, 'O Diretor'] } } }];
  assert.ok(!reasons(analyzeAnatomy(base(pre, 'RFB', { profiles: famProfiles }))).some((r) => r.startsWith('preamble')));
  assert.ok(reasons(analyzeAnatomy(base(pre, 'RFB', { profiles: famProfiles, family: 'Despacho' }))).includes('preamble:preamble_marker:prohibited'));
});

test('identity: ruleSetHash follows the effective profile; engineHash is the regenerated build hash', () => {
  const html = '<p class="TextoAcordo">Cláusula primeira NCM 8471.30.12.</p>';
  const a = analyzeAnatomy(base(html));
  const sameEffective = analyzeAnatomy(base(html, 'CONFAZ', { profiles: [...DEFAULT_PROFILES].reverse() }));
  assert.equal(sameEffective.identity.ruleSetHash, a.identity.ruleSetHash, 'same effective profile, any order');
  const changed = analyzeAnatomy(base(html, 'CONFAZ', { profiles: withSource('CONFAZ', { quotes: { open: ['"', '“', '«'], close: ['"', '”'], closeSuffix: ['(NR)'] } }) }));
  assert.notEqual(changed.identity.ruleSetHash, a.identity.ruleSetHash);
  assert.notEqual(changed.analysisId, a.analysisId);
  assert.equal(a.identity.engineHash, ANATOMY_ENGINE_BUILD_HASH);
  assert.notEqual(ANATOMY_ENGINE_BUILD_HASH, 'ad69d28524ad6478764b203dc962c9d8a0600fbeac07aa985854b18868ab9d9d', 'engine identity changed explicitly with P1.B');
  // The compiled rules carry the behaviour hash of the profile they came from.
  assert.equal(compileProfileRules({ fields: resolveEffectiveProfile([...DEFAULT_PROFILES], { source: 'CONFAZ' }).fields, effectiveHash: 'h' }, 'CONFAZ').effectiveHash, 'h');
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

// Review of PR #249 (GPT/Codex, BLOCK on fef9d51): the three findings, reproduced and closed with synthetic data only.
const codeOf = (fn: () => unknown): string => { try { fn(); } catch (e) { assert.ok(e instanceof ProfileValidationError, String(e)); return e.code; } return 'no-error'; };
const confazClasses = () => structuredClone((DEFAULT_PROFILES.find((p) => p.scope.level === 'source' && p.scope.source === 'CONFAZ')!.fields as { classes: Record<string, string[]> }).classes);
const shippedDefault = () => structuredClone(DEFAULT_PROFILES[0]!.fields) as unknown as Record<string, Record<string, string[]>>;
const src249 = (source: string, fields: unknown) => ({ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source' as const, source }, fields });
const partOf = (r: ReturnType<typeof analyzeAnatomy>, type: string) => r.parts.find((p) => p.type === type);

test('#249 finding 1: shipped context protections cannot be removed by configuration', () => {
  const historical = '<p class="RedaoAnt">Cláusula primeira NCM 8471.30.12.</p>';
  const epigraph = '<p class="TituloAcordo">Cláusula primeira NCM 8471.30.12.</p>';
  assert.equal(partOf(analyzeAnatomy(base(historical)), 'clause')?.context, 'historical');
  assert.equal(analyzeAnatomy(base(epigraph)).parts.find((p) => p.type === 'epigraph')?.context, 'prohibited');
  const noRedao = confazClasses(); noRedao.historical = noRedao.historical!.filter((c) => c !== 'RedaoAnt');
  const noTitulo = confazClasses(); noTitulo.epigraph = [];
  // Every public way to obtain or use matchers enforces the floor: the compiler itself refuses fields without the
  // shipped protections, so readAnatomyInput with compiled rules cannot reach the hazard of fef9d51 either.
  const unsafeFields = (classes: Record<string, string[]>) => ({ ...shippedDefault(), classes: { ...shippedDefault().classes, ...classes } }) as never;
  for (const classes of [noRedao, noTitulo]) {
    assert.equal(codeOf(() => compileProfileRules({ fields: unsafeFields(classes), effectiveHash: 'unsafe' }, 'CONFAZ')), 'protection_weakened');
  }
  // Hand-made or mutated rules objects are refused by the reader and the extractor; compiled rules are read-only.
  const real = defaultRules('CONFAZ');
  const forged = { ...real, classes: { ...real.classes, historical: new Set<string>(), epigraph: [] } };
  assert.throws(() => readAnatomyInput({ source: 'CONFAZ', representationId: 'x', html: historical, rules: forged }), /compileProfileRules/);
  assert.throws(() => extractAnatomyEntities({ canonicalText: 'NCM 8471.30.12', parts: [], ncmPartIds: [], rules: forged }), /compileProfileRules/);
  assert.throws(() => real.classes.historical.delete('RedaoAnt'), TypeError);
  assert.throws(() => { (real.classes as { epigraph: string[] }).epigraph.length = 0; }, TypeError);
  assert.throws(() => { (real as { classes: unknown }).classes = forged.classes; }, TypeError);
  assert.equal(readAnatomyInput({ source: 'CONFAZ', representationId: 'x', html: historical, rules: real }).parts.find((p) => p.type === 'clause')?.context, 'historical');
  // The engine always resolves the profile, and resolution refuses both configurations (source and family levels).
  for (const classes of [noRedao, noTitulo]) {
    assert.equal(codeOf(() => analyzeAnatomy(base(historical, 'CONFAZ', { profiles: withSource('CONFAZ', { classes }) }))), 'protection_weakened');
    const fam = [...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source: 'CONFAZ', family: 'Ajuste' }, fields: { classes } }];
    assert.equal(codeOf(() => analyzeAnatomy(base(historical, 'CONFAZ', { profiles: fam, family: 'Ajuste' }))), 'protection_weakened');
  }
  // Replacing the shipped default by a caller-supplied one cannot lower the floor either.
  assert.equal(codeOf(() => analyzeAnatomy(base(historical, 'CONFAZ', { profiles: [DEFAULT_PROFILES[0]!] }))), 'protection_weakened', 'CONFAZ classes missing');
  const noConsiderando = shippedDefault(); noConsiderando.blockStarts!.preamble = noConsiderando.blockStarts!.preamble!.filter((s) => s !== 'CONSIDERANDO');
  assert.equal(codeOf(() => resolveEffectiveProfile([{ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'default' }, fields: noConsiderando }], { source: 'RFB' })), 'protection_weakened');
  // Every protective field is covered: removing any shipped literal is refused, for every source.
  const floor: [string, string][] = [['classes', 'historical'], ['classes', 'editorialNote'], ['classes', 'epigraph'], ['classes', 'summary'], ['classes', 'signature'],
    ['blockStarts', 'preamble'], ['blockStarts', 'rectificationOriginal'], ['blockStarts', 'rectificationCorrected'], ['quotes', 'open'], ['ncm', 'columnBlockers'], ['exceptions', 'markers']];
  let checked = 0;
  for (const source of ['CONFAZ', 'DOU', 'DOE-SP', 'RFB'] as const) {
    const shipped = resolveEffectiveProfile([...DEFAULT_PROFILES], { source }).fields as unknown as Record<string, Record<string, string[]>>;
    for (const [g, f] of floor) for (const lit of shipped[g]![f]!) {
      const fields = { [g]: { [f]: shipped[g]![f]!.filter((x) => x !== lit) } };
      assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES.filter((p) => !(p.scope.level === 'source' && p.scope.source === source)), { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source },
        fields: { ...(DEFAULT_PROFILES.find((p) => p.scope.level === 'source' && p.scope.source === source)?.fields ?? {}), ...fields } }], { source })), 'protection_weakened', `${source} ${g}.${f} ${lit}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `${checked} removals checked`);
  // A new closing quote mark (or suffix) would end quotations earlier and expose quoted text: refused. Dropping one is safe.
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { quotes: { close: ['"', '”', '»'] } })], { source: 'RFB' })), 'protection_weakened');
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { quotes: { closeSuffix: ['(NR)', '(AC)'] } })], { source: 'RFB' })), 'protection_weakened');
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { quotes: { closeSuffix: [] } })], { source: 'RFB' })), 'no-error');
  // Adding protections stays allowed; a matcher-equivalent spelling of a shipped literal keeps it (EXCETO ≡ exceto).
  const markers = (shippedDefault().exceptions!.markers!).map((m) => (m === 'exceto' ? 'EXCETO' : m));
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { exceptions: { markers } })], { source: 'RFB' })), 'no-error');
  assert.equal(codeOf(() => analyzeAnatomy(base(historical, 'CONFAZ', { profiles: withSource('CONFAZ', { classes: { ...confazClasses(), historical: [...confazClasses().historical!, 'NovaHist'] } }) }))), 'no-error');
});

test('#249 finding 2: one normalisation — non-canonical literals are rejected, so validation and compiler agree', () => {
  const invalid: [string, unknown][] = [
    ['double space', src249('RFB', { blockStarts: { preamble: [...shippedDefault().blockStarts!.preamble!, 'O  Diretor'] } })],
    ['NBSP', src249('RFB', { blockStarts: { preamble: [...shippedDefault().blockStarts!.preamble!, 'O Diretor'] } })],
    ['NFD label', src249('RFB', { labels: { clause: ['Cláusula'] } })],
    ['NFD token', src249('RFB', { lists: { tokens: ['até'] } })],
    ['NFD class', src249('CONFAZ', { classes: { body: ['Remé'] } })],
    ['space in class', src249('CONFAZ', { classes: { body: ['Texto Acordo'] } })],
    ['space in quote', src249('RFB', { quotes: { open: ['"', '“', '« '] } })],
  ];
  for (const [name, p] of invalid) assert.equal(codeOf(() => validateProfile(p)), 'invalid_fields', name);
  // Duplicates are decided by the field's compiled matcher: case for words, case and spacing around "/" for NCM headers.
  assert.equal(codeOf(() => validateProfile(src249('RFB', { ncm: { columnHeaders: ['NCM/SH', 'ncm / sh'] } }))), 'semantic_conflict');
  assert.equal(codeOf(() => validateProfile(src249('RFB', { labels: { clause: ['Cláusula', 'CLÁUSULA'] } }))), 'semantic_conflict');
  // For accepted literals, "duplicate" means exactly "the compiled matcher of one accepts the other".
  const rules = (headers: string[]) => compileProfileRules(resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { ncm: { columnHeaders: headers } })], { source: 'RFB' }), 'RFB');
  assert.ok(rules(['NCM/SH']).ncmHeader.test('ncm / sh'));
  // Document text keeps flexible whitespace for labels and block starts: one canonical literal matches any run of
  // spaces, tabs or NBSP in the text. The preamble keeps its original rule (only the first space is flexible).
  const r = defaultRules('DOU');
  assert.ok(r.clause.test('Cláusula  primeira') && r.clause.test('Cláusula\u00a0primeira') && r.rectificationOriginal.test('Onde\tse lê'));
  assert.ok(r.preamble.test('A Receita Federal resolve') && r.preamble.test('A\tReceita Federal') && !r.preamble.test('A  Receita\tFederal resolve'));
  // The shipped defaults are canonical (they validate unchanged).
  for (const p of DEFAULT_PROFILES) assert.equal(codeOf(() => validateProfile(p)), 'no-error');
});

test('#249 finding 3: a header and a blocker that the reader treats alike cannot coexist', () => {
  const blockers = [...shippedDefault().ncm!.columnBlockers!];
  const conflict: [string, string[], string[]][] = [
    ['NCM/SH allowed, NCM / SH blocked', ['NCM/SH'], [...blockers, 'NCM / SH']],
    ['NCM / SH allowed, NCM/SH blocked', ['NCM / SH'], [...blockers, 'NCM/SH']],
    ['case and spacing', ['Código NCM/SH'], [...blockers, 'CÓDIGO NCM / SH']],
    ['blocker prefix before /', ['NCM / SH'], [...blockers, 'NCM']],
  ];
  for (const [name, columnHeaders, columnBlockers] of conflict) {
    assert.equal(codeOf(() => validateProfile(src249('RFB', { ncm: { columnHeaders, columnBlockers } }))), 'semantic_conflict', name);
  }
  // Across inheritance: a family blocker against an inherited header.
  const fam = { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family' as const, source: 'RFB', family: 'IN' }, fields: { ncm: { columnBlockers: [...blockers, 'NCM / SH'] } } };
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, fam], { source: 'RFB', family: 'IN' })), 'effective_conflict');
  // The compiled blocker treats "NCM / SH" and "NCM/SH" alike, as the compiled header does.
  const accepted = compileProfileRules(resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { ncm: { columnHeaders: ['NCM'], columnBlockers: [...blockers, 'NCM / SH'] } })], { source: 'RFB' }), 'RFB');
  for (const text of ['NCM/SH', 'NCM / SH', 'ncm  /  sh']) assert.ok(accepted.ncmBlocker.test(text), text);
  // Whatever validation accepts, no header text is also blocked: checked on every shipped header variant.
  for (const source of ['CONFAZ', 'DOU', 'DOE-SP', 'RFB'] as const) {
    const r = defaultRules(source);
    for (const h of shippedDefault().ncm!.columnHeaders!) for (const text of [h, h.toLowerCase(), h.replace('/', ' / ')]) assert.ok(r.ncmHeader.test(text) && !r.ncmBlocker.test(text), `${source} ${text}`);
  }
});

// Second remediation round (COORD handover, issue #116): public-path protections, document Unicode, header conflicts
// after inheritance and the restored preamble. Expected values below were produced by the pre-integration engine
// (585f5a49) on these same synthetic documents; they are not regenerated from the new engine.
test('#249 R2 / A: removing any protected marker is refused through analyzeAnatomy, at source and family level', () => {
  const html = '<p>x</p>';
  const cases: [AnatomyRequest['input']['source'], string, string, string][] = [
    ['CONFAZ', 'classes', 'editorialNote', 'DataPublicao'], ['CONFAZ', 'classes', 'summary', 'Ementa'], ['CONFAZ', 'classes', 'historical', 'RemissoAnt'],
    ['DOU', 'classes', 'signature', 'assina'], ['DOU', 'classes', 'epigraph', 'identifica'], ['DOU', 'blockStarts', 'rectificationOriginal', 'Onde se lê'],
    ['DOU', 'blockStarts', 'rectificationCorrected', 'Leia-se'], ['RFB', 'quotes', 'open', '“'], ['RFB', 'blockStarts', 'preamble', 'A Receita Federal'],
    ['RFB', 'ncm', 'columnBlockers', 'TIPI'], ['RFB', 'exceptions', 'markers', 'exceto'],
  ];
  for (const [source, g, f, lit] of cases) {
    const effective = resolveEffectiveProfile([...DEFAULT_PROFILES], { source }).fields as unknown as Record<string, Record<string, string[]>>;
    assert.ok(effective[g]![f]!.includes(lit), `${source} ${g}.${f} ships ${lit}`);
    const fields = { [g]: { [f]: effective[g]![f]!.filter((x) => x !== lit) } };
    assert.equal(codeOf(() => analyzeAnatomy(base(html, source, { profiles: withSource(source, fields) }))), 'protection_weakened', `source ${source} ${lit}`);
    const fam = [...DEFAULT_PROFILES, { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family', source, family: 'F' }, fields }];
    assert.equal(codeOf(() => analyzeAnatomy(base(html, source, { profiles: fam, family: 'F' }))), 'protection_weakened', `family ${source} ${lit}`);
    assert.equal(codeOf(() => analyzeAnatomy(base(html, source, { profiles: fam }))), 'no-error', 'family not requested');
  }
  // The shipped CONFAZ body classes already include RedaoAnt: being a body class never demotes a protected class.
  assert.ok(confazClasses().body!.includes('RedaoAnt'));
  assert.equal(partOf(analyzeAnatomy(base('<p class="RedaoAnt">Cláusula primeira NCM 8471.30.12.</p>')), 'clause')?.context, 'historical');
});

test('#249 R2 / B: document text is never normalised; matchers equal the pre-integration rules on decomposed text', () => {
  // Declared behaviour: canonical text, hashes and UTF-16 offsets are the supplied text. The compiled matchers are
  // unchanged (NFC literals, compared below with the original rules). Since UNICODE-01b/B2 (authorised, issue #116),
  // NFD documents are recognised through the exact NFC shadow and stay partial; before, they were unidentified.
  const nfd = analyzeAnatomy(base('<p>Cla\u0301usula primeira NCM 8471.30.12, exceto 8471.30.19.</p>'));
  assert.equal(nfd.canonicalText, 'Cla\u0301usula primeira NCM 8471.30.12, exceto 8471.30.19.\n');
  assert.notEqual(nfd.canonicalText, nfd.canonicalText.normalize('NFC'));
  assert.deepEqual(nfd.parts.map((p) => `${p.type}:${p.context}:${p.span.start}-${p.span.end}`), ['document:operative_candidate:0-54', 'clause:operative_candidate:0-54', 'caput:operative_candidate:0-54']); // ANAT-STRUCT-02: + caput of the clause
  assert.equal(nfd.status, 'partial');
  assert.ok(nfd.limitations.some((l) => l.code === 'nfc_shadow_matching'));
  assert.equal(nfd.eligibility.filter((e) => e.eligible).length, 0);
  for (const t of ['Cla\u0301usula primeira', 'Cláusula primeira', 'Cláusula\u00a0primeira', 'CONSIDERANDO\u0301', 'Onde se le\u0302', 'A Secreta\u0301ria']) {
    const r = defaultRules('DOU');
    assert.equal(r.clause.test(t), LEGACY.clause.test(t), `clause ${t}`);
    assert.equal(r.preamble.test(t), LEGACY.preamble.test(t), `preamble ${t}`);
    assert.equal(r.rectificationOriginal.test(t), LEGACY.rectificationOriginal.test(t), `rectification ${t}`);
  }
  // NBSP in the text is whitespace for flexible separators; offsets stay in UTF-16 units of the supplied text.
  const nbsp = analyzeAnatomy(base('<p>Cláusula\u00a0primeira NCM 8471.30.12.</p>'));
  const e = nbsp.entities.find((x) => x.domain === 'NCM')!;
  assert.equal(nbsp.canonicalText.slice(e.span.start, e.span.end), '8471.30.12');
  // Configuration: NFC literals only (NFD, NBSP, double spaces refused); accent variants stay distinct (até/ate).
  assert.equal(codeOf(() => validateProfile(src249('RFB', { lists: { tokens: ['até', 'ate'] } }))), 'no-error');
  assert.equal(codeOf(() => validateProfile(src249('RFB', { lists: { tokens: ['ate\u0301'] } }))), 'invalid_fields');
  // Classes and quotes compare exactly, case included.
  assert.equal(codeOf(() => validateProfile(src249('CONFAZ', { classes: { body: ['TextoAcordo', 'textoacordo'] } }))), 'no-error');
});

test('#249 R2 / C: header/blocker conflicts across inheritance, case and spacing; CÓDIGO NCM vs CÓDIGO stays valid', () => {
  const blockers = [...shippedDefault().ncm!.columnBlockers!];
  // Source-level header against the default blockers, and default-level blocker against a source header.
  assert.equal(codeOf(() => resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { ncm: { columnHeaders: ['NCM', 'tipi / x'] } })], { source: 'RFB' })), 'effective_conflict');
  const def = { ...DEFAULT_PROFILES[0]!, fields: { ...DEFAULT_PROFILES[0]!.fields, ncm: { ...(DEFAULT_PROFILES[0]!.fields as { ncm: object }).ncm, columnBlockers: [...blockers, 'naladi'] } } };
  assert.equal(codeOf(() => resolveEffectiveProfile([def, ...DEFAULT_PROFILES.slice(1)], { source: 'DOU' })), 'no-error');
  assert.equal(codeOf(() => resolveEffectiveProfile([def, ...withSource('DOU', { ncm: { columnHeaders: ['NCM', 'NALADI / SH'] } }).filter((p) => p.scope.level !== 'default')], { source: 'DOU' })), 'effective_conflict');
  // Family header against a source blocker (spacing reversed).
  const famProfiles = [...DEFAULT_PROFILES, src249('DOE-SP', { ncm: { columnBlockers: [...blockers, 'NALADI/SH'] } }),
    { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'family' as const, source: 'DOE-SP', family: 'Portaria' }, fields: { ncm: { columnHeaders: ['NCM', 'naladi / sh'] } } }];
  assert.equal(codeOf(() => resolveEffectiveProfile(famProfiles, { source: 'DOE-SP', family: 'Portaria' })), 'effective_conflict');
  assert.equal(codeOf(() => resolveEffectiveProfile(famProfiles, { source: 'DOE-SP' })), 'no-error');
  // Legitimate: blocker CÓDIGO only blocks "CÓDIGO" or "CÓDIGO/…", never "CÓDIGO NCM" (isolated and after inheritance).
  assert.equal(codeOf(() => validateProfile(src249('RFB', { ncm: { columnHeaders: ['CÓDIGO NCM', 'Código NCM / SH'], columnBlockers: ['CÓDIGO'] } }))), 'no-error');
  const ok = compileProfileRules(resolveEffectiveProfile([...DEFAULT_PROFILES, src249('RFB', { ncm: { columnHeaders: ['CÓDIGO NCM'] } })], { source: 'RFB' }), 'RFB');
  assert.ok(ok.ncmHeader.test('código  ncm') && !ok.ncmBlocker.test('código ncm') && ok.ncmBlocker.test('CÓDIGO / x'));
});

test('#249 R2: restored preamble — engine output equals the pre-integration engine on adversarial synthetic documents', () => {
  const docs: [string, AnatomyRequest['input']['source'], string][] = [
    ['preamble-glued', 'RFB', '<p>O Conselhox resolve NCM 8471.30.12.</p><p>A Receita Federal1 NCM 8471.30.12</p>'],
    ['preamble-spaces', 'RFB', '<p>A  Receita  Federal informa NCM 8471.30.12.</p><p>A\tReceita\tFederal NCM 8471.30.12</p><p>A\u00a0Receita Federal NCM 8471.30.12</p>'],
    ['considerando', 'DOU', '<p>CONSIDERANDOé x NCM 8471.30.12</p><p>CONSIDERANDO_ x</p><p>CONSIDERANDOS x</p><p>Considerando que NCM 8471.30.12</p>'],
  ];
  const expected: Record<string, string[]> = {"preamble-glued": ["document:document:operative_candidate", "preamble:preamble_marker:prohibited", "preamble:preamble_marker:prohibited"], "preamble-spaces": ["document:document:operative_candidate", "unidentified:unrecognized_block:unknown", "unidentified:unrecognized_block:unknown", "preamble:preamble_marker:prohibited"], "considerando": ["document:document:operative_candidate", "preamble:preamble_marker:prohibited", "unidentified:unrecognized_block:unknown", "unidentified:unrecognized_block:unknown", "consideration:consideration_marker:prohibited"]};
  // ANAT-STRUCT-01: the only change from the pre-integration value. "Considerando que" (the whole word) is typed as a
  // consideration with the same prohibited context; the glued "CONSIDERANDOé/_/S" variants keep their frozen results.
  for (const [id, source, html] of docs) assert.deepEqual(reasons(analyzeAnatomy(base(html, source))), expected[id], id);
});
