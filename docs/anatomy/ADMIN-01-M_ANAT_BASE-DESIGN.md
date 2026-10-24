# ANAT-ADMIN-01 — `M_ANAT_BASE` design (no numbered migration)

**Status:** design only, for review. No migration file, number or production object is created by this document. The number is taken at integration time as the next free one on `main` (077 is only a historical possibility). Issue: tribusca-control#116.

## 1. Purpose and scope
`M_ANAT_BASE` creates the persistent home of the anatomy engine's results on the real chain. Today these tables exist only in the disposable CI schema `test/support/anatomy-ci-schema.sql`, which the B1 and API suites use. `main` has **no** anatomy table (verified on the real chain, `e4d6639`). `M_ANAT_BASE` must come **before** `M_AUDIT_ANAT` and `M_ANAT_ADMIN`.

Out of scope: the administrative tables (`M_ANAT_ADMIN`), the audit policy (`M_AUDIT_ANAT`), any backfill or reprocessing, and any other front's tables.

## 2. Tables
The same 8 tables and constraints as the CI schema (contract v1, `docs/anatomy/ci-schema.md`), translated with the changes below.

| Table | Role | Change from the CI schema |
|---|---|---|
| `anatomy_rule_sets` | Versioned rule sets (`id`, `rule_hash`, `profiles`) | None |
| `publication_anatomies` | One analysis of a publication version | `publication_version_id uuid` with a FK to `publication_versions(id)` (CI: `text`, no FK); **new** `effective_profile_hash` and `family` (§4) |
| `anatomy_parts` | Part tree (UTF-16 spans) | None; geometry guard kept |
| `anatomy_entities`, `anatomy_evidence` | Occurrences inside parts | None; occurrence guard kept |
| `anatomy_dependencies` | Evidence → dependent part | None |
| `anatomy_runs`, `anatomy_run_items` | Batch runs and their items | `publication_version_id uuid` with a FK, as above |

Kept as in the CI schema: the composite FKs that bind run items to analyses by (engine, rule set, text hash), and the `complete/partial` ⇔ `output_anatomy_id` check. Kept as `text` without a FK:
- `representation_id`: `main` has no representation table;
- `source`: the engine's profile source code, constrained to `PROFILE_SOURCES` by a CHECK (not the `sources(id)` UUID).

## 3. Dependencies on `main`
- `publication_versions(id)` (004). Delete behaviour: **decision for COORD.**
  - Recommended: `ON DELETE CASCADE`. Anatomies are derived and reproducible, and `publication_versions` already cascades from `publications`.
  - Alternative: `RESTRICT`, which would block any future publication purge.
- Roles `radar_app`, `radar_worker` (009). No new login role. `anat_rules_writer` belongs to `M_ANAT_ADMIN`.
- `public.publication_scope_is_in_scope(uuid)` (033), for the app's read policy.
- No change to any existing table, policy or function.

## 4. `effective_profile_hash` and `family`
- `effective_profile_hash char(64) NULL CHECK (effective_profile_hash ~ '^[a-f0-9]{64}$')`: hash of the effective ANAT-PROFILE/1 the engine actually applied (`resolveEffectiveProfile` output, canonical JSON).
- `family text NULL CHECK (family ~ '^[a-z0-9][a-z0-9_-]{0,63}$')`: family used to resolve the profile.
- Both are written by the engine at analysis time, in the same insert, never afterwards.
- `NULL` means "not recorded". The admin API then answers `unsupported` for affected analyses, never 0.
- Index `(source, family, effective_profile_hash)` for the affected-scope count.

**Historical data:** none exists (0 anatomy tables on `main`). If any row exists when the migration runs (another environment), the migration **fails** instead of guessing.
- No hash or family is ever derived, defaulted or backfilled for an existing record.
- Attribution only happens by a future, separately authorised reprocessing that runs the engine again.

## 5. RLS and grants
- `REVOKE ALL ... FROM PUBLIC` and `ENABLE ROW LEVEL SECURITY` on all 8 tables; the owner is the migration role.
- **`radar_worker`** (the pipeline that writes analyses):
  - `SELECT, INSERT` on the analysis tables and `anatomy_runs`/`anatomy_run_items`;
  - `UPDATE` only on the progress columns of runs and items (`cursor`, `counters`, `ended_at`, `duration_ms`, `status`, `attempt`, `error`, `output_anatomy_id`), by column grant;
  - policies `USING (true)`, matching 033's worker policies.
- **`radar_app`:**
  - `SELECT` on `anatomy_rule_sets`;
  - `SELECT` on `publication_anatomies` and its 4 child tables, with policy `publication_scope_is_in_scope(<publication of the version>)`, the same tenant scoping as `publications`;
  - nothing on runs.
- **No `DELETE` for any runtime role, and no `UPDATE` on analyses.** The part and occurrence guards keep identity and geometry immutable.
- `anat_rules_writer` (from `M_ANAT_ADMIN`) gets no direct grant here. The affected-scope count is read inside its own `SECURITY DEFINER` entry point, with `search_path = pg_catalog, public, pg_temp`.

## 6. Compatibility tests (before any number is assigned)
1. **Real chain + `M_ANAT_BASE` on a fresh database (PG16 and PG18):** applies cleanly, one transaction, and fails on a non-empty target.
2. **Structural equivalence:** a catalog diff of the 8 tables against `anatomy-ci-schema.sql`. Only the documented changes (§2, §4) may differ.
3. **B1 and API suites** in the `anatomy-admin-main-chain` job with `M_ANAT_BASE` instead of the CI schema: all green, no test weakened.
4. **Privilege matrix** for `radar_app`, `radar_worker` and a curator:
   - allowed reads and writes as in §5;
   - every other DML refused;
   - the app sees only analyses of in-scope publications;
   - `radar_app` still has no CREATE on `public`.
5. **No other object changes:** a catalog snapshot before and after shows only new objects; existing policies, grants and functions are byte-identical.
6. **Engine identity** `b6ccf583…` unchanged. A synthetic analysis written by the worker role round-trips with its `effective_profile_hash` and `family`.
7. **Rollback:** dropping the 8 tables in reverse dependency order is valid while they are empty. With data, rollback is a separate authorised plan.

## 7. Open decisions
- `ON DELETE` behaviour for `publication_versions` (§3).
- Whether `family` should be constrained to a closed list once the taxonomy front defines one (not assumed here).
- The migration number, assigned at integration time.
