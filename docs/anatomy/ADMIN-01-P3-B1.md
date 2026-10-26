# ANAT-ADMIN-01 / P3-B1 — persistence and audit rehearsal (disposable database)

**Status:** implementation for independent review. Base: P3 design R2 (`b92af41`, [ADMIN-01-P3.md](ADMIN-01-P3.md)).

**Out of scope:** migrations, production SQL, executor, API, screens, P2 semantic changes, corpus, measurement, merge, deploy.
**Not done here (executor package):** the P2 `inconclusive` adjustment and the effective-timeout proof. The DB tests use equivalent synthetic reports.

## Files (none under `migrations/`, nothing applied automatically)

| File | Role |
|---|---|
| `test/support/anatomy-audit-chain/{006,074,075}*.sql` | Byte-identical copies of `main` (git blob SHAs checked by the test). 074 is applied up to line 160 (see README there) |
| `test/support/anatomy-audit-bootstrap-pre.sql` / `-post.sql` | Roles, minimal `tenants`, session helpers, and the `audit_log` grants and RLS policies of 009/018 |
| `test/support/anatomy-admin-audit-policy.sql` | Rehearsal of `M_AUDIT_ANAT`: the 075 policy JSON byte for byte plus the 8 `ANAT_RULES_*` entries, and two narrow RLS policies |
| `test/support/anatomy-admin-ci-schema.sql` | Rehearsal of `M_ANAT_ADMIN`: tables, triggers, transactional functions and grants |
| `test/anatomy.admin-schema.integration.test.ts` | Environment guard before connecting; offline file checks; DB tests on a **fresh** disposable database |
| `.github/workflows/anatomy-ci.yml` | New job `anatomy-admin-schema`, matrix `postgres:16` and `postgres:18`; base `feat/anat-admin-p3-design` added to the triggers |

Every SQL file starts with the `ANAT04_DISPOSABLE_CI_ONLY` guard. The test commits its data, so that two clients can race, which is why it needs its own fresh database (its own CI job). The existing `anatomy-disposable-schema` job is unchanged.

## R1 corrections (review `5636867174` on `97f8081`)

| Finding | Correction | Regression tests (PG16 and PG18, `SET LOCAL ROLE`, no trigger disabled) |
|---|---|---|
| **B1-R1-01**: direct DML bypassed the flow and the audit | `radar_app` has **no INSERT/UPDATE** on the admin tables, only SELECT plus EXECUTE on the 8 entry points. These are `SECURITY DEFINER` functions owned by the dedicated role `anat_rules_writer` (NOLOGIN, NOINHERIT, no superuser, no BYPASSRLS) with `search_path = pg_catalog, public, pg_temp`. No runtime role can CREATE in `public` (tested). Helpers are not executable by `radar_app`. Defence in depth for any writer, the owner included: triggers bind every authorship field to the session (`ACTOR_MISMATCH`). A preview is consumed only by its actor, before expiry, by the activation that matches it (candidate, review, scope, action, previous). At COMMIT an activation must have consumed its own preview (`PREVIEW_REQUIRED`), and a superseded activation must have a replacement naming it (`REPLACEMENT_REQUIRED`) | `B1-R1-01` test: scenarios 1, 2, 3 and 5; scenario 4 in the `audit` test (INSERT on `audit_log` revoked from the writer ⇒ draft save, draft creation, freeze and simulation all leave nothing) |
| **B1-R1-02**: an approved proof could gain rows | Each simulation is a sealed aggregate. `example_count` is fixed at insert, and rows beyond it are refused (`SIMULATION_SEALED`), the owner included. Rows must belong to the candidate's example set and engine. At COMMIT, rows, counters and `report_hash` must agree (`SIMULATION_INCONSISTENT`). Preview and activation re-run every approval rule instead of trusting the `approved` label | `B1-R1-02` test: extra `failed` row, extra row with a valid id (completing a partial run), forged counters, missing row, forged report hash, unknown example, other engine |
| **B1-R1-03**: global audit policy not admin-only | The platform-admin predicate of `main` (036, verbatim body) is required by every entry point (`PLATFORM_ADMIN_REQUIRED`) and by the policies. ANAT audit INSERT is allowed only to `anat_rules_writer`, for the session user and only when that user is an admin. ANAT audit SELECT, and SELECT on all 13 admin tables (RLS forced), is limited to `radar_app` with an admin session; the worker keeps SELECT on rule sets and activations (§2.3). Policies 009 and 018 already give the worker and the curator broad `tenant_id NULL` access; they are unchanged. Two **RESTRICTIVE** policies scoped to ANAT rows block their writes and reads of ANAT rows (the curator could otherwise write `ANAT_RULES_*`; found by the new test). Their own events are unaffected (tested) | `B1-R1-03` test: no session user, authenticated non-admin, revoked admin and admin; worker and curator; `radar_app` direct ANAT insert refused even for an admin |

## R2 correction (review `5637021187` on `9ce09ff`)

**B1-R2-01: TEMP schema precedence in the privileged chain. Reproduced, then fixed.**

**Reproduction on `9ce09ff`** (local PostgreSQL 16.15, fresh disposable database, new psql connection; synthetic data):

| Case | Result |
|---|---|
| Control, no TEMP table: `anat_record_review` approving a simulation with `fail_count = 1` | Refused (`SIMULATION_NOT_PASSING`) |
| `radar_app`, admin session, ran `CREATE TEMP TABLE anatomy_rule_reviews (LIKE public.anatomy_rule_reviews INCLUDING DEFAULTS)` and `GRANT SELECT ... TO anat_rules_writer`, then the same call with no comparisons or decisions | Approval **persisted after COMMIT**, alongside `fail_count = 1` |

**Cause:**
- The entry points had `pg_temp` last, but each helper and trigger had its own `SET search_path = pg_catalog, public`. Without `pg_temp` listed, the temporary schema is searched first for relations and types.
- `anat_assert_approval` read the empty TEMP `anatomy_rule_reviews`. With no `FOUND` check, every comparison evaluated to NULL and no rule refused. The commit-time check called the same helper.

**Fix:**
- Every `anat_*` function (helpers, triggers, entry points) now has `search_path = pg_catalog, public, pg_temp`, with `pg_temp` explicitly last; the test checks this for every function. Functions are never looked up in `pg_temp`.
- `anat_assert_approval` and the simulation-row guard fail explicitly when a required record is missing: `REVIEW_NOT_FOUND`, `CANDIDATE_NOT_FOUND`, `SIMULATION_*`, `INVALID_EXAMPLE`. Rejected reviews return early, as before.
- No privilege was widened: no grant on the schema, no change to TEMP, no change to the writer's membership.

**Regression** (test `B1-R2-01`, PostgreSQL 16 and 18, one **fresh connection per case**):
- Each of 13 tables (the 12 admin tables used by the chain plus `audit_log`) is shadowed by an empty TEMP copy granted to the writer, one at a time and then all together.
- The invalid approval is refused every time, and no approval is persisted.
- A valid approval with every table shadowed still succeeds once, with its audit row.
- A missing review is refused (`REVIEW_NOT_FOUND`), and a rejected review still works.
- Run against the `9ce09ff` schema, the test fails exactly on the `anatomy_rule_reviews` case.

**Observation, outside scope:** vendored 074 `audit_allowlist_guard` has `search_path = pg_catalog, public` and reads `pg_class` only in its UPDATE (owner backfill) branch. The INSERT branch used here calls functions only. 074 is kept byte-identical and is not changed.

## Decisions (R1 outcome)

1. **Confirm mapping (accepted by COORD):**

   | Situation | Result |
   |---|---|
   | Unknown token, or a token of another actor | `PREVIEW_EXPIRED` |
   | Different intent, or the current activation changed | `PREVIEW_STALE` |
   | Expired and unconsumed | `PREVIEW_EXPIRED` |
   | Replay with the same token, actor and intent | The same activation (`replayed = true`), with no new row and no audit |

2. **Raw token never reaches the database.** The API sends only `sha256(token)`.
3. **Frozen provenance.** The candidate stores `draft_id`, `draft_revision` and `draft_author` at freeze. Author ≠ reviewer is checked against these values and the snapshot author, never against the live draft.
4. **Envelope deduplication.** One envelope row per P2 `id`, plus one association row per candidate.
5. **Per-example executions** bind each linked comparison to what *that* simulation executed (R2 criterion 1).
6. **Canonical JSON is a conservative subset (a limit of this rehearsal, accepted by COORD).** The SQL reproduces P2 `canonicalJson` only where equality is proven, and refuses the rest with an explicit error. It never rounds or normalises. Three distinct limits apply:
   - **Mathematical limit:** integers with |n| > 2^53−1 are refused (`CANONICAL_NUMBER_UNSUPPORTED`). Beyond that, a decimal integer may not be the same IEEE-754 double that JS would print.
   - **Decimal format:** non-integers are accepted only in [1e-6, 1e21), with at most 15 significant digits and no trailing zero. Inside that range the decimal text is exactly the JS shortest form; outside it JS switches to exponent notation or needs 16–17 digits.
   - **Unicode keys:** object keys with a code point ≥ U+E000 are refused (`CANONICAL_KEY_UNSUPPORTED`). For those keys, UTF-16 order (JS sort) and code-point order (`COLLATE "C"`) can differ. String *values* are unrestricted.

   This does not claim equivalence for every JSON accepted by P2. The future API must refuse such content predictably, with a validation error, before saving.
7. **Errors** are `anat:<CODE>`, using the §2.4 code where one applies. Authorisation and validation codes (`PLATFORM_ADMIN_REQUIRED`, `ACTOR_MISMATCH`, `DRAFT_NOT_FOUND`, `RESERVED_EXAMPLE_ID`, …) are not audited (§0.2).

## R2 criteria → tests

| R2 criterion | Test |
|---|---|
| 1. Comparison bound to the simulated snapshot | `approval rules`: a stray output or input is `COMPARISON_MISMATCH` |
| 2. Dedupe keeps links | `criterion 2`: one envelope row, two associations, a review per candidate |
| 3. Idempotent tokens | `criterion 3` (replay, wrong, foreign, other intent, expired, stale) and `concurrency` |
| 4. Frozen provenance | `criterion 4` |
| 5. Idempotent upsert | `criterion 5` |
| 6. Canonicalization | `criterion 6` (Unicode, numbers, key order, refusals) |

Also covered: immutability, privileges (`has_table_privilege`, `has_column_privilege`, `has_function_privilege`), author ≠ reviewer, approval rules, first activation, rollback, no reprocessing, atomic audit, attempt audit in a separate transaction, and "audit unavailable ⇒ no mutation".

## Limits
- The session identity is the `app.user_id` setting, the same trust model as every RLS policy of `main` (009, 036): the API sets it after authentication. The table owner and superusers are trusted, as for the rest of the schema.

- The audit chain is vendored, not the real numbered chain. It must be re-verified when the stack is rebased onto `main` and the numbered migrations are written.
- `app_user_has_tenant_access` is a fail-closed stub (tenant tables are absent). The platform-admin predicate is vendored from 036 over reduced `app_users` and `platform_user_roles` tables. The API keeps `requirePlatformAdmin` as well.
- Locally only PostgreSQL 16 was run; PostgreSQL 18 runs in CI only.
- The affected scope (§4) is stored as provided by the caller; computing it belongs to the API package.
