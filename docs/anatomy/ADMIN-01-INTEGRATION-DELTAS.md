# ANAT-ADMIN-01 — integration deltas authorised after the accepted rehearsal

**Scope:** integration package 2 (migrations 078/079), COORD integration R1 (issue tribusca-control#116).
- The accepted rehearsal files (`test/support/anatomy-admin-audit-policy.sql`, `test/support/anatomy-admin-ci-schema.sql`) are **unchanged**.
- The deltas exist only in the numbered migrations.
- `test/anatomy.admin-migrations.unit.test.ts` checks mechanically that each migration is the accepted SQL plus exactly these named deltas.

## P-INT-01 — the ANAT audit is read through a dedicated entry point (079, delimited block)

| | Accepted rehearsal (B1-R1-03) | After P-INT-01 |
|---|---|---|
| `radar_app` SELECT on ANAT rows of `audit_log` | permissive policy `audit_log_anat_rules_admin_select` (active platform admin) | **no policy**: a direct read returns 0 ANAT rows for everyone |
| How an admin reads the ANAT audit | direct `SELECT` | `public.anat_list_audit(p_limit integer)` |
| Writer (`anat_rules_writer`) on `audit_log` | INSERT (ANAT rows, 078) | INSERT + SELECT with policy `audit_log_anat_rules_writer_select`: `tenant_id IS NULL AND entity_type = 'anatomy_rules' AND action LIKE 'ANAT\_RULES\_%'` |
| Worker / curator | RESTRICTIVE: never see ANAT rows | unchanged |

`anat_list_audit` is the ninth entry point:
- SECURITY DEFINER, owned by `anat_rules_writer` (NOLOGIN, NOINHERIT, no BYPASSRLS), with `search_path = pg_catalog, public, pg_temp` and every relation and function schema-qualified.
- Fixed output: `(id, action, entity_id, actor_id, data, correlation_id, occurred_at)`.
- Limit validated to 1–500; anything else, NULL included, is `anat:LIMIT_EXCEEDED`.
- No free SQL, filter or object name.
- First statement `anat_actor()`: an active, unrevoked PLATFORM_ADMIN in the authenticated context of the transaction (`app.user_id`), otherwise `ACTOR_REQUIRED` or `PLATFORM_ADMIN_REQUIRED`.
- EXECUTE revoked from PUBLIC; granted only to `radar_app`.
- API: `listAudit` (rules-admin.service.ts) calls the function.

Tests (B1 suite, all three modes):
- `P-INT-01: anat_list_audit is the only ANAT audit read path`:
  - definer hygiene;
  - fixed result type;
  - no `radar_app` ANAT policy;
  - limit 0/−1/501/NULL refused and 1 honoured;
  - worker and curator: no EXECUTE and no direct ANAT rows;
  - a TEMP `audit_log` plus `search_path = pg_temp, public` are ignored.
- `B1-R1-03`:
  - direct reads return 0 for an admin, no session, a common user and a revoked admin;
  - the function serves the admin and refuses the others;
  - admin tables keep their admin-only policy.

## P-INT-03 — fail-closed check of the policy in force (078, before any change)
Before replacing `audit_event_policy`, 078 refuses, with nothing created or registered, when:
- the function is missing;
- the `$json$` delimiter count is not 2;
- the body is not the recognised `$json$::jsonb -> (p_action||'|'||p_type)` lookup;
- the extraction is NULL;
- the JSON is invalid or not an object;
- the installed JSON does not carry exactly 8 ANAT events;
- the policy in force is not **exactly** the base this migration extends (any added, removed or changed event).

Every comparison is NULL-safe (`IS DISTINCT FROM`, explicit NULL checks).

Tests (`anatomy.admin-migrations.integration`): eight tampered policies, each refused with its own message:
- added event;
- changed event;
- removed event;
- no delimiter;
- different lookup;
- invalid JSON;
- array;
- `null`.

After each refusal:
- the policy in force is byte-identical;
- no 078/079 row in `schema_migrations`;
- no ANAT `audit_log` policy;
- no `anat_*` function and no admin table.

The positive path (078 → 079 apply, re-run is a no-op) is kept.
