# ANAT-ADMIN-01 — integration package 4: operational preparation

**Status:** preparation only (issue tribusca-control#116). Nothing here was run against a shared database, merged, deployed or enabled. Every measurement uses synthetic data in a local disposable PostgreSQL. `BLOCK_CORPUS_INPUTS_AND_GOLD` stays in force.

## 1. Packages and dependencies

| # | Package | PR | Branch | Base |
|---|---|---|---|---|
| 1 | `077_anat_base` (M_ANAT_BASE) | radar-fiscal-backend#263 | `feat/anat-int-base` | #261 (`feat/anat-admin-integration-readiness`) + main `c7a8df1` merged |
| 2 | `078_anat_audit_policy` + `079_anat_rules_admin` | #264 | `feat/anat-int-admin` | #263 |
| 3 | Wiring behind `ANAT_RULES_ADMIN_ENABLED` | #265 | `feat/anat-int-wiring` | #264 |
| 4 | This document and the measurement scripts | this PR | `feat/anat-int-ops` | #265 |

The accepted HEADs were not changed: #258, #259, #260 `2e8a15a` and web#131 `52e41d2`.

## 2. Real main SHA of each rehearsal

| Rehearsal | Where | Main SHA |
|---|---|---|
| `ops/anatomy/rehearse-main-chain.sh` (readiness §2) | local PG16 | `e4d6639` |
| B1/API over the real chain, R1 round (24/24, 13/13) | local PG16 | `e4d6639` |
| #261 @ `8286dd0`, run 40097440773 (`anatomy-admin-main-chain`) | CI PG16/PG18 | `e4d6639e43a4aeb42f76260047b2b9fac1b21afe` (printed by the job) |
| #261 @ `dfdfe24`, run 40099613589 (B1 24/24, API 14/14) | CI PG16/PG18 | `c7a8df1c2d89c990cdfdc0347b94d12ca39fbff7` (COORD R3) |
| Integration packages 1–3 (real runner, 077–079) | local PG16, CI PG16/PG18 | `c7a8df1` (merged into #263) |

## 3. Measurements (synthetic, local)
Environment for both: Node 24.22, PostgreSQL 16.15 on the session's shared container. Timings are indicative: the container is shared and other jobs ran at the same time. Every comparison was made in the same run on the same data.

### 3.1 Executor memory (`ops/anatomy/measure-executor-memory.ts`)
Each round runs 12 simultaneous simulations (concurrency 2 + queue 10). Each simulation has 20 synthetic examples. There were 3 rounds per input size.

| Input per example | RSS baseline | RSS peak | RSS after close | Outcomes |
|---|---|---|---|---|
| 16 KiB | 95 MiB | **363 MiB** | 344 MiB | 120 `pass`; 30 `QUEUE_TIMEOUT` (5 s queue wait, as designed) |
| 240 KiB (limit 256 KiB) | 82 MiB | **544 MiB** | 366 MiB | 120 `failed` (per-example 2 s budget exceeded at this size); 30 `QUEUE_TIMEOUT` |

Reading the numbers:
- Two workers at the 256 MiB heap cap put a full-size load at about 0.55 GiB of process RSS. The container limit must leave this headroom above the API's own footprint.
- With inputs near the limit, the engine does not finish within 2 s per example on this machine, and those rows end as `failed`. That is the designed bound, not a leak; the RSS after close stays stable.

**Limits of the measurement:** synthetic, repetitive text; a single process; no production CPU profile.

### 3.2 Cost of the ANAT `audit_log` policies (`ops/anatomy/measure-audit-policies.ts`)
- **Data:** 1 000 000 synthetic `audit_log` rows: 69 % tenant rows over 20 tenants, 30 % global rows of other fronts, 1 % ANAT rows.
- **Metric:** EXPLAIN ANALYZE execution time, median of 5.
- **Method:** each path is measured at 077 (no ANAT policy), then the real runner applies 078/079 and the path is measured again on the same rows.

| Path | Before 078 | After 078/079 |
|---|---|---|
| worker: count of global rows | 46.4 ms | 74.4 ms (+60 %) |
| worker: latest 100 rows of a tenant | 0.17 ms | 0.14 ms |
| curator: count of global rows | 43.6 ms | 73.4 ms (+68 %) |
| **app (tenant member): latest 100 rows of its tenant** | **1.54 ms** | **469 ms (≈300×)** |
| app (tenant member): count of its tenant | 400 ms | 689 ms (+72 %) |
| app (platform admin): ANAT audit list (P3-D `listAudit`) | — | 179 ms |

At 100 000 rows the same app path went from 1.44 ms to 43.4 ms.

**Finding P-INT-01 (blocks deployment; COORD decision needed).**
- **Cause:** the permissive policy `audit_log_anat_rules_admin_select` (TO `radar_app`) is OR'ed with the tenant policy of 009. The planner then replaces the ordered index scan, which stops after 100 rows, with a `BitmapOr` over the whole tenant, evaluates `app_user_has_tenant_access` on every row, and sorts.
- **Scale:** the cost grows with each tenant's audit volume.
- **Verified:** with only that policy dropped (in a rolled-back transaction), the same query is back to an index scan at **1.5 ms**. The two RESTRICTIVE ANAT policies cost a simple per-row filter (the +60 % on global counts) and do not change the app plan.
- **Proposed correction (not applied):**
  - remove the `radar_app` SELECT policy on `audit_log`;
  - read the ANAT audit through a ninth SECURITY DEFINER entry point, `anat_list_audit(p_limit)`, owned by `anat_rules_writer`, gated by `anat_actor()` (active PLATFORM_ADMIN) and with a fixed search_path;
  - give `anat_rules_writer` a SELECT policy limited to ANAT rows;
  - in the API, `listAudit` calls the function.
  - Visibility is unchanged (admins only) and no permissive `radar_app` policy is added to `audit_log`.
  - This changes the accepted B1-R1-03 boundary, so it is **not** applied without review.
- An index alone was **not** evaluated: the slowdown comes from the OR between policies, and an index does not remove it.

### 3.3 Limits
- Synthetic distributions.
- No concurrent writers.
- No production `audit_log` statistics.
- INSERT paths not timed: the ANAT WITH CHECK predicates are per inserted row, without subqueries.
- PG18 not measured (the scripts run unchanged against a PG18 disposable database).

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

**Finding P-INT-02 (blocks the full regression of #263; owner: the DOE-SP front).**
- **Cause:** `ops/doe-sp/sql/20_dry_run_readonly.sql` refuses the destructive DOE-SP rebuild when any foreign key it does not know points to `publications`/`publication_versions` (`blocker_unknown_foreign_keys`). 077 adds `publication_anatomies_publication_version_id_fkey` and `anatomy_run_items_publication_version_id_fkey`, so the guard reports 2.
- **Effect:** the DOE-SP rebuild tool stops (fail closed, by design), and the CI guard test fails.
- **Proposed patch (not applied; it belongs to that front):**
  - add the two names to the known list;
  - add an explicit blocker that counts `publication_anatomies` and `anatomy_run_items` rows of DOE-SP versions and requires 0. This is the "explicit handling" that RESTRICT demands of any purge; with analyses present, the rebuild must stop before deleting.

```sql
-- in the NOT IN list:
       'publication_anatomies_publication_version_id_fkey',
       'anatomy_run_items_publication_version_id_fkey',
-- new blocker:
  (SELECT count(*) FROM publication_anatomies pa JOIN publication_versions pv ON pv.id = pa.publication_version_id
     JOIN doe_pub d ON d.id = pv.publication_id)
  + (SELECT count(*) FROM anatomy_run_items ri JOIN publication_versions pv ON pv.id = ri.publication_version_id
     JOIN doe_pub d ON d.id = pv.publication_id) AS blocker_anatomy_rows,
```

## 5. Full web regression
- **Existing mechanism:** in `radar-fiscal-web`, `ci-plan.py` turns on the full regression (demo build, Chromium, `npm run test:e2e`) for any non-draft PR. A draft PR runs only the fast checks and ends with the intentional `DRAFT_FAST_ONLY` step.
- **Running it:** mark web#131 ready for review. That is the owner's decision, so it was not done; the draft gate was not touched.
- **Local evidence** with the same steps (demo build, repository Playwright configuration, preinstalled Chromium) on web#131 @ `52e41d2`: **196 passed, 16 skipped**.
  - The skips are the real-flow spec (needs the harness) and specs that skip themselves by design.
  - The real-flow e2e against the harness is reported separately (4 passed, 4 skipped by design).
- **Cross-repository e2e in CI:** the proposal of the readiness report stands, and no credential was created.

## 6. Deployment order, checks and recovery (documentation only; nothing executed)
Preconditions:
- P-INT-01 decided and resolved;
- P-INT-02 patch applied by the DOE-SP front;
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
   - the 8 entry points are SECURITY DEFINER owned by the writer;
   - every pre-existing audit event keeps its rule and projection (the B1 check, run read-only);
   - the ANAT tables are empty.
4. **Code deploy with `ANAT_RULES_ADMIN_ENABLED` unset (off):** the API answers 404 for the ANAT routes and behaves as before.
5. **Staging only:** set the flag to `'true'` and run the real e2e. Then check the worker RSS and the `audit_log` timings of §3.2 against real statistics.
6. **Production enablement:** separate authorisation.

**Recovery:**
- **Flag:** unset `ANAT_RULES_ADMIN_ENABLED` and restart. Routes, pool and executor disappear; no data change.
- **079:** while no ANAT administrative data exists, drop its tables and functions and the columns it added to `anatomy_rule_sets`, in the reverse order of the file. Then delete its `schema_migrations` row (a reviewed script).
- **078:**
  - restore `audit_event_policy` from 075 (only if no ANAT audit row exists; otherwise keep it, since the rows must stay valid);
  - drop the 4 ANAT policies on `audit_log`;
  - revoke the writer's INSERT grant;
  - drop the role once it owns nothing.
- **077:** while the tables are empty, drop them in the order tested by `anatomy.base-migration` (run items, runs, dependencies, evidence, entities, parts, analyses, rule sets), then the four functions.
- **With data present:** restore from the backup of step 1, under a separate authorised plan. Never use destructive SQL by hand.
