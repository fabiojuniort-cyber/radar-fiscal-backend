# ANAT-ADMIN-01 — final integration matrix (consolidation)

**Status:** technical closure for the final integration review (issue tribusca-control#116). Technical approval only. **No deployment authorisation:**
- no merge, auto-merge or deploy;
- no real rebuild, shared database, new credentials or real flags.

`BLOCK_CORPUS_INPUTS_AND_GOLD` and RESTRICT stay in force.

## 1. What was consolidated
| Item | Value |
|---|---|
| Consolidation PR | radar-fiscal-backend#268, branch `feat/anat-admin-consolidated`, base `main` @ `c7a8df1` (unchanged since preparation) |
| Stack included | ANAT stack up to #266 @ `749098c` (… #258 → #259 → #260 `2e8a15a` → #261 → #263 → #264 `27147ad` → #265 `fc1a0a9` → #266) |
| DOE-SP patch | #267 @ `927b18e`, files identical |
| Merge conflicts | one, mechanical: `anatomy-ci.yml`, where both sides added jobs |
| Consolidation-only commit | `578ba43`: two ANAT ops scripts used the unregistered static actor `system:ci` (rule R7.3 of `npm test`); now synthetic UUIDs or `app_current_user_id()`, and no registry of another front changed |
| Web | radar-fiscal-web#131 @ `52e41d2` (unchanged), marked ready for review to run the full browser regression |
| Earlier PRs | still open, HEADs unchanged |

**Diff against main, outside ANAT paths:**
- `src/app.ts`, `src/config/env.ts`: wiring, with the flag off by default;
- `package.json`: ANAT scripts;
- `.github/workflows/ci.yml`: offline ANAT step and DOE-SP P-INT-02 step;
- `ops/doe-sp/**`: P-INT-02.

Everything else is ANAT module, tests, docs and synthetic or reviewed fixtures already in the accepted PRs. Nothing was added to corpus, gold or reserve material.

**Checks:**
- **Numbering:** main ends at `076`; `077`–`079` are free, and no remote branch has a migration ≥ 077.
- **Audit policy on main:** equal to 078's base; 078 also refuses at apply time otherwise (P-INT-03).

## 2. Matrix

| Requirement | Implementation | Test / run (head `578ba43` unless stated) | Limitation |
|---|---|---|---|
| Persist anatomy results (`M_ANAT_BASE`) with RESTRICT, no invented hash or family | `077_anat_base.sql` | `anatomy-base-migration` PG16/PG18 (run 40273124872) | `ON DELETE RESTRICT` blocks purges of versions with analyses until handled explicitly |
| Audit events of the admin flow, without losing other fronts' events | `078_anat_audit_policy.sql` (+ P-INT-03 fail-closed check) | `anatomy-admin-migrations` (13/13, including 8 refusals); B1 "every pre-existing event keeps rule and projection" | any later change to `audit_event_policy` by another front requires a rebase of 078 |
| Admin persistence: drafts, freeze, simulation, comparison, review, preview/confirm, replay, author separation, seal, search_path | `079_anat_rules_admin.sql` (accepted rehearsal + 2 documented edits) | B1 suite in vendored, real-chain and migrations modes, PG16/PG18 | — |
| ANAT audit read without degrading tenant reads (P-INT-01) | 079 delta: `anat_list_audit` (9th entry point); no `radar_app` ANAT policy | B1 P-INT-01 subtest; `anatomy-audit-benchmark` PG16/PG18 (Index Scan required) | worker and curator global counts pay the RESTRICTIVE filter (+50–145 % at 1M synthetic rows) |
| Admin API (P3-D, accepted) | `src/api/routes/anatomy-rules-admin.route.ts`, service | `anatomy-admin-api` and `anatomy-admin-migrations (admin-api)` PG16/PG18 | — |
| Server flag, off by default; one executor per instance; 503 without executor | `rules-admin.wiring.ts`, `env.ts` `ANAT_RULES_ADMIN_ENABLED` (`'false'` by default) | `anatomy-admin-migrations (admin-wiring)` PG16/PG18 through the real `buildApp()` | — |
| Isolated simulation executor (P3-C, accepted) | `simulation-executor.ts` | `anatomy-synthetic`; executor memory measurement | peak RSS is observed, not guaranteed (510–544 MiB at a near-limit load) |
| Admin screens behind a flag (P4) | web#131 | web CI `validate` full regression (run 40272624311): unit 257/257, browser 196 passed / 16 skipped; real e2e locally (§3) | real e2e not in CI (private repos; proposal kept, no credential) |
| DOE-SP rebuild compatible with 077 (P-INT-02) | `ops/doe-sp/sql/20`, `30`, RUNBOOK | `anatomy-doesp-compat` PG16/PG18 9/9 each (DOE-SP-35 included); full regression step (run 40273124899) | the rollback script `60` is not guarded explicitly; with analyses present it aborts atomically on RESTRICT |
| No regression of other fronts | — | CI full regression `verify` (run 40273124899), all steps executed; ONB-01/02 on PG18; DOU-CLEAN-02 PG18; LOTE2 PG18 | see §4 for TAX-09 |

## 3. Results of this consolidation
- **Backend full regression in CI** (run 40273124899, `verify`, full mode, every step executed):
  - node test runner: **1 142 tests, 1 141 pass, 0 fail, 1 skipped**;
  - the skip is `collection-filter.f3-simulation` "isolated local PostgreSQL…", which needs `F3_LOCAL_CLI_TEST_DATABASE_URL` (another front; skipped on main too);
  - `test:integration` 106/106 in that run.
- **ANAT workflow** (run 40273124872): **27/27 jobs green** on PG16 and PG18:
  - base migration;
  - admin migrations × {migrations, B1, API, wiring};
  - real chain of main × {B1, API};
  - vendored B1 and API;
  - DOE-SP compatibility;
  - audit benchmark;
  - synthetic.
- **Web full regression** (run 40272624311): unit **257/257**; browser **196 passed, 16 skipped**. The skips:
  - 8 from `anatomy-rules-real.spec.ts`: it needs the local harness (`ANAT_REAL_API=1`);
  - 8 from the flag-on tests of `anatomy-rules-admin.spec.ts`: the CI build does not set `VITE_ENABLE_ANAT_RULES_ADMIN`, and its flag-off counterparts ran.
- **Real e2e, local:**
  - backend `578ba43` harness on the **project migrations through 079** (`ANAT_PROJECT_MIGRATIONS=1`), web#131 `52e41d2` built with the flag: **4 passed, 4 skipped by design** (the mutating flow runs on one viewport, the others check its result);
  - the regenerated screenshots were discarded, so web#131 is unchanged.

## 4. TAX-09 (taxonomy front): evidence, no change
- **Command:** `npm run test:integration` after `npm run db:prepare`, on a fresh `radar_fiscal_test`, with the backend CI's full-regression environment. Same container and order, 5 alternating runs:

| Side | Runs with TAX-09 failing |
|---|---|
| Consolidation branch | 2 / 5 |
| main `c7a8df1` | 3 / 5 |

- **Failure:**
  - `test/taxonomy.matching.integration.test.ts:739`, "private matching must not write global taxonomy";
  - branch: `9 !== 8`; main: `9 !== 7`.
  - In an earlier round the same test failed on `TAXONOMY_CRITERIA_CODE_NOT_IN_CURRENT_RELEASE`.
- **Identification:** the assertion compares `SELECT count(*) FROM taxonomy_concepts` (the whole global table) before and after. `test:integration` runs its files in parallel against one database, so concurrent taxonomy files change that count.
- **ANAT involvement:** none. The diff touches no taxonomy object, and main fails the same way.
- **Result:** in CI (run 40273124899) it passed, 106/106.
- **History:** local 106/106 before the integration R1 round; 105/106 in its first local reruns (TAX-09); now the counts above. **A failed execution is recorded as failed, not as PASS.**
- **Decision for COORD:** the test belongs to the taxonomy front. Making the count scoped to the test's own release, or running that file serially, is that front's call.

## 5. State guarantees
- `ANAT_RULES_ADMIN_ENABLED` and `VITE_ENABLE_ANAT_RULES_ADMIN` are off by default and were never set in any shared environment.
- No variable, database, deployment or credential of a shared environment was changed.
- Recovery and memory requirements (`ADMIN-01-INTEGRATION-OPS.md` §6, §3.1) remain preparation only, not executed.

## 6. Remaining items before any deployment
1. Final integration review of #268 and web#131.
2. TAX-09 decision by COORD and the taxonomy front.
3. Operational rehearsal in a separate environment (specific authorisation):
   - real `audit_log` statistics;
   - container RSS limit;
   - the staging e2e with the flag on.
4. Cross-repository e2e in CI: needs the credential authorisation of the readiness proposal.
5. Re-check numbering and the audit policy at merge time.
