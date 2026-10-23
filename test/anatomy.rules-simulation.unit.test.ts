import assert from 'node:assert/strict';
import test from 'node:test';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import { DEFAULT_PROFILES, PROFILE_FORMAT_VERSION } from '../src/modules/anatomy/profile.js';
import {
  compareProfiles, RESERVED_ENTRY_IDS, reviewDifferences, SIMULATION_LIMITS, simulateProfiles, SimulationError, type SimulationExample,
} from '../src/modules/anatomy/rules-simulation.js';

// ANAT-ADMIN-01 / P2 (issue #116). SYNTHETIC examples only: no corpus entry, gold or reserve is read.
const defaults = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
const withRfb = (fields: unknown) => [...defaults().filter((p) => !((p as { scope: { level: string; source?: string } }).scope.level === 'source'
  && (p as { scope: { source?: string } }).scope.source === 'RFB')), { profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' }, fields }];
const rfbBlockers = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { ncm: { columnHeaders: string[]; columnBlockers: string[] } }).ncm;
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof SimulationError, String(e)); return e.code; } return 'no-error'; };

const table: SimulationExample = { id: 'col-classificacao', purpose: 'coluna NCM chamada Classificacao', polarity: 'positive', source: 'RFB',
  input: { html: '<table><tr><td>Classificacao</td></tr><tr><td>8471.30.12</td></tr></table>' },
  expect: [{ kind: 'entity', domain: 'NCM', literal: '8471.30.12' }], catalog: { edition: 'syn', codes: ['84713012'] } };
const negative: SimulationExample = { id: 'neg-signature', purpose: 'assinatura nunca gera NCM', polarity: 'negative', source: 'DOU',
  input: { html: '<p class="assina">NCM 8471.30.12</p>' }, expect: [{ kind: 'entity', domain: 'NCM' }] };
const exception: SimulationExample = { id: 'exc', purpose: 'excecao mantida', polarity: 'positive', source: 'RFB',
  input: { html: '<p>Art. 1o NCM 8471.41.00, exceto 8471.30.12.</p>' }, expect: [{ kind: 'entity', domain: 'NCM_EXCEPTION', relation: 'exception' }, { kind: 'part', type: 'article', context: 'operative_candidate' }] };
const candidate = withRfb({ ncm: { columnHeaders: [...rfbBlockers.columnHeaders, 'Classificacao'] } });

test('P2 simulation: positive and negative examples against a candidate profile, with engine and profile hashes', () => {
  const before = simulateProfiles({ profiles: defaults(), examples: [table, negative, exception] });
  assert.deepEqual(before.outcomes.map((o) => [o.id, o.status]), [['col-classificacao', 'fail'], ['neg-signature', 'pass'], ['exc', 'pass']]);
  const after = simulateProfiles({ profiles: candidate, examples: [table, negative, exception] });
  assert.deepEqual(after.outcomes.map((o) => [o.id, o.status]), [['col-classificacao', 'pass'], ['neg-signature', 'pass'], ['exc', 'pass']]);
  assert.equal(after.engineHash, ANATOMY_ENGINE_BUILD_HASH);
  assert.notEqual(after.profileSetHash, before.profileSetHash);
  assert.notEqual(after.outcomes[0]!.effectiveProfileHash, before.outcomes[0]!.effectiveProfileHash, 'RFB effective profile changed');
  assert.equal(after.outcomes[1]!.effectiveProfileHash, before.outcomes[1]!.effectiveProfileHash, 'DOU effective profile unchanged');
  assert.deepEqual(after.summary, { pass: 3, fail: 0, partial: 0 });
  for (const o of after.outcomes) assert.equal(o.positiveSelections, 0);
});

test('P2 simulation: deterministic and isolated (no state shared between runs or examples; inputs not mutated)', () => {
  const profiles = candidate; const examples = [table, negative, exception];
  const frozenProfiles = JSON.stringify(profiles); const frozenExamples = JSON.stringify(examples);
  const a = simulateProfiles({ profiles, examples });
  const b = simulateProfiles({ profiles, examples: [...examples].reverse() });
  const c = simulateProfiles({ profiles, examples });
  const strip = (r: ReturnType<typeof simulateProfiles>) => r.outcomes.map(({ id, status, checks, ruleSetHash, outputHash }) => ({ id, status, checks, ruleSetHash, outputHash }));
  assert.deepEqual(strip(a), strip(c), 'same input, same report');
  assert.deepEqual(strip(b).sort((x, y) => x.id.localeCompare(y.id)), strip(a).sort((x, y) => x.id.localeCompare(y.id)), 'order does not leak between examples');
  // A run with a different profile in between does not affect the next run.
  simulateProfiles({ profiles: defaults(), examples });
  assert.deepEqual(strip(simulateProfiles({ profiles, examples })), strip(a));
  assert.equal(JSON.stringify(profiles), frozenProfiles); assert.equal(JSON.stringify(examples), frozenExamples);
});

test('P2 simulation: invalid profiles and inputs are rejected fail-closed', () => {
  const invalid: [string, unknown[]][] = [
    ['regex-like / unknown field', withRfb({ ncm: { pattern: ['.*'] } })],
    ['below the protection floor', withRfb({ ncm: { columnBlockers: [] } })],
    ['header also blocked', withRfb({ ncm: { columnHeaders: ['NCM'], columnBlockers: [...rfbBlockers.columnBlockers, 'NCM'] } })],
    ['no default', [{ profileVersion: PROFILE_FORMAT_VERSION, scope: { level: 'source', source: 'RFB' }, fields: {} }]],
  ];
  for (const [name, profiles] of invalid) assert.equal(codeOf(() => simulateProfiles({ profiles, examples: [table] })), 'invalid_profile', name);
  const bad: [string, unknown][] = [
    ['reserved id', { ...table, id: RESERVED_ENTRY_IDS[0] }],
    ['no expectation', { ...table, expect: [] }],
    ['both html and text', { ...table, input: { html: '<p>x</p>', text: 'x' } }],
    ['corpus reference field', { ...table, corpusEntryId: '01' }],
  ];
  for (const [name, e] of bad) assert.equal(codeOf(() => simulateProfiles({ profiles: defaults(), examples: [e as SimulationExample] })), 'invalid_input', name);
  assert.equal(codeOf(() => simulateProfiles({ profiles: defaults(), examples: Array.from({ length: SIMULATION_LIMITS.maxExamples + 1 }, (_, i) => ({ ...table, id: `e${i}` })) })), 'invalid_input', 'too many');
  assert.equal(codeOf(() => simulateProfiles({ profiles: defaults(), examples: [table, table] })), 'invalid_input', 'duplicate id');
});

test('P2 simulation: time budget marks an example partial (2 s per example)', () => {
  let t = 0; const clock = () => (t += 1500);
  const r = simulateProfiles({ profiles: defaults(), examples: [negative] }, clock);
  assert.equal(r.outcomes[0]!.status, 'pass', '1.5 s is within the budget');
  let u = 0; const slow = () => (u += 2500);
  const s = simulateProfiles({ profiles: defaults(), examples: [negative] }, slow);
  assert.deepEqual([s.outcomes[0]!.status, s.outcomes[0]!.timedOut], ['partial', true]);
});

test('P2 comparison: parts, entities, relations, limitations and eligibility, identified by hashes', () => {
  const c = compareProfiles({ example: table, before: defaults(), after: candidate });
  assert.equal(c.before.engineHash, ANATOMY_ENGINE_BUILD_HASH); assert.equal(c.after.engineHash, ANATOMY_ENGINE_BUILD_HASH);
  assert.notEqual(c.before.ruleSetHash, c.after.ruleSetHash);
  assert.notEqual(c.beforeProfileSetHash, c.afterProfileSetHash);
  const cats = new Set(c.differences.map((d) => d.category));
  assert.ok(cats.has('entity') && cats.has('eligibility'), [...cats].join(','));
  const added = c.differences.find((d) => d.category === 'entity' && d.change === 'added')!;
  assert.match(added.key, /^NCM@/u);
  // The new NCM eligibility entry is NOT positive: no selection without legal evidence.
  const elig = c.differences.find((d) => d.category === 'eligibility' && d.change === 'added')!;
  assert.equal((elig.after as { eligible: boolean }).eligible, false);
  // Relations: removing an exception marker is refused by the floor; adding one changes relations.
  const menos: SimulationExample = { ...exception, id: 'menos', input: { html: '<p>Art. 1o NCM 8471.41.00, menos 8471.30.12.</p>' } };
  const markers = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { exceptions: { markers: string[] }; lists: { tokens: string[] } });
  const r = compareProfiles({ example: menos, before: defaults(), after: withRfb({ exceptions: { markers: [...markers.exceptions.markers, 'menos'] } }) });
  assert.ok(r.differences.some((d) => d.category === 'relation'), 'relation differences reported');
  // Same profiles: no difference, same comparison id each time (deterministic).
  const same = compareProfiles({ example: exception, before: defaults(), after: defaults() });
  assert.deepEqual(same.differences, []);
  assert.equal(compareProfiles({ example: exception, before: defaults(), after: defaults() }).id, same.id);
  // Limitations: a new block start turns an unidentified block into a preamble, removing unidentified_content.
  const pre: SimulationExample = { ...negative, id: 'pre', source: 'RFB', input: { html: '<p>O Diretor resolve.</p>' } };
  const pd = (DEFAULT_PROFILES.find((p) => p.scope.level === 'default')!.fields as { blockStarts: { preamble: string[] } }).blockStarts;
  const l = compareProfiles({ example: pre, before: defaults(), after: withRfb({ blockStarts: { ...pd, preamble: [...pd.preamble, 'O Diretor'] } }) });
  assert.ok(l.differences.some((d) => d.category === 'limitation' && d.change === 'removed' && d.key.startsWith('unidentified_content')), JSON.stringify(l.differences.map((d) => d.key)));
  assert.ok(l.differences.some((d) => d.category === 'part'));
});

test('P2 review: explicit classification; counts never decide; unknown ids and tampered comparisons refused', () => {
  const c = compareProfiles({ example: table, before: defaults(), after: candidate });
  assert.ok(c.differences.length >= 2);
  const none = reviewDifferences(c, []);
  assert.equal(none.verdict, 'incomplete', 'unclassified differences are not_evaluated');
  const allExpected = reviewDifferences(c, c.differences.map((d) => ({ differenceId: d.id, decision: 'expected', note: 'nova coluna esperada' })));
  assert.equal(allExpected.verdict, 'clear');
  const oneRegression = reviewDifferences(c, c.differences.map((d, i) => ({ differenceId: d.id, decision: i === 0 ? 'regression' : 'expected' })));
  assert.equal(oneRegression.verdict, 'blocked');
  // Count change alone decides nothing: more entities "after" and all differences unreviewed → incomplete, not regression.
  assert.ok(c.counts.entity.after > c.counts.entity.before);
  assert.equal(none.totals.regression, 0);
  assert.equal(codeOf(() => reviewDifferences(c, [{ differenceId: 'nope', decision: 'expected' }])), 'invalid_input');
  assert.equal(codeOf(() => reviewDifferences(c, [{ differenceId: c.differences[0]!.id, decision: 'expected' }, { differenceId: c.differences[0]!.id, decision: 'regression' }])), 'invalid_input');
  assert.equal(codeOf(() => reviewDifferences(c, [{ differenceId: c.differences[0]!.id, decision: 'maybe' }])), 'invalid_input');
  const tampered = { ...c, differences: c.differences.slice(1) };
  assert.equal(codeOf(() => reviewDifferences(tampered, [])), 'invalid_input', 'review is bound to the exact comparison');
});
