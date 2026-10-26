# ANAT-ADMIN-01 — operational rehearsal (isolated, disposable)

**Status:** rehearsal record for COORD (issue tribusca-control#116). **It does not authorise production:**
- no merge, deploy or real rebuild;
- no access to production data.

RESTRICT and `BLOCK_CORPUS_INPUTS_AND_GOLD` stay in force.

## 1. Environment
| Item | Value |
|---|---|
| Kind | local disposable Docker containers in the session's machine. **Limitation:** no isolated staging exists, so this is not the target infrastructure (kernel, cgroup v1, CPU and disk differ). No shared environment was touched. |
| Backend | `dist/` compiled from #268 @ `9608bd6`, including `dist/modules/anatomy/simulation-worker.js`; image `node:24-bookworm-slim`, `NODE_ENV=production`, `node dist/server.js` as PID 1 |
| Web | web#131 @ `52e41d2` (exercised in the earlier local real e2e; this rehearsal drives the API) |
| PostgreSQL | 18.6 (same major version as the target), container `anat-rh-pg`, database `radar_rehearsal`, bound to 127.0.0.1 only |
| Isolation | own Docker network; own superuser, runtime and curator passwords and JWT secret, all random and generated for the rehearsal, never committed; no e-mail, payment, collection or scheduler configuration; synthetic data only |
| Memory limit | app container `--memory 1g --memory-swap 1g` (cgroup `memory.limit_in_bytes` = 1 073 741 824, no extra swap); pressure runs at 512 MiB and 384 MiB |

## 2. Installation and application
- **Runner:** the real runner (`db:prepare`: migrate → provision runtime role → three verifiers) applied 73 migrations through `077`–`079`.
- **Verifiers:** all three passed (runtime, worker runtime, taxonomy curator).
- **Privileges and audit policy:**
  - 8 ANAT events registered; `COMPANY_CREATED` intact;
  - writer role is not superuser, cannot create roles or databases, has no `BYPASSRLS`;
  - 9 SECURITY DEFINER entry points;
  - 0 `radar_app` ANAT policies on `audit_log`; the ANAT policies are hidden, writer_insert, writer_only and writer_select;
  - `radar_app` has no CREATE on `public`;
  - the runtime login inherits `radar_app`.
- **Flag off (default):** ANAT route 404 for a platform admin; `/api/v1/admin/me` 200; `/health` 200 with the database up.
- **Flag on, rehearsal only** (`ops/anatomy/rehearsal/flow.ts full`): **24/24 PASS**:
  - 401 without a token, 403 for a non-admin;
  - three candidates: simulation complete with every row passing, and a comparison against a baseline;
  - the author cannot review (409 `AUTHOR_CANNOT_REVIEW`); the reviewer **rejects**; the candidate state is `rejected`, and its activation preview is refused;
  - **approval → preview → confirmation** (`replayed:false`) → **replay** (`replayed:true`, same activation);
  - second activation (preview basis `active_candidate`), then **return** (rollback) to candidate 1: candidate 1 active, 3 activations, one of them a rollback;
  - ANAT audit read through `anat_list_audit` (DRAFT_SAVED, REVIEWED, ACTIVATED, ATTEMPT_REJECTED); refused to a non-admin; 31 ANAT audit rows written.
  - Driver fix during the rehearsal: one of my synthetic headers duplicated a default header (`INVALID_PROFILE`, correct refusal); replaced by another header.

## 3. Memory and failures (`ops/anatomy/rehearsal/load.ts`)
**Load:**
- one near-limit candidate: 20 examples × 262 090 UTF-16 units (limit 262 144); 20 000 catalogue codes on 4 examples, 500 on the rest;
- draft body 6.2 MB (the route accepts up to 8 MiB; 20 000 codes on every example exceeds it and is refused at the HTTP layer);
- 14 concurrent heavy simulations (2 running + 10 queued + 2 overflow);
- concurrent reads of `/drafts`, `/admin/me`, `/health` for 8 s;
- 14 concurrent light simulations;
- one client cancellation at 1 s;
- two simulations afterwards.

**Sampling:**
- method: every 250 ms through `docker exec`, from the container cgroup (`usage_in_bytes`, `max_usage_in_bytes`) and the Node process (`VmRSS`, `VmHWM` of PID 1);
- scope: the **whole process** (main thread and workers), not the workers' heap.

| Measure (1 GiB, fresh process) | Value |
|---|---|
| RSS idle / after preparing the candidates | 110 / 176 MiB |
| **Process peak (VmHWM)** | **700 MiB** (first run on a warm process: 625 MiB) |
| Cgroup peak (`max_usage_in_bytes`) | 662 MiB |
| RSS at the end | 454 MiB |
| Heavy burst (14) | 2 × 200 `partial`, rows `cancelled:timeout` (2 s per example); 10 × 429 `QUEUE_TIMEOUT` (5 s); 2 × 429 `QUEUE_FULL`; 50 s wall |
| Light burst (14) | 12 × 200 `complete` / all pass (queue drained); 2 × 429 `QUEUE_FULL` |
| Concurrent reads during the heavy burst | 24/24 200; p50 18 ms, p95 681 ms, max 2.8 s |
| Client cancellation | request aborted at ~1 s |
| Capacity afterwards | 2 × 200 `complete` / pass; `/health` 200 |
| OOM | `oom_kill 0`; container never restarted |

**Memory pressure:**
- At **512 MiB** and **384 MiB** the kernel's cgroup OOM killer killed the **whole Node process** (`Killed process … (MainThread)`, anon-rss ≈ 383 / 512 MB). The container exited with code 137 and `OOMKilled=true`.
- The kill happened during the heavy burst (2 concurrent near-limit simulations); RSS climbed past 490 MiB before the kill.
- This is **process termination, not worker termination**.
- **Worker termination** was observed separately: the `cancelled:timeout` rows mean the executor stopped a worker at the 2 s budget while the process survived. PID 1 did not change, and capacity recovered.
- **Conclusion:** the 256 MB worker heap cap does **not** contain the process RSS. With 2 concurrent workers, the observed peak is ~700 MiB.

## 4. Audit cost and recovery
- **Audit benchmark** (`measure-audit-policies.ts`, unchanged, on a separate disposable PG18.6 container, 1 000 000 synthetic `audit_log` rows, median of 7, EXPLAIN ANALYZE ms):

| Path | before 077 policies | current (078/079) |
|---|---|---|
| tenant member, latest 100 | 1.64 (Index Scan) | 1.48 (Index Scan) |
| tenant member, count | 434 | 486 |
| worker, latest 100 of a tenant | 0.17 | 0.20 |
| **worker, count global rows** | **54.9** | **126.0** (+130 %, Bitmap Heap Scan) |
| **curator, count global rows** | **47.6** | **81.7** (+72 %) |
| admin ANAT list (`anat_list_audit(500)`) | — | 6.1 |
| tenant audit insert / `anat_save_draft` | 0.56 / — | 0.54 / 1.12 |

  The legacy permissive policy (previous HEAD) is shown for contrast: tenant latest-100 went to 665 ms. The P-INT-01 fix keeps tenant reads unchanged. The remaining cost is on the worker and curator global counts.
- **Flag off and restart:**
  - app restarted without the flag: ANAT 404, existing admin route 200, health 200;
  - ANAT data unchanged (3 activations, 7 candidates, 66 ANAT audit rows, 73 migrations);
  - plain `docker restart` healthy; flag on again: the active activation is the rollback.
- **Backup and restore:**
  - `pg_dumpall --globals-only` plus `pg_dump -Fc radar_rehearsal` (6.0 MB), restored into **another disposable PG18 container** (`radar_restored`) with `--exit-on-error`: rc 0.
  - Integrity: **121 lines identical**. They cover, for every public table, the row count and the md5 of its ordered content; plus `schema_migrations` (73, checksums), policies (117), functions (185, owner, SECURITY DEFINER, config, source), grants, triggers (131) and constraints (1 607).
  - On the restored database, the real runner reports "up to date", and the three verifiers pass.

## 5. Remaining risks
1. **Memory:** the observed peak is ~700 MiB at 2 concurrent near-limit simulations. Below ~1 GiB the whole API process can be OOM-killed, taking every route down.
   - The container limit (or `concurrency`) must be sized for that; 1 GiB showed ~30 % headroom here.
   - The host differs from the target, and peaks are observed, not guaranteed.
2. **Queue timeouts under heavy load:** with 2 long simulations running, queued work hits `QUEUE_TIMEOUT` (429) after 5 s. This is correct and bounded, but users see refusals.
3. **Read latency under heavy load:** p95 681 ms, max 2.8 s while two workers saturate the CPU.
4. **Audit:** worker and curator global counts +72–130 % at 1M rows. Real `audit_log` statistics are still unknown.
5. **Restart policy:** an OOM kill needs a supervisor restart (the rehearsal container had none on purpose).
6. **Environment:** the rehearsal ran in local containers, not staging; the cross-repository e2e in CI is still pending a credential decision.
7. TAX-09 (taxonomy front) is unchanged.
