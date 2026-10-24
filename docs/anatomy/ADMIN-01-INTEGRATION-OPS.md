# ANAT-ADMIN-01 — integration package 4: operational preparation

**Status:** preparation only (issue tribusca-control#116). Nothing here was run against a shared database, merged, deployed or enabled. Every measurement uses synthetic data in a local disposable PostgreSQL. `BLOCK_CORPUS_INPUTS_AND_GOLD` stays in force.

## 1. Packages and dependencies

| # | Package | PR | Branch | Base |
|---|---|---|---|---|
| 1 | `077_anat_base` (M_ANAT_BASE) | radar-fiscal-backend#263 | `feat/anat-int-base` | #261 (`feat/anat-admin-integration-readiness`) + main `c7a8df1` merged |
| 2 | `078_anat_audit_policy` + `079_anat_rules_admin` | #264 | `feat/anat-int-admin` | #263 |
| 3 | Wiring behind `ANAT_RULES_ADMIN_ENABLED` | #265 | `feat/anat-int-wiring` | #264 |
| 4 | This document and the measurement scripts | #266 | `feat/anat-int-ops` | #265 |
| — | DOE-SP compatibility (P-INT-02), forwarded to the DOE-SP front | #267 | `feat/anat-int-doesp-compat` | #263 |

**Integration R1 deltas (COORD):**
- P-INT-01 and P-INT-03 are in #264: see `docs/anatomy/ADMIN-01-INTEGRATION-DELTAS.md`.
- P-INT-02 is in #267. It must reach main with, or before, 077.

The accepted HEADs were not changed: #258, #259, #260 `2e8a15a` and web#131 `52e41d2`.

## 2. Real main SHA of each rehearsal

| Rehearsal | Where | Main SHA |
|---|---|---|
| `ops/anatomy/rehearse-main-chain.sh` (readiness §2) | local PG16 | `e4d6639` |
| B1/API over the real chain, R1 round (24/24, 13/13) | local PG16 | `e4d6639` |
| #261 @ `8286dd0`, run 40097440773 (`anatomy-admin-main-chain`) | CI PG16/PG18 | `e4d6639e43a4aeb42f76260047b2b9fac1b21afe` (printed by the job) |
| #261 @ `dfdfe24`, run 40099613589 (B1 24/24, API 14/14) | CI PG16/PG18 | `c7a8df1c2d89c990cdfdc0347b94d12ca39fbff7` (COORD R3) |
| Integration packages 1–3 (real runner, 077–079) | local PG16, CI PG16/PG18 | `c7a8df1` (merged into #263) |

## 3. Measurements (synthetic, local; PG16/PG18 also in CI)
Environment: Node 24.22 and PostgreSQL 16.15 on the session's shared container; timings are indicative.
- Every comparison was made in the same run, on the same data.
- The CI job `anatomy-audit-benchmark` runs the same script on PostgreSQL 16 **and 18** with 500 000 rows. It fails if the app's tenant read loses its index plan.

### 3.1 Executor memory (`ops/anatomy/measure-executor-memory.ts`)
Each round runs 12 simultaneous simulations (concurrency 2 + queue 10). Each simulation has 20 synthetic examples. There were 3 rounds per input size. Outcomes are counted with the **reason each row recorded**.

| Input per example | RSS baseline | Peak RSS observed | RSS after close | Outcome:reason (count) |
|---|---|---|---|---|
| 16 KiB | 96 MiB | 368 MiB | 345 MiB | `pass:none` 120; `rejected:QUEUE_TIMEOUT` 30 |
| 240 KiB (limit 256 KiB) | 81 MiB | 510 MiB | 387 MiB | `failed:limit_exceeded` 120; `rejected:QUEUE_TIMEOUT` 30 |

Reading the numbers:
- **The peak is what these runs observed, not a guaranteed ceiling.**
  - The previous round saw 544 MiB for the same load.
  - RSS depends on the allocator, the Node version, the input shape and the output size.
  - The executor bounds each worker's V8 heap (256 MiB) and the number of workers (2), not the process RSS.
- **`QUEUE_TIMEOUT` (30 per size):** the 12 simultaneous simulations exceed concurrency + queue, so the extra ones wait 5 s and are refused, as designed.
- **`failed:limit_exceeded` at 240 KiB:** the worker's result for one example exceeded the 2 MiB output limit (`maxOutputBytes`), so the row is `failed` and nothing is persisted. It is **not** a timeout. The previous round's report attributed it to the 2 s budget; that was wrong.

**Container limit to request:** API footprint + about 0.6 GiB, to be measured again in staging.

### 3.2 Cost of the ANAT `audit_log` policies (`ops/anatomy/measure-audit-policies.ts`)
- **Data:** 1 000 000 synthetic `audit_log` rows: 69 % tenant rows over 20 tenants, 30 % global rows of other fronts, 1 % ANAT rows.
- **Metric:** EXPLAIN ANALYZE execution time, median of 5; writes rolled back.
- **The three states**, measured on the same rows:
  - **before:** 077 only;
  - **previous:** 078/079 plus the accepted rehearsal's permissive `radar_app` policy, i.e. the previous integration HEAD;
  - **current:** 078/079 as they are now, with P-INT-01.

| Path | Before | Previous integration | **Current (P-INT-01)** |
|---|---|---|---|
| app (tenant member): latest 100 of its tenant | 2.26 ms, Index Scan | 456 ms, Bitmap Heap Scan | **2.28 ms, Index Scan** |
| app (tenant member): count of its tenant | 458 ms | 653 ms | 547 ms |
| worker: latest 100 of a tenant | 0.11 ms | 0.18 ms | 0.15 ms |
| worker: count of global rows | 45 ms | 104 ms | 110 ms |
| curator: count of global rows | 44 ms | 64 ms | 66 ms |
| admin: ANAT audit list (500) | — | 180 ms (direct SELECT) | **6.1 ms (`anat_list_audit`)** |
| write: tenant member inserts a tenant audit row | 1.22 ms | 1.05 ms | 0.93 ms |
| write: admin saves a draft (audited ANAT insert) | — | 1.98 ms | 1.77 ms |

**Result:**
- **Plan recovered:** the app's tenant read is back to the ordered index scan.
- **Isolation unchanged:** all tenant, worker and curator policies of 009/018 are in place, plus the two RESTRICTIVE ANAT policies; the only change is that the permissive `radar_app` ANAT policy is gone.
- **Remaining cost:** the RESTRICTIVE filter on the worker's and curator's global counts (+50 % to +145 %); tenant paths are not affected. The tenant count gap (458 → 547 ms) is within this run's noise range.

### 3.3 Limits
- Synthetic distributions and no concurrent writers.
- No production `audit_log` statistics.
- The local container is shared.
- PG18 results come from the CI job, not from this table.

## 4. Regressions run locally on the integration branch (077–079, wiring)
Fresh database with `npm run db:prepare` (real runner, runtime-role provisioning and the three privilege verifiers), with the environment of the backend CI's full-regression job:

| Suite | Branch | main `c7a8df1` |
|---|---|---|
| `db:prepare` (verify-runtime, verify-worker-runtime, verify-taxonomy-curator) | passes | passes |
| `test:integration` (auth, RLS, platform admin, scope…) | 106/106 | — |
| ONB-01 integrity, ONB-02 purge graph, news worker, news API | 1/1 each | — |
| Collection group 1 (11 files, one at a time) | 36/36 | 36/36 |
| Other collection files (13, one at a time) | same results as main except `doe-sp.rebuild-ops` | — |
| `doe-sp.rebuild-ops` DOE-SP-33/34 | **fail** | pass |
| `doe-sp.ncm-rebuild-guard` | **fail** | pass |
| `dou-backfill` | 7/15 | 7/15 (same `permission denied for table collection_runs`: local setup) |
| DOE-SP-35 | fail | fail (`en_US.utf8` collation missing locally) |

Running the collection files in parallel against one database makes some of them fail on main as well (lifecycle, retry). One file at a time, both sides pass.

**P-INT-02:**
- **Was:** the DOE-SP rebuild guard rejected the 077 FKs, so `doe-sp.ncm-rebuild-guard` and DOE-SP-33/34 failed.
- **Now:** #267, forwarded to the DOE-SP front.
  - The two ANAT FKs are recognised only by their exact definition (table, column, target, RESTRICT).
  - Explicit `anatomy_analyses`/`anatomy_run_items` blockers in the dry-run, its report and the destructive guard.
  - The ANAT tables are locked before the snapshot.
  - The schema before 077 keeps working.
- **Local results with #267:** `doe-sp.ncm-rebuild-guard` 1/1; DOE-SP-33/34 pass (DOE-SP-35 locale-only, as on main); `doe-sp.anatomy-guard` 5/5.

## 5. Full web regression
- **Existing mechanism:** in `radar-fiscal-web`, `ci-plan.py` turns on the full regression (demo build, Chromium, `npm run test:e2e`) for any non-draft PR. A draft PR runs only the fast checks and ends with the intentional `DRAFT_FAST_ONLY` step.
- **Running it:** mark web#131 ready for review. That is the owner's decision, so it was not done; the draft gate was not touched.
- **Local evidence** with the same steps (demo build, repository Playwright configuration, preinstalled Chromium) on web#131 @ `52e41d2`: **196 passed, 16 skipped**.
  - The skips are the real-flow spec (needs the harness) and specs that skip themselves by design.
  - The real-flow e2e against the harness is reported separately (4 passed, 4 skipped by design).
- **Cross-repository e2e in CI:** the proposal of the readiness report stands, and no credential was created.

## 6. Deployment order, checks and recovery (documentation only; nothing executed)
Preconditions:
- P-INT-01 and P-INT-03 reviewed (#264);
- P-INT-02 (#267) accepted by the DOE-SP front and merged with, or before, 077;
- packages approved;
- the migration numbers re-checked against main (renumbered if another migration took 077–079);
- 078's policy check passes on the target, otherwise rebase;
- container memory limit ≥ API footprint + 0.6 GiB;
- `dist/modules/anatomy/simulation-worker.js` shipped.

1. **Backup:** a restorable snapshot of the target database is taken and verified.
2. **Migrations:** `npm run db:migrate` applies 077, 078 and 079, each in its own transaction (the real runner). 078 fails with nothing applied if the audit policy differs.
3. **Checks after migrating:**
   - `npm run db:verify-runtime`, `db:verify-worker-runtime` and `db:verify-taxonomy-curator` pass;
   - `schema_migrations` lists 077–079;
   - `anat_rules_writer` is NOLOGIN/NOINHERIT/NOBYPASSRLS;
   - the 9 entry points (8 + `anat_list_audit`) are SECURITY DEFINER owned by the writer;
   - no `radar_app` ANAT policy on `audit_log`;
   - every pre-existing audit event keeps its rule and projection (the B1 check, run read-only);
   - the ANAT tables are empty.
4. **Code deploy with `ANAT_RULES_ADMIN_ENABLED` unset (off):** the API answers 404 for the ANAT routes and behaves as before.
5. **Staging only:** set the flag to `'true'` and run the real e2e. Then check the worker RSS and the `audit_log` timings of §3.2 against real statistics.
6. **Production enablement:** separate authorisation.

**Recovery:**
- **Flag:** unset `ANAT_RULES_ADMIN_ENABLED` and restart. Routes, pool and executor disappear; no data change.
- **079:**
  - first undo the P-INT-01 block: drop `anat_list_audit` and the writer SELECT policy, and revoke the writer's SELECT on `audit_log`;
  - do **not** restore the old `radar_app` policy (P-INT-01 is the reviewed boundary);
  - then, while no ANAT administrative data exists, drop the tables and functions and the columns 079 added to `anatomy_rule_sets`, in the reverse order of the file;
  - then delete its `schema_migrations` row (a reviewed script).
- **078:**
  - restore `audit_event_policy` from 075 (only if no ANAT audit row exists; otherwise keep it, since the rows must stay valid);
  - drop the 3 remaining ANAT policies on `audit_log`;
  - revoke the writer's INSERT grant;
  - drop the role once it owns nothing.
- **077:** while the tables are empty, drop them in the order tested by `anatomy.base-migration` (run items, runs, dependencies, evidence, entities, parts, analyses, rule sets), then the four functions.
- **With data present:** restore from the backup of step 1, under a separate authorised plan. Never use destructive SQL by hand.
