-- Reusable PG18 security gate. Only booleans/assertions leave the server.
-- SET ROLE reachability is distinct from inherited privileges (NOINHERIT).
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 1 / CASE WHEN current_setting('server_version_num')::int / 10000=18
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('radar_app','radar_worker','radar_taxonomy_curator'))=3
  THEN 1 ELSE 0 END;
WITH RECURSIVE runtime_members(oid) AS (
  -- Explicit memberships identify runtimes; do not use superuser shortcuts.
  SELECT oid FROM pg_roles WHERE rolname IN
    ('radar_app','radar_worker','radar_taxonomy_curator','radar_app_runtime','radar_worker_runtime','radar_taxonomy_curator_runtime')
  UNION
  SELECT m.member FROM pg_auth_members m JOIN runtime_members r ON r.oid=m.roleid
), assumable AS (
  SELECT DISTINCT candidate.oid
  FROM runtime_members runtime CROSS JOIN pg_roles candidate
  WHERE candidate.oid=runtime.oid OR pg_has_role(runtime.oid,candidate.oid,'SET')
), functions AS (
  SELECT p.* FROM pg_proc p WHERE p.oid IN (
    'public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)'::regprocedure,
    'public.restore_publication_scope_on_material_change(uuid,text)'::regprocedure)
), ledgers AS (
  SELECT c.* FROM pg_class c WHERE c.oid IN (
    'public.publication_scope_events'::regclass,
    'public.publication_scope_state'::regclass,
    'public.publication_scope_epoch_state'::regclass)
), unsafe AS (
  -- Special role attributes are not inherited; inspect every SET-able role.
  SELECT 1 AS violation FROM assumable a JOIN pg_roles r ON r.oid=a.oid
  WHERE r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
  UNION ALL
  -- Database/public-schema owners can destroy the ledgers indirectly via DDL.
  SELECT 1 FROM assumable a CROSS JOIN pg_database d
  WHERE d.datname=current_database() AND (a.oid=d.datdba OR pg_has_role(a.oid,d.datdba,'USAGE'))
  UNION ALL
  SELECT 1 FROM assumable a CROSS JOIN pg_namespace n
  WHERE n.nspname='public' AND (a.oid=n.nspowner OR pg_has_role(a.oid,n.nspowner,'USAGE'))
  UNION ALL
  SELECT 1 FROM assumable a CROSS JOIN functions f
  WHERE has_function_privilege(a.oid,f.oid,'EXECUTE')
    OR a.oid=f.proowner OR pg_has_role(a.oid,f.proowner,'USAGE')
  UNION ALL
  -- Owners may grant themselves privileges even after an explicit REVOKE.
  SELECT 1 FROM assumable a CROSS JOIN ledgers l
  WHERE a.oid=l.relowner OR pg_has_role(a.oid,l.relowner,'USAGE')
    OR has_table_privilege(a.oid,l.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR has_any_column_privilege(a.oid,l.oid,'SELECT,INSERT,UPDATE,REFERENCES')
  UNION ALL
  -- Check PUBLIC separately, including table/column grants and grant options.
  SELECT 1 FROM functions f
  CROSS JOIN LATERAL aclexplode(nullif(coalesce(f.proacl,acldefault('f',f.proowner)),'{}'::aclitem[])) acl
  WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
  UNION ALL
  SELECT 1 FROM ledgers l
  CROSS JOIN LATERAL aclexplode(nullif(coalesce(l.relacl,acldefault('r',l.relowner)),'{}'::aclitem[])) acl
  WHERE (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM assumable))
    AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
  UNION ALL
  SELECT 1 FROM ledgers l JOIN pg_attribute column_acl ON column_acl.attrelid=l.oid
  CROSS JOIN LATERAL aclexplode(nullif(column_acl.attacl,'{}'::aclitem[])) acl
  WHERE column_acl.attnum>0 AND NOT column_acl.attisdropped
    AND (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM assumable))
    AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','REFERENCES')
)
SELECT 1 / CASE WHEN (SELECT count(*) FROM functions)=2 AND (SELECT count(*) FROM ledgers)=3
  AND (SELECT count(*) FROM assumable)>=3 AND NOT EXISTS (SELECT 1 FROM unsafe)
  THEN 1 ELSE 0 END;
-- Check each runtime family separately: SET ROLE cannot bypass narrow grants.
WITH RECURSIVE members(family,oid) AS (
  SELECT rolname,oid FROM pg_roles WHERE rolname IN ('radar_app','radar_worker','radar_taxonomy_curator')
  UNION
  SELECT r.family,m.member FROM pg_auth_members m JOIN members r ON r.oid=m.roleid
), reachable AS (
  SELECT DISTINCT r.family,c.oid FROM members r CROSS JOIN pg_roles c
  WHERE c.oid=r.oid OR pg_has_role(r.oid,c.oid,'SET')
), narrow(signature) AS (VALUES
  ('public.publication_scope_is_in_scope(uuid)'),
  ('public.publication_scope_company_publication_is_in_scope(uuid)'),
  ('public.publication_scope_epoch()'),
  ('public.publication_scope_imported_today(uuid)'),
  ('public.publication_scope_lock_curator_version(uuid)')
), violations AS (
  SELECT 1 FROM reachable r
  WHERE (r.family='radar_app' AND (
    has_column_privilege(r.oid,'public.collection_run_publications','publication_id','SELECT') OR
    has_column_privilege(r.oid,'public.collection_run_publications','publication_version_id','SELECT') OR
    has_column_privilege(r.oid,'public.collection_run_publications','detected_at','SELECT')))
    OR (r.family IN ('radar_app','radar_worker') AND
      has_function_privilege(r.oid,'public.publication_scope_lock_curator_version(uuid)','EXECUTE'))
    OR (r.family IN ('radar_worker','radar_taxonomy_curator') AND
      has_function_privilege(r.oid,'public.publication_scope_imported_today(uuid)','EXECUTE'))
  UNION ALL
  SELECT 1 FROM narrow n JOIN pg_proc p ON p.oid=n.signature::regprocedure
  CROSS JOIN LATERAL aclexplode(nullif(coalesce(p.proacl,acldefault('f',p.proowner)),'{}'::aclitem[])) acl
  WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
)
SELECT 1 / CASE WHEN NOT EXISTS(SELECT 1 FROM violations)
  AND has_function_privilege('radar_taxonomy_curator','public.publication_scope_lock_curator_version(uuid)','EXECUTE')
  AND has_function_privilege('radar_app','public.publication_scope_imported_today(uuid)','EXECUTE')
  AND has_column_privilege('radar_app','public.collection_run_publications','collection_run_id','SELECT')
  AND has_column_privilege('radar_app','public.collection_run_publications','disposition','SELECT')
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('radar_app'),('radar_worker')) r(role_name)
    CROSS JOIN (VALUES ('public.publication_scope_is_in_scope(uuid)'),
      ('public.publication_scope_company_publication_is_in_scope(uuid)'),
      ('public.publication_scope_epoch()')) f(signature)
    WHERE NOT has_function_privilege(r.role_name,f.signature,'EXECUTE'))
  THEN 1 ELSE 0 END;
ROLLBACK;
