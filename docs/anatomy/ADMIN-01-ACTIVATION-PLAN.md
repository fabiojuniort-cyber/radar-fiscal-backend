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
1. **Admin roster.** Operator runs a read-only `SELECT user_id FROM platform_user_roles WHERE role = 'PLATFORM_ADMIN'` and COORD confirms that every listed person is meant to have access. The pilot needs ≥ 2 named admins (author and reviewer). Remove any unintended admin **before** activation (separate authorisation).
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
4. **Pilot usage rules:**
   - only the named admins;
   - **synthetic or reviewed examples only**, no corpus, gold or reserve material (`BLOCK_CORPUS_INPUTS_AND_GOLD`);
   - first cycle = draft → simulate → compare → reject;
   - then one approval/activation with a **scope agreed by COORD**, and an immediate rollback test.

## 4. Monitoring (first 24 h, then daily during the pilot)
| Signal | Source | Stop threshold |
|---|---|---|
| Backend restarts / OOM | Railway deployments and logs | any unexplained restart |
| Backend memory | Railway metrics | > 2 GB sustained, or any OOM |
| 5xx on any route | Railway HTTP metrics | any new 5xx |
| 429 `QUEUE_FULL` / `QUEUE_TIMEOUT` on simulate/compare | HTTP logs (`/api/v1/admin/anatomy-rules`) | repeated refusals in normal use (capacity review) |
| Latency of non-ANAT routes | HTTP logs | p95 regression clearly above baseline while simulations run |
| Audit | `GET /audit` (`anat_list_audit`) | an action without its audit event |

## 5. Turning it off (procedure)
1. Set `ANAT_RULES_ADMIN_ENABLED=false` (or delete it) on the backend and wait for SUCCESS. The ANAT routes go back to **404**; no other route changes.
2. Rebuild the web without `VITE_ENABLE_ANAT_RULES_ADMIN` (screen hidden). The backend switch alone already blocks every operation.
3. **Data is preserved:**
   - drafts, candidates, reviews, activations and audit rows stay (immutable, RESTRICT);
   - nothing is deleted, and no migration is reverted.
4. An **active rule** does not deactivate with the flag. Returning to a previous rule is done **before** switching off, through the API's rollback (preview → confirm), or kept as is by COORD decision.
5. Verify: ANAT 404, `/health` 200, no restart loop; record on #116.

## 6. Open decisions for COORD
- The named pilot admins, and whether to prune `PLATFORM_ADMIN` beforehand.
- The scope of the first activation (global or source) and whether it stays active after the pilot.
- Whether a per-admin allowlist or configurable executor limits are wanted. Either is a new development task, not part of this plan.
