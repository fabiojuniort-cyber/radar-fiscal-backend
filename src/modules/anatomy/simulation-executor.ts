import { Worker } from 'node:worker_threads';
import { ANATOMY_ENGINE_BUILD_HASH } from './build-identity.js';
import { canonicalJson, sha256, type AnatomyResult } from './contract.js';
import { ProfileValidationError, resolveEffectiveProfile } from './profile.js';
import {
  assertValidResult, compareResults, evaluateExample, parseExample, SIMULATION_LIMITS, SimulationError,
  type Comparison, type ExampleOutcome, type ParsedExample,
} from './rules-simulation.js';

/**
 * ANAT-ADMIN-01 P3-C (issue #116) — isolated simulation executor (P3 §5).
 *
 * What it guarantees (and only this):
 * - work runs off the API thread, one worker thread per (example, profile set), and can be stopped (`terminate()`,
 *   always awaited before a slot is released);
 * - per-example budget, total deadline, client abort, queue limits and late-message rejection;
 * - the worker's JS heap is limited (`resourceLimits`); the process RSS is NOT limited;
 * - the worker gets an explicitly EMPTY environment, `argv: []`, and no inherited `execArgv` (only the explicit loader
 *   when running from TypeScript sources in development/tests);
 * - every worker output is size-limited, contract-validated (schema, outputHash, analysisId) and engine-checked.
 * What it does NOT guarantee: `worker_threads` is not a sandbox for network or file access. Absence of I/O comes from the
 * worker running only the trusted, versioned `simulation-worker` module (pure import graph, checked by a static test);
 * profiles and examples are data, never code.
 */
export const EXECUTOR_LIMITS = Object.freeze({
  concurrency: 2, queueLimit: 10, queueWaitMs: 5000, perExampleMs: SIMULATION_LIMITS.maxMillisPerExample, totalMs: 60_000,
  /** Worker start-up (module load) is bounded separately; it still counts against the total deadline. */
  startupMs: 10_000,
  /** Allowance between the per-example budget and the forced stop (message latency); measured, see the B1/P3-C doc. */
  marginMs: 250,
  heapMb: 256, maxOutputBytes: 2 * 1024 * 1024, maxProfilesBytes: 64 * 1024, maxCatalogCodes: 20_000,
});
export type ExecutorLimits = typeof EXECUTOR_LIMITS;
export type ExecutorErrorCode = 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'ABORTED' | 'CLOSED' | 'ENGINE_MISMATCH' | 'INVALID_INPUT' | 'LIMIT_EXCEEDED';
export class ExecutorError extends Error {
  constructor(readonly code: ExecutorErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'ExecutorError'; }
}

export type RowOutcome = 'pass' | 'fail' | 'partial' | 'inconclusive' | 'cancelled' | 'failed';
export type StopReason = 'timeout' | 'deadline' | 'aborted' | 'memory' | 'startup' | 'closed' | 'limit_exceeded' | 'engine_mismatch'
  | 'invalid_output' | 'worker_error' | 'worker_exit' | 'analysis_failed' | 'invalid_profile' | 'invalid_input';
/** One persisted execution row (matches anatomy_rule_simulation_examples). */
export interface ExecutionRow {
  exampleId: string; outcome: RowOutcome; engineHash: string; reason: StopReason | null;
  inputTextHash: string | null; outputHash: string | null; analysisId: string | null; ruleSetHash: string | null;
}
export type RunStatus = 'complete' | 'partial' | 'cancelled' | 'failed';
export interface SimulationRun {
  status: RunStatus; engineHash: string; profileSetHash: string; rows: ExecutionRow[];
  /** P2-compatible report of the evaluated examples plus the stopped ones; bound by hash when persisted. */
  report: { engineHash: string; profileSetHash: string; outcomes: (ExampleOutcome | { id: string; status: 'cancelled' | 'failed'; reason: StopReason })[] };
  timings: { exampleId: string; startupMs: number; runMs: number }[];
}
export type ComparisonRun = { status: 'complete'; comparison: Comparison; before: AnatomyResult; after: AnatomyResult }
  | { status: 'cancelled' | 'failed'; reason: StopReason };
export interface WorkerDiagnostics { engineHash: unknown; envKeys: unknown; execArgv: unknown }

type Settle = { kind: 'ok'; result: AnatomyResult } | { kind: 'cancelled' | 'failed'; reason: StopReason };
type WorkerOutcome = Settle & { startupMs: number; runMs: number };

const fromSources = import.meta.url.endsWith('.ts');
const DEFAULT_WORKER = new URL(fromSources ? './simulation-worker.ts' : './simulation-worker.js', import.meta.url);
// Explicit, never inherited: compiled builds start the worker with NO execArgv; TypeScript sources need the loader only.
const DEFAULT_EXEC_ARGV: readonly string[] = fromSources ? ['--import', 'tsx'] : [];

export interface ExecutorOptions extends Partial<ExecutorLimits> {
  /** Test seam only (adversarial workers implementing the same protocol); never exposed through the API. */
  workerUrl?: URL; workerExecArgv?: readonly string[]; onWorkerReady?: (d: WorkerDiagnostics) => void;
  now?: () => number;
}

export class SimulationExecutor {
  readonly limits: ExecutorLimits;
  private readonly workerUrl: URL; private readonly execArgv: string[]; private readonly onReady?: (d: WorkerDiagnostics) => void;
  private readonly now: () => number;
  private active = 0; private closed = false; private seq = 0; private late = 0;
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout; detach: () => void }[] = [];
  private readonly live = new Set<Worker>();
  private readonly shutdown = new AbortController();

  constructor(options: ExecutorOptions = {}) {
    const { workerUrl, workerExecArgv, onWorkerReady, now, ...limits } = options;
    this.limits = Object.freeze({ ...EXECUTOR_LIMITS, ...limits });
    this.workerUrl = workerUrl ?? DEFAULT_WORKER; this.execArgv = [...(workerExecArgv ?? DEFAULT_EXEC_ARGV)];
    if (onWorkerReady) this.onReady = onWorkerReady;
    this.now = now ?? (() => performance.now());
  }

  stats() { return { active: this.active, queued: this.waiters.length, liveWorkers: this.live.size, lateMessages: this.late, closed: this.closed }; }

  /** Runs every example of a candidate profile set, sequentially, each in its own worker. */
  async simulate(input: { profiles: unknown; examples: unknown; expectedEngineHash: string }, signal?: AbortSignal): Promise<SimulationRun> {
    const { profiles, examples } = this.validate(input.profiles, input.examples, input.expectedEngineHash);
    const release = await this.acquire(signal);
    try {
      const deadline = this.now() + this.limits.totalMs;
      const rows: ExecutionRow[] = []; const outcomes: SimulationRun['report']['outcomes'] = []; const timings: SimulationRun['timings'] = [];
      let aborted = false; let deadlineHit = false;
      for (const e of examples) {
        let w: WorkerOutcome;
        if (aborted || signal?.aborted || this.shutdown.signal.aborted) { aborted = true; w = { kind: 'cancelled', reason: 'aborted', startupMs: 0, runMs: 0 }; }
        else if (this.now() >= deadline) { deadlineHit = true; w = { kind: 'cancelled', reason: 'deadline', startupMs: 0, runMs: 0 }; }
        else w = await this.runWorker(e, profiles, deadline, signal);
        if (w.kind !== 'ok' && (w.reason === 'aborted' || w.reason === 'closed')) aborted = true;
        if (w.kind !== 'ok' && w.reason === 'deadline') deadlineHit = true;
        timings.push({ exampleId: e.id, startupMs: w.startupMs, runMs: w.runMs });
        let o: ExampleOutcome | null = null;
        if (w.kind === 'ok') {
          // A positive selection (impossible by contract) or any evaluation error becomes a failed row, never a crash.
          try { o = evaluateExample(e, profiles, w.result, false); } catch { w = { kind: 'failed', reason: 'invalid_output', startupMs: w.startupMs, runMs: w.runMs }; }
        }
        if (o) {
          outcomes.push(o);
          rows.push({ exampleId: e.id, outcome: o.status, engineHash: ANATOMY_ENGINE_BUILD_HASH, reason: null, inputTextHash: o.inputTextHash,
            outputHash: o.outputHash, analysisId: o.analysisId, ruleSetHash: o.ruleSetHash });
        } else {
          const stopped = w as Extract<WorkerOutcome, { reason: StopReason }>;
          outcomes.push({ id: e.id, status: stopped.kind, reason: stopped.reason });
          rows.push({ exampleId: e.id, outcome: stopped.kind, engineHash: ANATOMY_ENGINE_BUILD_HASH, reason: stopped.reason, inputTextHash: null, outputHash: null, analysisId: null, ruleSetHash: null });
        }
      }
      const status: RunStatus = aborted ? 'cancelled' : deadlineHit ? 'partial' : rows.some((r) => r.outcome === 'failed') ? 'failed'
        : rows.some((r) => r.outcome === 'cancelled') ? 'partial' : 'complete';
      const profileSetHash = sha256(canonicalJson(profiles));
      return { status, engineHash: ANATOMY_ENGINE_BUILD_HASH, profileSetHash, rows, report: { engineHash: ANATOMY_ENGINE_BUILD_HASH, profileSetHash, outcomes }, timings };
    } finally { release(); }
  }

  /** One example under two profile sets; both sides run in their own workers within the same slot and deadline. */
  async compare(input: { example: unknown; before: unknown; after: unknown; expectedEngineHash: string }, signal?: AbortSignal): Promise<ComparisonRun> {
    const before = this.validate(input.before, [input.example], input.expectedEngineHash);
    const after = this.validate(input.after, [input.example], input.expectedEngineHash);
    const e = before.examples[0]!;
    const release = await this.acquire(signal);
    try {
      const deadline = this.now() + this.limits.totalMs;
      const left = await this.runWorker(e, before.profiles, deadline, signal);
      if (left.kind !== 'ok') return { status: left.kind, reason: left.reason };
      const right = await this.runWorker(e, after.profiles, deadline, signal);
      if (right.kind !== 'ok') return { status: right.kind, reason: right.reason };
      const comparison = compareResults(left.result, right.result,
        { beforeProfileSetHash: sha256(canonicalJson(before.profiles)), afterProfileSetHash: sha256(canonicalJson(after.profiles)) });
      return { status: 'complete', comparison, before: left.result, after: right.result };
    } finally { release(); }
  }

  /** Rejects queued requests, stops running workers and waits until every worker has exited. */
  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.detach(); w.reject(new ExecutorError('CLOSED', 'executor closed')); }
    this.shutdown.abort();
    await Promise.all([...this.live].map((w) => w.terminate()));
  }

  private validate(rawProfiles: unknown, rawExamples: unknown, expectedEngineHash: string): { profiles: unknown[]; examples: ParsedExample[] } {
    if (this.closed) throw new ExecutorError('CLOSED', 'executor closed');
    if (expectedEngineHash !== ANATOMY_ENGINE_BUILD_HASH) throw new ExecutorError('ENGINE_MISMATCH', 'candidate engine differs from this binary');
    if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) throw new ExecutorError('INVALID_INPUT', 'profiles must be a non-empty array');
    let bytes: number;
    try { bytes = Buffer.byteLength(canonicalJson(rawProfiles), 'utf8'); } catch { throw new ExecutorError('INVALID_INPUT', 'profiles are not finite JSON'); }
    if (bytes > this.limits.maxProfilesBytes) throw new ExecutorError('LIMIT_EXCEEDED', 'profile set too large');
    if (!Array.isArray(rawExamples) || rawExamples.length === 0 || rawExamples.length > SIMULATION_LIMITS.maxExamples) {
      throw new ExecutorError('LIMIT_EXCEEDED', `between 1 and ${SIMULATION_LIMITS.maxExamples} examples`);
    }
    const examples = rawExamples.map((raw) => {
      try { return parseExample(raw); } catch (error) { throw new ExecutorError('INVALID_INPUT', error instanceof SimulationError ? error.message : 'invalid example'); }
    });
    if (new Set(examples.map((e) => e.id)).size !== examples.length) throw new ExecutorError('INVALID_INPUT', 'duplicate example id');
    if (examples.some((e) => (e.catalog?.codes.length ?? 0) > this.limits.maxCatalogCodes)) throw new ExecutorError('LIMIT_EXCEEDED', 'catalog too large');
    const profiles = structuredClone(rawProfiles) as unknown[];
    for (const e of examples) {
      try { resolveEffectiveProfile(structuredClone(profiles), { source: e.source, family: e.family }); } catch (error) {
        if (error instanceof ProfileValidationError) throw new ExecutorError('INVALID_INPUT', `invalid profile for ${e.id}: ${error.code}`);
        throw error;
      }
    }
    return { profiles, examples };
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new ExecutorError('CLOSED', 'executor closed'));
    if (signal?.aborted) return Promise.reject(new ExecutorError('ABORTED', 'request aborted'));
    const grant = () => { this.active++; let done = false; return () => { if (done) return; done = true; this.active--; this.next(); }; };
    if (this.active < this.limits.concurrency && this.waiters.length === 0) return Promise.resolve(grant());
    if (this.waiters.length >= this.limits.queueLimit) return Promise.reject(new ExecutorError('QUEUE_FULL', 'simulation queue full'));
    return new Promise((resolve, reject) => {
      const onAbort = () => { remove(); reject(new ExecutorError('ABORTED', 'request aborted while queued')); };
      const remove = () => { const i = this.waiters.indexOf(entry); if (i >= 0) this.waiters.splice(i, 1); clearTimeout(entry.timer); entry.detach(); };
      const entry = {
        resolve: () => resolve(grant()), reject,
        timer: setTimeout(() => { remove(); reject(new ExecutorError('QUEUE_TIMEOUT', 'queue wait exceeded')); }, this.limits.queueWaitMs),
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(entry);
    });
  }

  private next(): void {
    while (this.active < this.limits.concurrency && this.waiters.length > 0) {
      const w = this.waiters.shift()!; clearTimeout(w.timer); w.detach(); w.resolve();
    }
  }

  private runWorker(e: ParsedExample, profiles: unknown[], deadline: number, signal?: AbortSignal): Promise<WorkerOutcome> {
    const seq = ++this.seq; const t0 = this.now();
    const worker = new Worker(this.workerUrl, {
      env: {}, argv: [], execArgv: [...this.execArgv], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: this.limits.heapMb },
    });
    worker.stdout.resume(); worker.stderr.resume(); // never forwarded to the API logs
    this.live.add(worker);
    return new Promise<WorkerOutcome>((resolveOutcome) => {
      let phase: 'starting' | 'running' | 'settled' = 'starting'; let ready = t0; let timer: NodeJS.Timeout | undefined;
      const remaining = () => Math.max(0, deadline - this.now());
      const finish = (o: Settle) => {
        if (phase === 'settled') return;
        const end = this.now(); const startupMs = (phase === 'starting' ? end : ready) - t0; const runMs = phase === 'running' ? end - ready : 0;
        phase = 'settled'; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.shutdown.signal.removeEventListener('abort', onClose);
        // The slot is released by the caller only after this promise resolves, i.e. after the worker has exited.
        void worker.terminate().then(() => { this.live.delete(worker); resolveOutcome({ ...o, startupMs, runMs }); });
      };
      const onAbort = () => finish({ kind: 'cancelled', reason: 'aborted' });
      const onClose = () => finish({ kind: 'cancelled', reason: 'closed' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.shutdown.signal.addEventListener('abort', onClose, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      const startLeft = remaining(); // the reason is fixed when the timer is armed: whichever bound is shorter
      timer = setTimeout(() => finish({ kind: 'cancelled', reason: startLeft < this.limits.startupMs ? 'deadline' : 'startup' }), Math.min(this.limits.startupMs, startLeft));
      worker.on('message', (message: unknown) => {
        const m = message as { type?: unknown; seq?: unknown; engineHash?: unknown; json?: unknown; code?: unknown; envKeys?: unknown; execArgv?: unknown };
        if (phase === 'starting' && m?.type === 'ready') {
          this.onReady?.({ engineHash: m.engineHash, envKeys: m.envKeys, execArgv: m.execArgv });
          if (m.engineHash !== ANATOMY_ENGINE_BUILD_HASH) { finish({ kind: 'failed', reason: 'engine_mismatch' }); return; }
          phase = 'running'; ready = this.now(); clearTimeout(timer);
          const budget = this.limits.perExampleMs + this.limits.marginMs;
          const left = remaining();
          timer = setTimeout(() => finish({ kind: 'cancelled', reason: left < budget ? 'deadline' : 'timeout' }), Math.min(budget, left));
          worker.postMessage({ type: 'analyze', seq, example: e, profiles });
          return;
        }
        if (phase !== 'running' || m?.seq !== seq) { this.late++; return; } // late, foreign or out-of-order: never accepted
        if (m.type === 'error') { finish({ kind: 'failed', reason: m.code === 'invalid_profile' || m.code === 'invalid_input' ? m.code : 'analysis_failed' }); return; }
        if (m.type !== 'result' || typeof m.json !== 'string') { finish({ kind: 'failed', reason: 'invalid_output' }); return; }
        if (m.engineHash !== ANATOMY_ENGINE_BUILD_HASH) { finish({ kind: 'failed', reason: 'engine_mismatch' }); return; }
        if (Buffer.byteLength(m.json, 'utf8') > this.limits.maxOutputBytes) { finish({ kind: 'failed', reason: 'limit_exceeded' }); return; }
        let result: AnatomyResult;
        try { result = assertValidResult(JSON.parse(m.json) as AnatomyResult, 'worker'); } catch { finish({ kind: 'failed', reason: 'invalid_output' }); return; }
        if (result.identity.engineHash !== ANATOMY_ENGINE_BUILD_HASH) { finish({ kind: 'failed', reason: 'engine_mismatch' }); return; }
        finish({ kind: 'ok', result });
      });
      worker.on('error', (error: Error & { code?: string }) => {
        finish({ kind: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'cancelled' : 'failed', reason: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'worker_error' });
      });
      worker.on('exit', () => { this.live.delete(worker); finish({ kind: 'failed', reason: 'worker_exit' }); });
    });
  }
}
