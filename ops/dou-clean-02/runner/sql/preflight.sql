BEGIN READ ONLY;
SELECT 1 / CASE WHEN current_setting('server_version_num')::int / 10000 = 18
  AND (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
  AND current_user NOT IN ('radar_app','radar_worker','radar_taxonomy_curator')
  AND to_regprocedure('public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)') IS NOT NULL
  AND to_regprocedure('public.publication_scope_imported_today(uuid)') IS NOT NULL
  AND (SELECT count(*) FROM public.publication_scope_epoch_state WHERE singleton AND epoch >= 0) = 1
  THEN 1 ELSE 0 END;
WITH expected(filename,checksum) AS (VALUES
  ('033_publication_scope_suppression.sql','3b45146c6d5a5a78c88e401b8c2a897647a3572074acb9613bcb2357607dee94'),
  ('034_publication_scope_cache_epoch.sql','c288dd044faf00058649b19bdd7e343000973b1eae38500add0f636ac024ccea'),
  ('035_publication_scope_collection_history.sql','26bb15362d5bb8bbbce56499f1d50e6d75bfcd4771694ca40562aa289592cc00'))
SELECT 1 / CASE WHEN count(*) = 3 AND bool_and(m.checksum = e.checksum) THEN 1 ELSE 0 END
FROM expected e JOIN public.schema_migrations m USING(filename);
WITH RECURSIVE runtime(oid) AS (
  SELECT oid FROM pg_roles WHERE rolname IN
    ('radar_app','radar_worker','radar_taxonomy_curator','radar_app_runtime','radar_worker_runtime')
  UNION SELECT m.member FROM pg_auth_members m JOIN runtime r ON r.oid=m.roleid
)
SELECT 1 / CASE WHEN count(*) >= 3 AND bool_and(NOT r.rolsuper AND NOT r.rolbypassrls
  AND NOT has_function_privilege(r.oid,
    'public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)','EXECUTE')
  AND NOT has_function_privilege(r.oid,'public.restore_publication_scope_on_material_change(uuid,text)','EXECUTE')
  AND NOT pg_has_role(r.oid,p.proowner,'MEMBER')) THEN 1 ELSE 0 END
FROM runtime rt JOIN pg_roles r ON r.oid=rt.oid CROSS JOIN pg_proc p
WHERE p.oid='public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)'::regprocedure;
SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)'::regprocedure
    AND a.grantee=0 AND a.privilege_type='EXECUTE')
  AND NOT has_column_privilege('radar_app','public.collection_run_publications','publication_id','SELECT')
  AND has_column_privilege('radar_app','public.collection_run_publications','collection_run_id','SELECT')
  AND has_column_privilege('radar_app','public.collection_run_publications','disposition','SELECT')
  THEN 1 ELSE 0 END;
ROLLBACK;
