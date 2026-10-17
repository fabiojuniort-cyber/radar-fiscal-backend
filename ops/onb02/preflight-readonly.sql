-- ONB-02 R3 — VERSIONED READ-ONLY SCHEMA INVENTORY.
-- Run only with explicit review approval; this file executes no mutations.
-- Do NOT upload database dumps, CNPJs, personal names or raw audit payloads.
-- psql -X -v ON_ERROR_STOP=1 -f ops/onb02/preflight-readonly.sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT current_database() AS database_name, current_user AS inspection_role,
       current_setting('server_version') AS pg_version,
       pg_is_in_recovery() AS standby,
       clock_timestamp() AS inspected_at;

-- Full recursive inbound FK graph. All tables that can contain company-owned
-- references must be accounted for, including grandchildren and non-CASCADE.
WITH RECURSIVE graph AS (
  SELECT 'public.companies'::regclass::oid AS table_oid,
         ARRAY['public.companies'::regclass::oid] AS ancestors,
         0 AS depth,
         ''::text COLLATE "C" AS constraint_name,
         ''::text COLLATE "C" AS delete_action
  UNION ALL
  SELECT fk.conrelid, graph.ancestors || fk.conrelid, graph.depth+1,
         fk.conname::text COLLATE "C",
         CASE fk.confdeltype
           WHEN 'c' THEN 'CASCADE'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
           ELSE '?' END COLLATE "C"
  FROM graph JOIN pg_constraint fk ON fk.contype='f'
   AND fk.confrelid=graph.table_oid
  WHERE graph.depth<16 AND NOT fk.conrelid=ANY(graph.ancestors)
)
SELECT depth, table_oid::regclass::text AS dependent_table, constraint_name,
       delete_action, array_to_string(ancestors::regclass[], ' -> ') AS path
FROM graph ORDER BY depth, dependent_table, constraint_name;

-- Other references in which a match joins two independent company-owned
-- objects; must always be checked symmetrically.
SELECT conrelid::regclass::text AS referencing_table, conname AS fk,
       confrelid::regclass::text AS referenced_table, confdeltype
FROM pg_constraint WHERE contype='f'
  AND conrelid IN (
    'public.publication_matches'::regclass,
    'public.company_publications'::regclass,
    'public.monitoring_profiles'::regclass,
    'public.tenant_onboarding_profiles'::regclass,
    'public.audit_log'::regclass
  )
ORDER BY referencing_table,fk;

-- Effective runtime permissions and RLS, with no secret values.
SELECT c.oid::regclass::text AS table_name,
       r.rolname AS owner_name, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls,
       has_table_privilege('radar_app_runtime',c.oid,'DELETE') AS runtime_can_delete,
       has_table_privilege('radar_app_runtime',c.oid,'SELECT') AS runtime_can_read
FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
WHERE c.relnamespace='public'::regnamespace
  AND c.relkind IN ('r','p') AND (
    c.relname LIKE 'company_%' OR c.relname IN
    ('companies','establishments','establishment_cnaes','monitoring_profiles',
     'publication_matches','audit_log','tenants','tenant_onboarding_profiles',
     'publications','publication_versions','publication_files')
  ) ORDER BY table_name;

SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname='public'
  AND tablename IN
  ('companies','establishments','company_publications','monitoring_profiles',
   'publication_matches','company_tax_profiles','company_product_profiles',
   'company_product_ncms','company_cnae_ncms','audit_log','tenants')
ORDER BY tablename,policyname;

SELECT rolname,rolsuper,rolinherit,rolbypassrls,rolcreaterole,rolcreatedb
FROM pg_roles
WHERE rolname IN
 ('radar_app','radar_app_runtime','radar_worker','radar_worker_runtime',
  'radar_db_owner','postgres')
ORDER BY rolname;

-- Candidate non-FK references: only schema identifiers are exposed.
SELECT table_schema,table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public'
  AND (column_name ~* '(company|establishment|tenant|cnpj|account)'
       OR udt_name IN ('jsonb','json'))
ORDER BY table_name,column_name;

-- Trigger definitions & privileged deletion entry point fingerprint.
SELECT t.tgrelid::regclass::text AS table_name,t.tgname,t.tgenabled,
       t.tgfoid::regprocedure::text AS trigger_function
FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN
 (SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace)
ORDER BY table_name,tgname;

SELECT p.oid::regprocedure::text AS procedure,
       r.rolname AS owner_name,
       p.prosecdef AS security_definer,
       p.proconfig AS security_settings,
       md5(pg_get_functiondef(p.oid)) AS definition_md5,
       has_function_privilege('radar_app_runtime',p.oid,'EXECUTE') AS app_runtime_execute,
       has_function_privilege('radar_worker_runtime',p.oid,'EXECUTE') AS worker_runtime_execute
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.pronamespace='public'::regnamespace
  AND p.proname IN ('app_purge_company','app_user_is_tenant_admin',
                    'app_current_tenant_id','app_current_user_id');

-- pg_depend on a view's SELECT points to a pg_rewrite _RETURN rule.
-- Joining d.objid directly to pg_class.oid is incorrect and can miss views.
-- Track root dependencies and views-of-views, including materialized views.
WITH RECURSIVE dependent_views AS (
  SELECT r.ev_class AS view_oid,
         d.refobjid AS source_oid,
         d.refobjid AS root_oid,
         ARRAY[d.refobjid,r.ev_class]::oid[] AS visited,
         1 AS depth
  FROM pg_depend d
  JOIN pg_rewrite r
    ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
  JOIN pg_class child ON child.oid=r.ev_class
  WHERE d.refclassid='pg_class'::regclass
    AND child.relkind IN ('v','m')
    AND r.rulename='_RETURN'
    AND r.ev_class<>d.refobjid
    AND d.refobjid IN (
      'public.companies'::regclass,
      'public.monitoring_profiles'::regclass,
      'public.company_publications'::regclass
    )
  UNION ALL
  SELECT r.ev_class, d.refobjid, parent.root_oid,
         parent.visited || r.ev_class, parent.depth+1
  FROM dependent_views parent
  JOIN pg_depend d
    ON d.classid='pg_rewrite'::regclass
   AND d.refclassid='pg_class'::regclass
   AND d.refobjid=parent.view_oid
  JOIN pg_rewrite r ON r.oid=d.objid
  JOIN pg_class child ON child.oid=r.ev_class
  WHERE child.relkind IN ('v','m')
    AND r.rulename='_RETURN'
    AND r.ev_class<>d.refobjid
    AND NOT r.ev_class=ANY(parent.visited)
    AND parent.depth<16
)
SELECT DISTINCT view_oid::regclass::text AS dependent_view,
       root_oid::regclass::text AS root_company_relation,
       depth,
       CASE (SELECT relkind FROM pg_class WHERE oid=view_oid)
         WHEN 'm' THEN 'MATERIALIZED_VIEW'
         ELSE 'VIEW' END AS view_kind
FROM dependent_views
ORDER BY dependent_view,root_company_relation,depth;

-- Trigger definitions alone are not enough; include body fingerprints to
-- reconcile real trigger side effects against the versioned migrations.
SELECT DISTINCT tg.tgfoid::regprocedure::text AS trigger_function,
       pg_get_userbyid(fn.proowner) AS function_owner,
       fn.prosecdef AS security_definer,
       md5(pg_get_functiondef(fn.oid)) AS function_definition_md5
FROM pg_trigger tg JOIN pg_proc fn ON fn.oid=tg.tgfoid
WHERE NOT tg.tgisinternal
  AND tg.tgrelid IN (
     SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace
  )
ORDER BY trigger_function;

-- No raw names, CNPJs, publications or audit contents. Counts alone cannot
-- prove erasure and must be paired with the restore-based per-company manifest.
SELECT 'company_count' AS metric,count(*)::bigint AS count FROM companies
UNION ALL SELECT 'onboarding_with_cnpj', count(*) FROM tenant_onboarding_profiles WHERE cnpj IS NOT NULL
UNION ALL SELECT 'legacy_company_name_only', count(*) FROM tenant_onboarding_profiles WHERE company_name IS NOT NULL AND cnpj IS NULL
UNION ALL SELECT 'cross_company_matches',count(*) FROM publication_matches pm
  JOIN company_publications cp ON cp.id=pm.company_publication_id
  JOIN monitoring_profiles mp ON mp.id=pm.monitoring_profile_id
  WHERE cp.company_id<>mp.company_id
UNION ALL SELECT 'legacy_audit_company_entities',count(*) FROM audit_log
  WHERE entity_type IN ('company','establishment');

ROLLBACK;
