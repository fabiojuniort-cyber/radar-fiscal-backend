# ANAT-ADMIN-01 — integration readiness report

**Status:** preparation only. No numbered migration was created, nothing ran against a shared database, nothing was deployed. Issue: tribusca-control#116.

## 1. Exact SHAs and PR tree

| Package | PR | Branch | HEAD | Base | Review |
|---|---|---|---|---|---|
| P3 design R2 | radar-fiscal-backend#256 | `feat/anat-admin-p3-design` | `b92af41` | P2 stack | PASS (documentation) |
| P3-B1 persistence and audit (rehearsal) | #258 | `feat/anat-admin-p3b1-persistence` | `20519eb` | `b92af41` | **APPROVED R3** (disposable rehearsal) |
| P3-C executor + `inconclusive` | #259 | `feat/anat-admin-p3c-executor` | `28e07d4` | `20519eb` | Implemented, CI green; **not independently reviewed** |
| P3-D API (+ dev harness) | #260 | `feat/anat-admin-p3d-api` | `a44efed` | `28e07d4` | Implemented; **not independently reviewed** |
| P4 screens (behind a flag) | radar-fiscal-web#131 | `feat/anat-admin-p4-screens` | `1269b69` | web `main` `6df732c` | Implemented; **not independently reviewed** |
| This report and rehearsal script | radar-fiscal-backend (this PR) | `feat/anat-admin-integration-readiness` | — | `a44efed` | — |

The backend stack is linear: … → #256 → #258 → #259 → #260 → this report. The web PR depends on #260's API contract, not on a backend branch.

## 2. Real chain vs. rehearsal (`ops/anatomy/rehearse-main-chain.sh`)

Run on a fresh local `anat04_ci` against `origin/main` @ `e4d6639`, PostgreSQL 16.15:

| Check | Result |
|---|---|
| Real migrations applied in order (verified `git show` copies, unedited) | **70 files, 001 → 076**, no error |
| Anatomy tables on main | **0**: `M_ANAT_BASE` does not exist on main |
| Rehearsal SQL on top (base CI schema → `M_AUDIT_ANAT` → `M_ANAT_ADMIN`) | Applies cleanly |
| Admin saves a draft and freezes as `radar_app` | OK; audit rows `ANAT_RULES_DRAFT_SAVED`, `ANAT_RULES_CANDIDATE_FROZEN` typed and accepted by the **real** 074/075 guard |
| Non-admin: write | Refused (`PLATFORM_ADMIN_REQUIRED`) |
| Non-admin: read ANAT audit | Reads 0 rows |
| `radar_app` direct DML | `permission denied` |
| Pre-existing event projection (`COMPANY_CREATED`) | Unchanged |
| `radar_app` CREATE on `public` | false (the real 009 revoke holds) |
| `publication_anatomies.effective_profile_hash` / `family` | **absent** |

Test merge of the whole stack into `main` @ `e4d6639` (local, discarded): **no conflicts**.
- 88 main commits are not in the stack; 50 stack commits are not in main; merge base `30e7490`.
- The stack changes nothing in `migrations/`.

**Not done here:** PostgreSQL 18 with the real chain (PG18 only ran the vendored chain, in CI); the full B1/P3-D suites over the real chain (they need a fresh database with the vendored chain by design).

## 3. Differences between the rehearsal and production schema

| Area | Rehearsal | Real / to do |
|---|---|---|
| Audit chain | 006 + 074[1–160] + 075, vendored byte for byte | Real 006 → 076 applies; `M_AUDIT_ANAT` must extend the **then-current** policy JSON (still 075's at `e4d6639`; 076 does not touch audit) |
| Roles | `radar_app`, `radar_worker`, `radar_taxonomy_curator` (NOLOGIN) + new `anat_rules_writer` | The production login `radar_app_runtime` is INHERIT and `GRANT radar_app TO radar_app_runtime` (`provision-runtime-role.ts`): the same model as the P3-D tests' LOGIN role. `anat_rules_writer` must be created by the migration (NOLOGIN, NOINHERIT, no BYPASSRLS) and own the 8 entry points and the 4 commit-time checks |
| RLS on `audit_log` | New ANAT policies: writer insert, admin select, two RESTRICTIVE ANAT-only | 009/018 policies unchanged; the restrictive ones must be reviewed by the owners of 018 (curator) |
| `platform_user_roles` | Reduced columns; 036 predicate verbatim | Real 031/036 tables and policy; the predicate is identical |
| `app_user_has_tenant_access` | Fail-closed stub | Real 009 function; ANAT events are global, so it is not involved |
| Auth | Minimal `auth_sessions`; JWT signed by the test | Real 008/009 |
| Base anatomy tables | `test/support/anatomy-ci-schema.sql` (8 tables) | **`M_ANAT_BASE` needed first**; recommended to add `effective_profile_hash` and `family` to `publication_anatomies` (§4 of the P3 design) |

## 4. Missing fields for the affected scope
- **Analyses affected:** `publication_anatomies.effective_profile_hash` and `family` are needed. Until then the API answers `unsupported` (never 0).
- **Publications affected:** a source/family attribution of publication versions reachable by this module is needed (the publication schema on main has no anatomy "family"). Until then, `unsupported`.

## 5. Compatibility with current services
- **Engine identity:** `b6ccf583…`, unchanged by P3-C/P3-D (identity inputs untouched). The executor runs the same `analyzeAnatomy`, and the outputs are byte-identical in tests.
- **API:** the plugin is not registered in `buildApp()`. Integration needs a dedicated pool (runtime login inheriting `radar_app`) and one `SimulationExecutor` per instance, closed on `onClose`.
- **Worker in production:**
  - from the compiled `dist/`, `execArgv` is `[]` (verified);
  - the deployment must ship `dist/modules/anatomy/simulation-worker.js`;
  - RSS is not bounded by the executor: a container memory limit is required.
- **Web:** the route is behind `VITE_ENABLE_ANAT_RULES_ADMIN` (off). It uses existing auth and `/api/v1/admin/me`.
- **Other fronts:** no migration and no ONB or taxonomy file changed. The restrictive `audit_log` policies affect only ANAT rows (tested: curator events still work).

## 6. Risks
1. **High: the restrictive ANAT policies on `audit_log` add per-row predicates to every insert and select.** The cost on the large production `audit_log` is unmeasured.
2. **High: `SECURITY DEFINER` entry points.** Safety depends on `search_path` (fixed, `pg_temp` last, in every `anat_*` function) and on no runtime role having CREATE on `public` (true on the real chain).
3. **Medium: `M_AUDIT_ANAT` replaces `audit_event_policy`.** Any other front adding events in between requires a rebase of the JSON; the test checks the byte prefix.
4. **Medium: the executor in the API process.** CPU is bounded per worker, but 2 concurrent workers share the instance; container limits are required.
5. **Low: the 88-commit drift.** The merge is clean today, but the real chain must be re-verified at integration time (this script).

## 7. Proposed integration order
1. Independent review of P3-C (#259), then P3-D (#260), then P4 (web#131).
2. **`M_ANAT_BASE` package:** numbered migration 077 (or the next free number, checked against main), with the 8 base tables and `effective_profile_hash`/`family`.
3. **`M_ANAT_ADMIN` + `M_AUDIT_ANAT`:** numbered migrations translated from the accepted rehearsal SQL, without the test guards and with `CREATE ROLE anat_rules_writer` idempotent. B1/P3-D suites ported to run over the real chain on a fresh database (PG16 and PG18).
4. **Wiring:** register the plugin with its pool and executor behind a server-side feature flag, off by default.
5. **Staging rehearsal:** measure the `audit_log` policy cost and the worker RSS.
6. Web flag on only for staging; production release under separate authorisation.

## 8. Tests still needed and release criteria
- B1 and P3-D suites over the **real** chain (PG16 and PG18).
- Performance of the `audit_log` RLS predicates on a production-sized table.
- Container RSS limit and OOM behaviour of the executor under load.
- Independent reviews of P3-C, P3-D and P4.
- The P4 real-flow e2e in an automated environment (today local, against the dev harness).
- Release criteria: green CI on all of the above, approved reviews, migrations numbered against main, and explicit production authorisation. `BLOCK_CORPUS_INPUTS_AND_GOLD` stays in force.

## Update after the COORD R1 round (P3-D `1196cd6`, web `2852d69`)

**The full suites run over the real chain.**
- `test/support/anatomy-admin-db.ts` and the B1 test accept `ANAT_MAIN_MIGRATIONS_DIR`. It must point to verified, unedited copies of main's migrations, applied one transaction per file like `migrate.ts`, **instead of** the vendored excerpt and bootstraps.
- The B1 suite gains a check: the latest real `audit_event_policy` must still equal the 075 JSON that `M_AUDIT_ANAT` extends. If main changes the policy, this test fails and `M_AUDIT_ANAT` must be rebased.
- The new CI job `anatomy-admin-main-chain` runs on the matrix PostgreSQL 16/18 × {B1 suite, API suite}. It uses a second checkout of `main` and prints the exact SHA.

**Local results** (main `e4d6639`, PostgreSQL 16.15, fresh disposable database per suite, synthetic data):

| Suite | Real chain | Vendored chain (unchanged) |
|---|---|---|
| B1 admin schema | **24/24** | 23 pass + 1 skip (the real-chain check, by design) |
| API | **13/13** | 13/13 |

PostgreSQL 18 over the real chain runs in CI (see the run on this PR's HEAD).

**Real-API e2e in CI: blocked.** Both repositories are private, so neither workflow's `GITHUB_TOKEN` can check out the other repository. Automating the e2e needs a cross-repository read credential, either a read-only deploy key or a fine-grained token stored as a secret. Creating credentials is outside this authorisation, so nothing was added. The e2e keeps running locally against the dev harness; the last run, against `1196cd6`/`2852d69`, passed 12 of 12.

**Proposed remedy, for authorisation:**
1. Add a read-only deploy key of `radar-fiscal-web` as a secret of the backend repository.
2. Add a backend job that builds the web with the flag, starts the harness on a fresh database, and runs `e2e/anatomy-rules-real.spec.ts`.
