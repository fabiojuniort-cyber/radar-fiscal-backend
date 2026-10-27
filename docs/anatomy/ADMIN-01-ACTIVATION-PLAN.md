# ANAT-ADMIN-01 — activation plan (prepared, NOT executed)

**Status:** preparation only (issue tribusca-control#116).

The feature is **installed and off** in production:
- backend `e4fbcf0` (migrations 077–079 applied, verifiers green);
- web `bea201d`;
- `ANAT_RULES_ADMIN_ENABLED` and `VITE_ENABLE_ANAT_RULES_ADMIN` absent.

Turning it on needs a separate COORD decision. RESTRICT and `BLOCK_CORPUS_INPUTS_AND_GOLD` stay in force.

## 1. What the switches actually do (code on main)
| Switch | Where | Effect | How it changes |
|---|---|---|---|
| `ANAT_RULES_ADMIN_ENABLED` | backend `radar-fiscal-backend` (Railway variable) | `'true'` registers `/api/v1/admin/anatomy-rules/*` and one simulation executor per instance; anything else leaves the routes unregistered (404) | changing the variable redeploys the backend; `db:prepare` runs again, idempotent |
| `VITE_ENABLE_ANAT_RULES_ADMIN` | web `web05-preview` (build variable) | shows `/admin/anatomia-regras` in the build | **build-time**: needs a web rebuild/redeploy |

**Access control:**
- With the server flag on, **every user with `PLATFORM_ADMIN`** (`platform_user_roles`) can use the API. There is **no per-admin allowlist** in the code. The database enforces the same predicate in the SECURITY DEFINER functions.
- So "authorised administrators" is governed by **`PLATFORM_ADMIN` membership**.
- The author cannot review their own candidate (409), so a full cycle needs **at least two** admins.

**Executor limits are constants in code** (`EXECUTOR_LIMITS`), with no environment variable:
- concurrency 2, queue 10, queue wait 5 s;
- 2 s per example, 60 s total;
- 256 MB heap per worker; output 2 MiB; profiles 64 KiB; 20 examples of up to 256 Ki UTF-16.
- Changing any of them is a code change with review, not an operational knob.

## 2. Pre-activation checklist (all required)
1. **Admin roster: every `PLATFORM_ADMIN` who would get access.**
   - **Turning the flag on gives technical access to EVERY unrevoked `PLATFORM_ADMIN`.** There is no per-admin list. Naming two participants decides who conducts the pilot; it does **not** technically restrict anyone else.
   - The roles are not changed by this plan. The inventory below exists only so COORD and Fábio can see exactly who would gain access.
   - The operator lists them read-only, returning ids and e-mails only to COORD and Fábio, never in the issue:
     ```sql
     BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '5s';
     SELECT r.user_id, u.email, r.granted_at FROM platform_user_roles r JOIN app_users u ON u.id = r.user_id
      WHERE r.role = 'PLATFORM_ADMIN' AND r.revoked_at IS NULL ORDER BY r.granted_at;
     ROLLBACK;
     ```
     (Unrevoked roles only. Nothing else is read.)
   - COORD confirms each listed person is acceptable for the pilot. If anyone is not, removing the role is a **separate authorisation** and happens before activation.
   - **No development is added for this**: no per-admin allowlist, no configurable limits (COORD guidance).
   - **Pilot admins: two people named by Fábio** (author and reviewer; the author cannot review their own candidate). Pending.
2. **Capacity.**
   - Rehearsal: peak process RSS ~700 MiB with 2 concurrent near-limit simulations; at 512 MiB and below, the whole process was OOM-killed.
   - Production backend today: limit 24 GB, use 68–274 MB, 1 replica. **OK**, but record that the API shares this process: an OOM takes every route down.
   - The worker and scheduler services do not run simulations.
3. **Restart supervision:** backend `restartPolicyMaxRetries` = 3 (Railway restarts on crash). Confirm acceptable; an OOM would also show as a restart here.
4. **Baseline** taken just before activation:
   - memory, CPU, 5xx and latency of the backend (last 24 h);
   - `/health` 200, ANAT 404.
5. **Backup:** latest full/diff pgBackRest backup and continuous WAL confirmed in the Postgres logs (no restore test exists; record it again).
6. **Rollback rehearsal of the switch is not needed:** turning the flag off was exercised in the isolated rehearsal (data preserved, restart healthy).

## 3. Activation sequence (when authorised)
1. Backend: set `ANAT_RULES_ADMIN_ENABLED=true` on `radar-fiscal-backend` **only** (not worker/scheduler). Wait for SUCCESS; pre-deploy logs show "up to date" plus the three verifiers.
2. HTTP checks (operator):
   - ANAT without token → **401** (was 404);
   - non-admin token → 403;
   - `/health` 200;
   - other routes unchanged (`/api/v1/admin/me` 401 without token).
3. Web: set `VITE_ENABLE_ANAT_RULES_ADMIN=true` on `web05-preview` and redeploy. Site 200; the screen is visible only to admins.
4. **Pilot scope: the smallest possible.**
   - **Who conducts it:** the two named admins.
     - Every other unrevoked `PLATFORM_ADMIN` **keeps technical access** while the flag is on (§2.1). For them it is an organisational instruction not to use the screen, checked afterwards through the audit actors (§4).
   - **Inputs:** synthetic or already-reviewed examples only, typed in the draft. No corpus, gold or reserve material (`BLOCK_CORPUS_INPUTS_AND_GOLD`), and no bulk or batch processing (the API has none; it is not added).
   - **Operations allowed:** draft → freeze → simulate → compare → review (one rejection and one approval, by the other admin).
   - **Not in the pilot: no activation.** `activation/preview` and `confirm` are **not used**, so the **rules in force do not change**.
     - The routes exist; this is a usage rule checked through the audit (`ANAT_RULES_ACTIVATED` must stay absent).
     - Activating a rule is a later, separate COORD decision with its own scope.
   - **Duration:** a short window agreed in advance (for example one working session), then the flag goes back off unless COORD extends it.

## 4. Monitoring (first 24 h, then daily during the pilot)
| Signal | Source | Stop threshold |
|---|---|---|
| Backend restarts / OOM | Railway deployments and logs | any unexplained restart |
| Backend memory | Railway metrics | > 2 GB sustained, or any OOM |
| 5xx on any route | Railway HTTP metrics | any new 5xx |
| 429 `QUEUE_FULL` / `QUEUE_TIMEOUT` on simulate/compare | HTTP logs (`/api/v1/admin/anatomy-rules`) | repeated refusals in normal use (capacity review) |
| Latency of non-ANAT routes | HTTP logs | p95 regression clearly above baseline while simulations run |
| Audit | `GET /audit` (`anat_list_audit`) | an action without its audit event; **any `ANAT_RULES_ACTIVATED` during the pilot** |
| Actors | `GET /audit` actor ids | any actor outside the two named admins |

## 5. Turning it off (procedure)
1. Set `ANAT_RULES_ADMIN_ENABLED=false` (or delete it) on the backend and wait for SUCCESS. The ANAT routes go back to **404**; no other route changes.
2. Rebuild the web without `VITE_ENABLE_ANAT_RULES_ADMIN` (screen hidden). The backend switch alone already blocks every operation.
3. **Data is preserved:**
   - drafts, candidates, reviews, activations and audit rows stay (immutable, RESTRICT);
   - nothing is deleted, and no migration is reverted.
4. An **active rule** does not deactivate with the flag. Returning to a previous rule is done **before** switching off, through the API's rollback (preview → confirm), or kept as is by COORD decision.
5. Verify: ANAT 404, `/health` 200, no restart loop; record on #116.

## 6. Open decisions for COORD
- **Fábio:** the two pilot admins (the only personal definition pending).
- **COORD:**
  - confirm the full `PLATFORM_ADMIN` roster (§2.1), and whether any role is removed first (separate authorisation);
  - the pilot window.
- **Out of this plan (COORD guidance):**
  - no per-admin allowlist, no configurable limits;
  - no activation of rules in the pilot. Any later activation needs its own decision and scope.

## 7. CI coverage of the migration chain (for reviewers)
Since #271 (main `fd568acc`), the ANAT CI has two kinds of job.

**`anatomy-admin-main-chain` (rehearsal over main's chain).**
- `test/support/anatomy-admin-db.ts` applies only main's migrations **before `077_anat_base.sql`**, then the accepted rehearsal ANAT SQL.
- This is an **adapted** chain. It does **not** prove compatibility of 077–079 with 080 or any later migration.

**`anatomy-admin-migrations` (project runner, `ANAT_PROJECT_MIGRATIONS=1`).** This is where the real chain is proven. How far each suite applies:

| Suite | Chain applied before its checks |
|---|---|
| `admin-schema` | up to 077, policy snapshot, then **the complete chain (080 included)** |
| `admin-api` | **complete chain** (`prepareAdminDatabase`) |
| `admin-wiring` | **complete chain** (`prepareAdminDatabase`) |
| `admin-migrations` | **only up to 079** (`runProjectMigrations(url, '079_anat_rules_admin.sql')` since #271) |
| `anatomy-base-migration` | only up to 077 (by design) |

**What limiting `admin-migrations` to 078–079 stops checking:**
- the P-INT-03 refusals of 078 (tampered audit policy) are exercised with **080+ absent**;
- "078 then 079 apply; re-running is a no-op" and the before/after catalog delta are measured **only up to 079**;
- this suite therefore does not show that later migrations leave the ANAT catalog, privileges and audit policy unchanged.

That property is still asserted over the complete chain by `admin-schema`:
- every pre-existing audit event keeps its rule and projection;
- privileges, RLS and search_path checks.

`080_onb03_assistant_phrases.sql` creates only `onboarding_phrases` (its own grants and RLS) and touches no ANAT object or audit policy.
