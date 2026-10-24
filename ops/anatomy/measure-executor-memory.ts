/**
 * ANAT-ADMIN-01 integration package 4: memory of the simulation executor under synthetic load (issue tribusca-control#116).
 * No database, no corpus, no network. Runs N rounds of `concurrency + queueLimit` simultaneous simulations, each with
 * 20 synthetic examples near the per-example input limit, and samples the process RSS (main thread + worker threads)
 * every 25 ms. Prints one JSON line. The peak is what THIS run observed, not a guaranteed ceiling (RSS also depends on
 * the allocator, the Node version and the input shape); outcomes are counted with the reason each row recorded. Usage: node --import tsx ops/anatomy/measure-executor-memory.ts [rounds] [inputKiB]
 */
import { ANATOMY_ENGINE_BUILD_HASH } from '../../src/modules/anatomy/build-identity.js';
import { DEFAULT_PROFILES } from '../../src/modules/anatomy/profile.js';
import { SIMULATION_LIMITS } from '../../src/modules/anatomy/rules-simulation.js';
import { EXECUTOR_LIMITS, SimulationExecutor } from '../../src/modules/anatomy/simulation-executor.js';

const rounds = Number(process.argv[2] ?? 3);
const inputKiB = Number(process.argv[3] ?? 240);
// Synthetic legal-looking text: articles, paragraphs and NCM-like codes, repeated up to the requested size.
const unit = '<p>Art. 1º Fica alterada a alíquota do código NCM 8471.41.00 conforme o Anexo I.</p><p>§ 1º O disposto aplica-se a partir de 1º de janeiro.</p>';
const html = unit.repeat(Math.ceil((inputKiB * 1024) / unit.length)).slice(0, Math.min(inputKiB * 1024, SIMULATION_LIMITS.maxInputUtf16));
const examples = Array.from({ length: SIMULATION_LIMITS.maxExamples }, (_, i) => ({
  id: `mem-${i}`, purpose: 'medição sintética', polarity: 'positive', source: 'DOU', input: { html }, expect: [{ kind: 'part', type: 'article' }],
}));

const mib = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
const baseline = process.memoryUsage().rss;
let peak = baseline;
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
const executor = new SimulationExecutor();
const parallel = EXECUTOR_LIMITS.concurrency + EXECUTOR_LIMITS.queueLimit;
const outcomes: Record<string, number> = {};
const started = Date.now();
for (let r = 0; r < rounds; r += 1) {
  const runs = await Promise.allSettled(Array.from({ length: parallel }, () =>
    executor.simulate({ profiles: structuredClone(DEFAULT_PROFILES), examples, expectedEngineHash: ANATOMY_ENGINE_BUILD_HASH })));
  for (const run of runs) {
    if (run.status === 'rejected') { const k = `rejected:${String((run.reason as { code?: string }).code ?? 'error')}`; outcomes[k] = (outcomes[k] ?? 0) + 1; continue; }
    // Outcome together with the reason the executor recorded for it (null reason = completed normally).
    for (const row of run.value.rows) { const k = `${row.outcome}:${row.reason ?? 'none'}`; outcomes[k] = (outcomes[k] ?? 0) + 1; }
  }
}
await executor.close();
clearInterval(sampler);
const after = process.memoryUsage().rss;
console.log(JSON.stringify({
  node: process.version, rounds, parallelPerRound: parallel, examplesPerSimulation: examples.length, inputKiB: Math.round(html.length / 1024),
  limits: { concurrency: EXECUTOR_LIMITS.concurrency, queueLimit: EXECUTOR_LIMITS.queueLimit, heapMbPerWorker: EXECUTOR_LIMITS.heapMb },
  rssMiB: { baseline: mib(baseline), peak: mib(peak), afterClose: mib(after) }, outcomes, elapsedMs: Date.now() - started,
}));
