# ANAT-ADMIN-01 / P3-D — administrative API

**Status:** implementation, not yet independently reviewed. It depends on P3-B1 (`20519eb`, accepted rehearsal) and P3-C (#259) and implements §3 and §4 of [ADMIN-01-P3.md](ADMIN-01-P3.md), using the accepted R1/R2 corrections of B1.

**The route is NOT registered in `buildApp()`.** The feature stays unavailable to real users. Wiring it (its pool, its executor and the numbered migrations) belongs to the integration package.

## Files
- `src/api/routes/anatomy-rules-admin.route.ts`: Fastify plugin `anatomyRulesAdminRoutes(app, { pool, executor })` under `/api/v1/admin/anatomy-rules`.
- `src/modules/anatomy/admin/rules-admin.service.ts`: the service. It uses only the SQL entry points of B1 (`anat_save_draft`, `anat_freeze`, `anat_record_*`, `anat_preview`, `anat_confirm`, `anat_audit_attempt`), never direct DML.

## Routes

| Route | Effect |
|---|---|
| `GET /drafts`, `GET /drafts/:id` | Read (RLS: platform admins only) |
| `POST /drafts`, `PUT /drafts/:id` | Save a draft; `revision` is required on update (409 `STALE_REVISION`); body up to 8 MiB |
| `POST /drafts/:id/freeze` | Idempotent freeze (`created: false` on repeat) |
| `GET /candidates`, `GET /candidates/:id` | Derived state (`frozen`, `simulated`, `approved`, `rejected`, `active`, `superseded`), with simulations, comparisons and reviews |
| `POST /candidates/:id/simulate` | Real executor (P3-C), then `anat_record_simulation`; 503 without an executor, 429 when the queue is full |
| `POST /candidates/:id/compare` | Each example, baseline vs candidate, in workers; baseline = declared snapshot or the active one (422 `baseline_required`); 60 s for the whole request |
| `POST /candidates/:id/reviews` | §2.5 rules enforced by the database (author ≠ reviewer, full proof) |
| `POST /activation/preview` | Random 32-byte token returned **once**; only its SHA-256 reaches the database; never logged |
| `POST /activation/confirm` | SERIALIZABLE with up to 3 attempts; replay returns the same activation without a new success audit |
| `GET /activations`, `GET /audit` | History; audit rows have flat typed fields only |

## Guarantees

| Guarantee | How |
|---|---|
| Admin only | `requirePlatformAdmin` (real JWT plus session check, and `isPlatformAdmin`) on every route; the database checks the same 036 predicate again |
| Identity | Taken from the authentication only; bodies are `strictObject` (an `author` field is refused, 422) |
| Session context | `set_config('app.user_id', …, true)` inside each transaction; tested to be absent on pooled connections afterwards |
| Errors | `{ error: <code>, correlationId }` only. Validation errors never echo input. Unknown errors are `internal_error`, logged with code and correlation only |
| Refused attempts | After authorisation and validation, the §2.4 codes are audited in a **separate** transaction (`ANAT_RULES_ATTEMPT_REJECTED`) |
| Audit unavailable | The mutation is rolled back and the API answers 503 `audit_unavailable` |
| Canonical subset (B1) | `assertCanonicalSubset` refuses, **before** persisting, keys with code units ≥ U+D800 (U+E000+ and supplementary code points), unsafe integers and decimals outside the proven range (422). Nothing is rounded or normalised. Tested against `anat_canonical_json` |
| Correlation | `x-correlation-id` (UUID) is accepted or generated, and echoed |
| Client abort | Response closed before it finished → the executor stops the workers (real-socket test) |

## Affected scope (§4)
- Per source, and per family that has its own profile, the effective-profile hash of the current rules (the active candidate, else the shipped defaults) is compared with the candidate's.
- Counts are **declared `unsupported`**, never zero:
  - **Publications:** source and family metadata is not available to this module.
  - **Analyses:** `publication_anatomies` lacks `effective_profile_hash` and `family` (`M_ANAT_BASE`).
  - **Unknown family:** publications without family metadata cannot be attributed to a family profile.
- Activation never reprocesses anything (tested: no rows in `publication_anatomies` or `anatomy_runs`).

## Tests (`test/anatomy.admin-api.integration.test.ts`, fresh disposable database, PG16 and PG18 in CI)
- **Authentication:** real `registerAuthSupport` with a per-run random secret; sessions in `auth_sessions`; `isPlatformAdmin` through a LOGIN role inheriting `radar_app`.
- **Bootstrap:** `test/support/anatomy-api-ci-bootstrap.sql` (minimal 008/009/031/036 pieces).
- **Cases:**
  - 401 without a token and with a revoked session; 403 for a non-admin;
  - strict body; revision lock with its attempt audit; author-only edits; reserved ids refused; idempotent freeze;
  - real executor for simulation and comparison; author refused as reviewer; incomplete decisions refused; the full proof approves; the rationale stays out of the audit;
  - an inconclusive simulation blocks approval;
  - preview and confirm: foreign actor, other intent, unknown token, two concurrent confirms (one activation and one replay), replay without a new audit, token never stored or logged;
  - no reprocessing; no pool leak; audit unavailable means no mutation; canonical equivalence and refusals;
  - 503 without an executor (audited), 429 on a full queue, sanitised errors;
  - real HTTP socket: a normal simulation completes, and a client abort stops the workers.

**Adversarial pass, recorded:**
- **Suspected defect that did not reproduce:** I suspected the request stream's `close` event would abort every simulation on a real socket. The real-socket test passes with the old detection too (Node 24, Fastify 5). The detection now uses "response closed before it finished", which is clearer, and the case is covered by that test.

## Limits
- Mocks are not used for the critical boundaries. The authentication tables are a minimal copy of main, not the full chain.
- Publication and analysis counts depend on `M_ANAT_BASE` (integration package).

## Local dev harness (P4 support)
`test/support/anatomy-admin-dev-server.ts` serves this plugin with the real executor and the real JWT and session check on a fresh disposable database.
- It refuses to start outside the disposable environment.
- Its only extras are harness endpoints under `/auth/__dev-*`:
  - switching between two synthetic platform admins, author and reviewer;
  - synthetic fixtures.
- The web P4 real-flow e2e (radar-fiscal-web#131) ran against it.
