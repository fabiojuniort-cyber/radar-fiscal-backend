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

## Decisions taken in the rehearsal (to be confirmed by review)

1. **RLS finding.** Under `FORCE ROW LEVEL SECURITY` (009), `radar_app` can only write `audit_log` rows of its own tenant. Global ANAT events (`tenant_id NULL`) are therefore impossible without a new policy. `M_AUDIT_ANAT` adds:
   - `audit_log_anat_rules_app_insert`: `tenant_id IS NULL`, `ADMIN`, `entity_type = 'anatomy_rules'`, `ANAT_RULES_*`, and actor equal to the session user;
   - a matching SELECT policy.
   The test shows that this does not widen anything else: a tenantless non-ANAT event, or an actor other than the session user, is still refused.
2. **No `SECURITY DEFINER`.** The functions run with `radar_app`'s own grants (§2.3). Triggers enforce every invariant whatever the calling path.
3. **Raw token never reaches the database.** The API generates the token and sends only `sha256(token)`.
4. **Confirm code mapping:**

   | Situation | Result |
   |---|---|
   | Unknown token, or a token of another actor | `PREVIEW_EXPIRED` (nothing revealed about other actors' previews) |
   | Same token and actor, different intent | `PREVIEW_STALE` |
   | Consumed, with the same token, actor and intent | The same activation (`replayed = true`), with no new row and no audit |
   | Expired and unconsumed | `PREVIEW_EXPIRED` |
   | Current activation differs from the observed one | `PREVIEW_STALE` |

5. **Frozen provenance.** The candidate stores `draft_id`, `draft_revision` and `draft_author` at freeze. Author ≠ reviewer is checked against these values and the snapshot author, never against the live draft.
6. **Envelope deduplication.** `anatomy_rule_comparison_envelopes` holds one row per P2 `id`. `anatomy_rule_comparisons` holds the per-candidate association.
7. **Per-example executions** (`anatomy_rule_simulation_examples`: input, output, analysis, rule set, engine). Approval requires each linked envelope to match what *that* simulation executed (R2 criterion 1).
8. **Canonical JSON in SQL** reproduces P2 `canonicalJson` and refuses (`CANONICAL_*_UNSUPPORTED`) what it cannot prove identical:
   - keys with code points ≥ U+E000;
   - integers above 2^53−1;
   - decimals outside [1e-6, 1e21), with more than 15 significant digits, or with trailing zeros.
9. **Errors** are raised as `anat:<CODE>`, using the §2.4 code when one applies. `DRAFT_NOT_FOUND`, `ACTOR_REQUIRED`, `RESERVED_EXAMPLE_ID` and the other validation codes are authorisation or validation failures and are not audited (§0.2).

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

- The audit chain is vendored, not the real numbered chain. It must be re-verified when the stack is rebased onto `main` and the numbered migrations are written.
- `app_user_has_tenant_access` is a fail-closed stub; the platform-admin check stays in the API.
- Locally only PostgreSQL 16 was run; PostgreSQL 18 runs in CI only.
- The affected scope (§4) is stored as provided by the caller; computing it belongs to the API package.
