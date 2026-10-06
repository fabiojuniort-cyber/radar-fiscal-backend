-- Reusable PG18 security gate. Only booleans/assertions leave the server.
-- SET ROLE reachability is distinct from inherited privileges (NOINHERIT).
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 1 / CASE WHEN current_setting('server_version_num')::int / 10000=18
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('radar_app','radar_worker','radar_taxonomy_curator'))=3
  THEN 1 ELSE 0 END;
WITH RECURSIVE runtime_members(oid) AS (
  -- Explicit memberships identify runtimes; do not use superuser shortcuts.
  SELECT oid FROM pg_roles WHERE rolname IN
    ('radar_app','radar_worker','radar_taxonomy_curator','radar_app_runtime','radar_worker_runtime')
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
    OR has_table_privilege(a.oid,l.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR has_any_column_privilege(a.oid,l.oid,'INSERT,UPDATE,REFERENCES')
  UNION ALL
  -- Check PUBLIC separately, including table/column grants and grant options.
  SELECT 1 FROM functions f
  CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl
  WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
  UNION ALL
  SELECT 1 FROM ledgers l
  CROSS JOIN LATERAL aclexplode(coalesce(l.relacl,acldefault('r',l.relowner))) acl
  WHERE (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM assumable))
    AND acl.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
  UNION ALL
  SELECT 1 FROM ledgers l JOIN pg_attribute column_acl ON column_acl.attrelid=l.oid
  CROSS JOIN LATERAL aclexplode(coalesce(column_acl.attacl,'{}'::aclitem[])) acl
  WHERE column_acl.attnum>0 AND NOT column_acl.attisdropped
    AND (acl.grantee=0 OR acl.grantee IN (SELECT oid FROM assumable))
    AND acl.privilege_type IN ('INSERT','UPDATE','REFERENCES')
)
SELECT 1 / CASE WHEN (SELECT count(*) FROM functions)=2 AND (SELECT count(*) FROM ledgers)=3
  AND (SELECT count(*) FROM assumable)>=3 AND NOT EXISTS (SELECT 1 FROM unsafe)
  THEN 1 ELSE 0 END;
ROLLBACK;
