# ANAT-ADMIN-01 / P3-C — isolated executor and the `inconclusive` adjustment

**Status:** implementation, not yet independently reviewed. It depends on P3-B1 (`20519eb`, accepted as a disposable rehearsal) and implements §5 and §2.5 (partial results) of [ADMIN-01-P3.md](ADMIN-01-P3.md).

**Out of scope:** API, screens, migrations, production, corpus, measurement with real material.

## P2 adjustment (§2.5)
`evaluateExample` (shared by the in-process and isolated paths) adds `inconclusive`:
- An example whose expectations held on an engine result that is **not `complete`** (containment or extraction limits) is `inconclusive`.
- It is `pass` only if the example is **positive** and declares **every** limitation of the result with a `{ kind: 'limitation', code }` matcher.
- A failing expectation stays `fail`.
- `ExampleOutcome` gains `analysisId` and `inputTextHash`, which the admin schema persists per example.
- `summary.inconclusive` is added.
- No other P2 rule changed.

## Executor (`simulation-executor.ts`, `simulation-worker.ts`)

| Property | Mechanism | Test (`anatomy.simulation-executor.unit.test.ts`) |
|---|---|---|
| Trusted code only | The worker runs only the versioned `simulation-worker` module; profiles and examples are data, re-validated in the worker. Its import graph is 12 first-party modules plus `zod`, `htmlparser2`, `node:crypto` and `node:worker_threads` | Static import-graph test |
| No secrets or inherited arguments | `env: {}`, `argv: []`, explicit `execArgv`. From compiled code it is `[]`; from TS sources only `['--import','tsx']` | Worker reports 0 env keys and exact `execArgv`; compiled run below |
| One worker per example; parent decides | The parent size-checks (2 MiB) and contract-validates the output (schema, `outputHash`, `analysisId`), checks the worker's engine hash and computes pass/fail/inconclusive itself | Huge, tampered and foreign-engine outputs → `failed` |
| Capacity | 2 slots, FIFO queue of at most 10, 5 s wait (`QUEUE_FULL` / `QUEUE_TIMEOUT` → 429), abort while queued | Queue test; capacity recovers after crash, throw and OOM |
| Budgets | Per-example 2 s + 250 ms margin, armed when the worker is **ready**; start-up bounded separately (10 s); 60 s total per request. A comparison runs both sides in the same slot and deadline | Timeout at the real budget; total deadline; comparison deadline on the second side |
| Stop | `terminate()` is **awaited** before the outcome is reported and the slot released; timeout, deadline, abort, OOM and `close()` all stop the worker | `liveWorkers` and `active` back to 0 in every test |
| Late or foreign messages | Accepted only in the running phase with the request's sequence number; otherwise counted and dropped | `late` worker; terminated workers never deliver |
| Memory | `resourceLimits.maxOldGenerationSizeMb = 256` (**JS heap only, not RSS**) | OOM worker → `cancelled` (`memory`), API alive |
| Responsiveness | Work is off the main thread | Worst gap of a 20 ms timer during a 1 s CPU-bound worker: 21–25 ms |
| Input limits | ≤ 20 examples, P2 example schema (≤ 256 Ki UTF-16, reserved IDs refused), profiles ≤ 64 KiB, catalog ≤ 20 000 codes, valid profiles, candidate engine = binary engine (`ENGINE_MISMATCH` before any worker) | Limits test |

**Not provided:** `worker_threads` is **not** a network or file-system sandbox. Absence of I/O rests on the trusted module and its pure import graph, not on an OS boundary (P3 §5). A process with the Node Permission Model, or a container without network, remains the option if a technical prohibition is required.

**Test seam:** `workerUrl` and `workerExecArgv` exist so the tests can use adversarial workers (`test/support/anatomy-*-worker.ts`) speaking the same protocol. They are never exposed through the API.

## Measured margins (local, Node 24.22.0, synthetic)

| Measurement | Value |
|---|---|
| Worker start-up (TS sources via `tsx`) | 210–320 ms |
| Worker start-up (compiled build) | ≈ 140 ms |
| One synthetic analysis | 40–70 ms |
| Timeout (budget 2000 ms + 250 ms margin) | Forced stop observed at 2251–2252 ms after the task was sent |
| Event-loop gap during a CPU-bound worker | ≤ 25 ms |

These are observations, **not hard real-time guarantees**; CI runners may differ. The test only bounds the stop at budget + margin + 500 ms.

Compiled-mode check (`tsc` build, run from `dist/`): the worker reported `execArgv: []` and 0 environment keys, and returned `pass`.

## Run statuses
- `cancelled`: client abort or executor close.
- `partial`: total deadline hit, or some example timed out or was cancelled.
- `failed`: some example failed (invalid, excessive or foreign output, crash, worker error).
- `complete`: every example was evaluated.

Rows carry `outcome` (`pass`, `fail`, `inconclusive`, `cancelled` or `failed`) plus a `reason`, and only evaluated rows carry hashes. This matches the P3-B1 table.
