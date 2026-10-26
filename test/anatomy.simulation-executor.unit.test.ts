import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ANATOMY_ENGINE_BUILD_HASH } from '../src/modules/anatomy/build-identity.js';
import { DEFAULT_PROFILES } from '../src/modules/anatomy/profile.js';
import { compareProfiles, simulateProfiles, type SimulationExample } from '../src/modules/anatomy/rules-simulation.js';
import { EXECUTOR_LIMITS, ExecutorError, SimulationExecutor, type ExecutorOptions, type WorkerDiagnostics } from '../src/modules/anatomy/simulation-executor.js';

// ANAT-ADMIN-01 P3-C (issue #116). SYNTHETIC examples only: no corpus, gold or reserve is read.
const E = ANATOMY_ENGINE_BUILD_HASH;
const profiles = () => structuredClone([...DEFAULT_PROFILES]) as unknown[];
const ex = (id: string, over: Partial<SimulationExample> = {}): SimulationExample => ({ id, purpose: 'sintético', polarity: 'positive', source: 'DOU',
  input: { html: '<p>Art. 1º NCM 8471.41.00.</p>' }, expect: [{ kind: 'part', type: 'article' }], ...over });
// Quarantined input: a non-NFC decoded attribute (UNICODE-01a) suspends extraction; the result is `partial`.
const quarantined = '<p title="a&#x301;">Art. 1º NCM 8471.41.00.</p>';
const support = (f: string) => new URL(`./support/${f}`, import.meta.url);
const adversarial = (o: ExecutorOptions = {}) => new SimulationExecutor({ workerUrl: support('anatomy-adversarial-worker.ts'), ...o });
const codeOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { assert.ok(e instanceof ExecutorError, String(e)); return e.code; } return 'no-error'; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('P2 adjustment: suspended extraction is inconclusive unless the limitation is explicitly expected (§2.5)', () => {
  const negative = ex('neg-q', { polarity: 'negative', input: { html: quarantined }, expect: [{ kind: 'entity', domain: 'NCM' }] });
  const declared = ex('pos-q', { input: { html: quarantined }, expect: [{ kind: 'limitation', code: 'non_nfc_text' }] });
  const undeclared = ex('pos-u', { input: { html: quarantined }, expect: [{ kind: 'part', type: 'document' }] });
  const complete = ex('ok', { expect: [{ kind: 'entity', domain: 'NCM' }] });
  const r = simulateProfiles({ profiles: profiles(), examples: [negative, declared, undeclared, complete] });
  // The negative example "passed" before P3-C only because extraction was suspended; now it is inconclusive.
  assert.deepEqual(r.outcomes.map((o) => [o.id, o.resultStatus, o.status]),
    [['neg-q', 'partial', 'inconclusive'], ['pos-q', 'partial', 'pass'], ['pos-u', 'partial', 'inconclusive'], ['ok', 'complete', 'pass']]);
  assert.deepEqual(r.summary, { pass: 2, fail: 0, partial: 0, inconclusive: 2 });
  assert.ok(r.outcomes.every((o) => /^[a-f0-9]{64}$/u.test(o.analysisId) && /^[a-f0-9]{64}$/u.test(o.inputTextHash)));
  // A failing expectation stays `fail` (informative), even on a partial result.
  const wrong = simulateProfiles({ profiles: profiles(), examples: [ex('pos-w', { input: { html: quarantined }, expect: [{ kind: 'entity', domain: 'NCM' }] })] });
  assert.equal(wrong.outcomes[0]!.status, 'fail');
});

test('P3-C executor: valid path in isolated workers matches the in-process engine (determinism, identity, empty env)', async () => {
  const seen: WorkerDiagnostics[] = [];
  const x = new SimulationExecutor({ onWorkerReady: (d) => seen.push(d) });
  try {
    const examples = [ex('a'), ex('b', { polarity: 'negative', input: { html: quarantined }, expect: [{ kind: 'entity', domain: 'NCM' }] }),
      ex('c', { input: { html: quarantined }, expect: [{ kind: 'limitation', code: 'non_nfc_text' }] })];
    const run = await x.simulate({ profiles: profiles(), examples, expectedEngineHash: E });
    const local = simulateProfiles({ profiles: profiles(), examples });
    assert.equal(run.status, 'complete');
    assert.deepEqual(run.rows.map((r) => [r.exampleId, r.outcome]), [['a', 'pass'], ['b', 'inconclusive'], ['c', 'pass']]);
    assert.deepEqual(run.rows.map((r) => [r.outputHash, r.analysisId, r.inputTextHash, r.ruleSetHash]),
      local.outcomes.map((o) => [o.outputHash, o.analysisId, o.inputTextHash, o.ruleSetHash]), 'same engine output in a worker');
    assert.equal(run.profileSetHash, local.profileSetHash);
    assert.ok(run.rows.every((r) => r.engineHash === E));
    assert.equal(seen.length, 3, 'one worker per example');
    for (const d of seen) {
      assert.equal(d.engineHash, E); assert.equal(d.envKeys, 0, 'explicitly empty environment: no secrets');
      // TypeScript sources need the loader; nothing inherited from the test runner (compiled builds pass []).
      assert.deepEqual(d.execArgv, ['--import', 'tsx']);
    }
    assert.deepEqual(x.stats(), { active: 0, queued: 0, liveWorkers: 0, lateMessages: 0, closed: false });
    console.log(`P3-C timings (ms): ${JSON.stringify(run.timings.map((t) => ({ id: t.exampleId, startup: Math.round(t.startupMs), run: Math.round(t.runMs) })))}`);
  } finally { await x.close(); }
});

test('P3-C executor: effective per-example timeout at the real 2 s budget, worker stopped before the slot is freed', async () => {
  const x = adversarial();
  try {
    const t0 = performance.now();
    const run = await x.simulate({ profiles: profiles(), examples: [ex('slow-6000'), ex('fast')], expectedEngineHash: E });
    const elapsed = performance.now() - t0;
    assert.deepEqual(run.rows.map((r) => [r.exampleId, r.outcome, r.reason]), [['slow-6000', 'cancelled', 'timeout'], ['fast', 'pass', null]]);
    assert.equal(run.status, 'partial');
    const stop = run.timings[0]!.runMs;
    // Forced stop at budget + margin; terminate() is awaited before the result is reported.
    assert.ok(stop >= EXECUTOR_LIMITS.perExampleMs && stop < EXECUTOR_LIMITS.perExampleMs + EXECUTOR_LIMITS.marginMs + 500, `stop after ${stop} ms`);
    assert.equal(x.stats().liveWorkers, 0); assert.equal(x.stats().active, 0);
    console.log(`P3-C timeout margin: budget ${EXECUTOR_LIMITS.perExampleMs} ms + margin ${EXECUTOR_LIMITS.marginMs} ms; observed stop ${Math.round(stop)} ms; request ${Math.round(elapsed)} ms`);
  } finally { await x.close(); }
});

test('P3-C executor: event loop stays responsive while a worker burns CPU', async () => {
  const x = adversarial({ perExampleMs: 1500 });
  try {
    let worst = 0; let last = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 20);
    const run = await x.simulate({ profiles: profiles(), examples: [ex('slow-1000')], expectedEngineHash: E });
    clearInterval(tick);
    assert.equal(run.rows[0]!.outcome, 'pass');
    assert.ok(worst < 150, `worst event-loop gap ${Math.round(worst)} ms`);
    console.log(`P3-C event loop: worst 20 ms-tick gap during a 1 s CPU-bound worker = ${Math.round(worst)} ms`);
  } finally { await x.close(); }
});

test('P3-C executor: client abort cancels the running worker and the rest; late and foreign messages are never accepted', async () => {
  const x = adversarial();
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const run = await x.simulate({ profiles: profiles(), examples: [ex('slow-5000'), ex('fast')], expectedEngineHash: E }, ac.signal);
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(run.rows.map((r) => [r.outcome, r.reason]), [['cancelled', 'aborted'], ['cancelled', 'aborted']]);
    assert.ok(run.rows.every((r) => r.outputHash === null));
    assert.equal(x.stats().liveWorkers, 0);
    const late = await x.simulate({ profiles: profiles(), examples: [ex('late')], expectedEngineHash: E });
    assert.equal(late.rows[0]!.outcome, 'pass', 'the genuine reply is used');
    assert.equal(x.stats().lateMessages, 1, 'the out-of-sequence reply was discarded');
    assert.equal(await codeOf(x.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E }, AbortSignal.abort())), 'ABORTED');
  } finally { await x.close(); }
});

test('P3-C executor: queue of 10 behind 2 slots, QUEUE_FULL, QUEUE_TIMEOUT, abort while queued, capacity recovers', async () => {
  const x = adversarial({ queueWaitMs: 5000 });
  try {
    const run = (id: string) => x.simulate({ profiles: profiles(), examples: [ex(id)], expectedEngineHash: E });
    const running = [run('slow-700'), run('slow-700')];
    await sleep(50);
    const queued = Array.from({ length: 10 }, () => run('a'));
    assert.deepEqual(x.stats().queued, 10);
    assert.equal(await codeOf(run('a')), 'QUEUE_FULL');
    const all = await Promise.allSettled([...running, ...queued]);
    assert.ok(all.every((r) => r.status === 'fulfilled' && r.value.status === 'complete'));
    assert.deepEqual(x.stats(), { active: 0, queued: 0, liveWorkers: 0, lateMessages: 0, closed: false });
  } finally { await x.close(); }
  const y = adversarial({ queueWaitMs: 300 });
  try {
    const hold = [0, 1].map(() => y.simulate({ profiles: profiles(), examples: [ex('slow-1200')], expectedEngineHash: E }));
    await sleep(50);
    assert.equal(await codeOf(y.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E })), 'QUEUE_TIMEOUT');
    const ac = new AbortController();
    const waiting = y.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E }, ac.signal);
    await sleep(20); ac.abort();
    assert.equal(await codeOf(waiting), 'ABORTED');
    await Promise.all(hold);
    // Failures never leak a slot or a worker: crash, throw, OOM, then a normal run.
    for (const id of ['crash', 'throw', 'oom']) await y.simulate({ profiles: profiles(), examples: [ex(id)], expectedEngineHash: E });
    assert.equal((await y.simulate({ profiles: profiles(), examples: [ex('a'), ex('b')], expectedEngineHash: E })).status, 'complete');
    assert.deepEqual([y.stats().active, y.stats().liveWorkers, y.stats().queued], [0, 0, 0]);
  } finally { await y.close(); }
});

test('P3-C executor: invalid, excessive, tampered and foreign-engine outputs; OOM; start-up hang; total deadline', async () => {
  const x = adversarial();
  try {
    const one = async (id: string) => (await x.simulate({ profiles: profiles(), examples: [ex(id)], expectedEngineHash: E })).rows[0]!;
    assert.deepEqual(await one('huge').then((r) => [r.outcome, r.reason]), ['failed', 'limit_exceeded']);
    assert.deepEqual(await one('tampered').then((r) => [r.outcome, r.reason]), ['failed', 'invalid_output']);
    assert.deepEqual(await one('engine').then((r) => [r.outcome, r.reason]), ['failed', 'engine_mismatch']);
    assert.deepEqual(await one('crash').then((r) => [r.outcome, r.reason]), ['failed', 'worker_exit']);
    assert.deepEqual(await one('throw').then((r) => [r.outcome, r.reason]), ['failed', 'worker_error']);
    assert.deepEqual(await one('oom').then((r) => [r.outcome, r.reason]), ['cancelled', 'memory']);
  } finally { await x.close(); }
  const foreign = new SimulationExecutor({ workerUrl: support('anatomy-foreign-engine-worker.ts') });
  try {
    const run = await foreign.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E });
    assert.deepEqual([run.status, run.rows[0]!.reason], ['failed', 'engine_mismatch']);
  } finally { await foreign.close(); }
  const silent = new SimulationExecutor({ workerUrl: support('anatomy-silent-worker.ts'), startupMs: 400 });
  try {
    const run = await silent.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E });
    assert.deepEqual([run.rows[0]!.outcome, run.rows[0]!.reason], ['cancelled', 'startup']);
    assert.equal(silent.stats().liveWorkers, 0);
  } finally { await silent.close(); }
  const tight = adversarial({ totalMs: 1500 });
  try {
    const run = await tight.simulate({ profiles: profiles(), examples: [ex('slow-5000'), ex('a'), ex('b')], expectedEngineHash: E });
    assert.equal(run.status, 'partial');
    assert.deepEqual(run.rows.map((r) => [r.outcome, r.reason]), [['cancelled', 'deadline'], ['cancelled', 'deadline'], ['cancelled', 'deadline']]);
  } finally { await tight.close(); }
});

test('P3-C executor: comparison runs both sides in workers, counts both in the deadline, equals the in-process comparison', async () => {
  const x = new SimulationExecutor();
  try {
    const after = profiles(); (after[0] as { fields: Record<string, unknown> }).fields = { ...(after[0] as { fields: Record<string, unknown> }).fields };
    const example = ex('cmp');
    const run = await x.compare({ example, before: profiles(), after, expectedEngineHash: E });
    assert.equal(run.status, 'complete');
    if (run.status === 'complete') assert.deepEqual(run.comparison, compareProfiles({ example, before: profiles(), after }));
  } finally { await x.close(); }
  const y = adversarial({ totalMs: 2000 });
  try {
    const run = await y.compare({ example: ex('slow-1200'), before: profiles(), after: profiles(), expectedEngineHash: E });
    assert.deepEqual(run.status === 'complete' ? 'complete' : [run.status, run.reason], ['cancelled', 'deadline'], 'second side hits the shared deadline');
  } finally { await y.close(); }
});

test('P3-C executor: input limits and engine refused before any worker starts', async () => {
  const x = new SimulationExecutor();
  try {
    const sim = (p: unknown, e: unknown, h = E) => codeOf(x.simulate({ profiles: p, examples: e, expectedEngineHash: h }));
    assert.equal(await sim(profiles(), [ex('a')], 'f'.repeat(64)), 'ENGINE_MISMATCH');
    assert.equal(await sim(profiles(), Array.from({ length: 21 }, (_, i) => ex(`x${i}`))), 'LIMIT_EXCEEDED');
    assert.equal(await sim([], [ex('a')]), 'INVALID_INPUT');
    assert.equal(await sim([{ big: 'x'.repeat(70 * 1024) }], [ex('a')]), 'LIMIT_EXCEEDED');
    assert.equal(await sim(profiles(), [ex('12')]), 'INVALID_INPUT', 'reserved id');
    assert.equal(await sim(profiles(), [ex('a'), ex('a')]), 'INVALID_INPUT');
    assert.equal(await sim(profiles(), [ex('a', { catalog: { edition: 's', codes: Array.from({ length: 20001 }, (_, i) => String(10000000 + i)) } })]), 'LIMIT_EXCEEDED');
    assert.equal(await sim([{ profileVersion: 'nope' }], [ex('a')]), 'INVALID_INPUT');
    assert.equal(await sim(profiles(), [ex('a', { input: { text: 'x'.repeat(256 * 1024 + 1) } })]), 'INVALID_INPUT');
    assert.equal(x.stats().liveWorkers, 0);
    await x.close();
    assert.equal(await sim(profiles(), [ex('a')]), 'CLOSED');
  } finally { await x.close(); }
});

test('P3-C executor: close() rejects the queue and stops running workers', async () => {
  const x = adversarial();
  const running = [0, 1].map(() => x.simulate({ profiles: profiles(), examples: [ex('slow-5000')], expectedEngineHash: E }));
  await sleep(100);
  const queued = codeOf(x.simulate({ profiles: profiles(), examples: [ex('a')], expectedEngineHash: E }));
  await x.close();
  assert.equal(await queued, 'CLOSED');
  for (const r of await Promise.all(running)) assert.deepEqual([r.status, r.rows[0]!.outcome, r.rows[0]!.reason], ['cancelled', 'cancelled', 'closed']);
  assert.equal(x.stats().liveWorkers, 0);
});

test('P3-C worker import graph: only pure anatomy modules and allow-listed packages (no fs, net, http, child_process, pg)', async () => {
  const allowed = new Set(['zod', 'htmlparser2', 'node:crypto', 'node:worker_threads']);
  const seen = new Set<string>(); const external = new Set<string>();
  const visit = async (url: URL) => {
    if (seen.has(url.href)) return; seen.add(url.href);
    const src = await readFile(url, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/gu)) {
      const spec = m[1] ?? m[2]!;
      if (spec.startsWith('.')) await visit(new URL(spec.replace(/\.js$/u, '.ts'), url)); else external.add(spec);
    }
    assert.doesNotMatch(src, /\brequire\s*\(|process\.binding|import\.meta\.resolve/u, `${url.pathname} uses a dynamic loader`);
  };
  await visit(new URL('../src/modules/anatomy/simulation-worker.ts', import.meta.url));
  assert.deepEqual([...external].filter((s) => !allowed.has(s)), [], `unexpected imports: ${[...external].join(', ')}`);
  const files = [...seen].map((u) => u.split('/').pop()).sort();
  assert.ok(files.includes('engine.ts') && !files.includes('simulation-executor.ts'), files.join(','));
  console.log(`P3-C worker graph: ${files.length} first-party modules; external: ${[...external].sort().join(', ')}`);
});
