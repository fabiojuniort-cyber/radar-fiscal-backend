# ANAT-ADMIN-01 — target preflight: expected results

`target-readonly.sql` is read-only. It runs one `READ ONLY` transaction with a 5 s statement timeout and ends in `ROLLBACK`. It reads only:
- catalog and `schema_migrations` metadata;
- planner statistics;
- `EXPLAIN` plans **without execution**.

It reads no customer rows and writes nothing.

## How to run (operator with authorised access; no secret in the command line)
```
psql "$TARGET_ADMIN_URL" -X -A -t -v ON_ERROR_STOP=1 -f ops/anatomy/preflight/target-readonly.sql > preflight.txt
```
Return `preflight.txt`. It contains no secrets and no customer data: only hashes, counts from statistics, and plans.

## Expected values: main `c7a8df1` on PostgreSQL 18, real runner and `provision-runtime-role`

| Line | Expected | If different |
|---|---|---|
| `read_only` | `on` | stop: the transaction is not read-only |
| `server_major` | `18` | stop: the rehearsal and the CI matrix assume 16/18; 18 is the target |
| `migrations` | `…|076_companies_active_only.sql` (70 rows locally) | another last file: **material divergence**, so revalidate the chain. A different count with the same fingerprint cannot happen. |
| `migrations_fp` | `580f3e2d6d039f2b4956812d1589ec13` | a file or checksum differs from main: stop and compare `schema_migrations` |
| `anat_migrations_applied`, `anat_relations`, `anat_functions`, `anat_writer_role` | `0` each | an earlier partial apply or a name clash: stop |
| `audit_policy_fp` | `dcabfaf08cddd79e101e8b63323fd3c2` | 078 would refuse at pre-deploy (P-INT-03), so the deploy fails and the previous version stays. Rebase 078 before any merge. |
| `audit_policy_events` | `55` | same as above |
| `audit_log_rls` | `true|true` | stop |
| `audit_log_policies` | `6|995a20a576e824ac1040703c47b80758` | another front changed `audit_log` policies: review against 077/078 before merging |
| `audit_log_indexes` | `7|91fc7aa7c738e671bd0227d57548cf09` | review; plans may change |
| `role|…` | the three group roles `false|false|false`; the three `_runtime` logins `false|false|true` | stop if any is superuser or `BYPASSRLS` |
| `public_create|radar_app` | `false` | stop |
| `audit_log_stats` | live rows, total bytes, last analyze (operational data, no expected value) | input for the cost estimate below |
| `audit_log_tenant_null_frac` | share of global rows | input for the cost estimate below |

## Plans (without execution)
On a populated `audit_log`:
- **`radar_app`, tenant latest 100:** the index on `(tenant_id, occurred_at)` (Index Scan or Index Scan Backward), with the RLS filter. This path must not change with 077–079; in the rehearsal it stayed an Index Scan (1.5 ms at 1M rows).
- **`radar_worker` / `radar_taxonomy_curator`, global count:** an Index Only Scan or Bitmap Heap Scan on the global rows.
  - After 077–079 these two paths gain the RESTRICTIVE ANAT filter (the residual cost: +72–130 % at 1M synthetic rows).
  - Use `n_live_tup × null_frac` to size it. With few global rows the absolute cost is negligible.

A `Seq Scan on audit_log` on the tenant path with millions of live rows is a pre-existing problem. Record it; it is not caused by ANAT.

These values are from a fresh database. A long-lived target can legitimately differ only in statistics and plans, not in the fingerprints.
