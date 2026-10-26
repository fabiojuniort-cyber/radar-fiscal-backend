-- ANAT-ADMIN-01 controlled rollout, preflight of the TARGET database (issue tribusca-control#116).
-- READ ONLY: one READ ONLY transaction, short timeouts, ROLLBACK at the end. It reads only catalog metadata,
-- schema_migrations, planner statistics and EXPLAIN plans WITHOUT execution (no ANALYZE): no customer row is read
-- or exported, nothing is written, no global count is run.
-- Run by an operator with authorised access to the target (superuser or owner, to read the catalog and SET ROLE):
--   psql "$TARGET_ADMIN_URL" -X -A -t -v ON_ERROR_STOP=1 -f ops/anatomy/preflight/target-readonly.sql > preflight.txt
-- Compare each line with ops/anatomy/preflight/EXPECTED.md (computed from main c7a8df1 on PostgreSQL 18).
\set ON_ERROR_STOP on
SET statement_timeout = '5s';
SET lock_timeout = '1s';
SET idle_in_transaction_session_timeout = '60s';
BEGIN TRANSACTION READ ONLY;
SELECT 'read_only|' || current_setting('transaction_read_only');
SELECT 'server_major|' || current_setting('server_version_num')::int / 10000;
-- Migrations: chain ends at 076, 077–079 not applied, same files and checksums as main.
SELECT 'migrations|' || count(*) || '|' || max(filename) FROM schema_migrations;
SELECT 'migrations_fp|' || md5(string_agg(filename || ':' || checksum, ',' ORDER BY filename)) FROM schema_migrations;
SELECT 'anat_migrations_applied|' || count(*) FROM schema_migrations WHERE filename ~ '^0(77|78|79)_';
-- No ANAT object exists yet (a non-zero value means an earlier partial apply or a name clash).
SELECT 'anat_relations|' || count(*) FROM pg_class
  WHERE relnamespace = 'public'::regnamespace AND (relname LIKE 'anatomy\_%' OR relname = 'publication_anatomies');
SELECT 'anat_functions|' || count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'anat\_%';
SELECT 'anat_writer_role|' || count(*) FROM pg_roles WHERE rolname = 'anat_rules_writer';
-- Audit policy in force: 078 applies only over EXACTLY this JSON (P-INT-03 fail-closed check).
SELECT 'audit_policy_fp|' || coalesce(md5((substring(pg_get_functiondef(to_regprocedure('public.audit_event_policy(text,text)'))
  FROM '\$json\$(.*)\$json\$'))::jsonb::text), 'MISSING');
SELECT 'audit_policy_events|' || (SELECT count(*) FROM jsonb_object_keys((substring(pg_get_functiondef(
  to_regprocedure('public.audit_event_policy(text,text)')) FROM '\$json\$(.*)\$json\$'))::jsonb));
-- audit_log row-level security, policies and indexes (definitions only).
SELECT 'audit_log_rls|' || relrowsecurity || '|' || relforcerowsecurity FROM pg_class WHERE oid = 'public.audit_log'::regclass;
SELECT 'audit_log_policies|' || count(*) || '|' || md5(string_agg(policyname || permissive || cmd || array_to_string(roles, ',')
  || coalesce(qual, '') || coalesce(with_check, ''), ';' ORDER BY policyname)) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_log';
SELECT 'audit_log_indexes|' || count(*) || '|' || md5(string_agg(indexdef, ';' ORDER BY indexname)) FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'audit_log';
-- Roles the chain provisions and their flags (super, bypassrls, login).
SELECT 'role|' || rolname || '|' || rolsuper || '|' || rolbypassrls || '|' || rolcanlogin FROM pg_roles
  WHERE rolname IN ('radar_app', 'radar_app_runtime', 'radar_worker', 'radar_worker_runtime', 'radar_taxonomy_curator',
    'radar_taxonomy_curator_runtime') ORDER BY rolname;
SELECT 'public_create|radar_app|' || has_schema_privilege('radar_app', 'public', 'CREATE');
-- Volume from planner statistics only (no count): live rows, size, share of global rows (tenant_id NULL).
SELECT 'audit_log_stats|' || n_live_tup || '|' || pg_total_relation_size('public.audit_log') || '|' || coalesce(last_analyze, last_autoanalyze)::text
  FROM pg_stat_user_tables WHERE relid = 'public.audit_log'::regclass;
SELECT 'audit_log_tenant_null_frac|' || coalesce(null_frac::text, 'no stats') FROM pg_stats
  WHERE schemaname = 'public' AND tablename = 'audit_log' AND attname = 'tenant_id';
-- Plans of the paths 078/079 touch, as the runtime roles, WITHOUT execution. The ids are random: no real tenant.
SET LOCAL ROLE radar_app;
SELECT set_config('app.user_id', '00000000-0000-4000-8000-00000000a001', true), set_config('app.tenant_id', '00000000-0000-4000-8000-00000000a002', true);
EXPLAIN SELECT id FROM audit_log WHERE tenant_id = '00000000-0000-4000-8000-00000000a002' ORDER BY occurred_at DESC LIMIT 100;
RESET ROLE;
SET LOCAL ROLE radar_worker;
EXPLAIN SELECT count(*) FROM audit_log WHERE tenant_id IS NULL;
RESET ROLE;
SET LOCAL ROLE radar_taxonomy_curator;
EXPLAIN SELECT count(*) FROM audit_log WHERE tenant_id IS NULL;
RESET ROLE;
ROLLBACK;
