DO $$
DECLARE
  gateway oid := 'public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)'::regprocedure;
  readiness oid := 'public.platform_dou_limits_ready()'::regprocedure;
  ops_login text := 'radar_dou_limits_runtime';
  privileges text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=ops_login AND rolcanlogin
    AND NOT (rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid
      WHERE r.rolname=ops_login)
    OR has_schema_privilege(ops_login,'public','CREATE') THEN
    RAISE EXCEPTION 'Unexpected OPS runtime role privileges or memberships';
  END IF;

  IF NOT has_function_privilege(ops_login,gateway,'EXECUTE')
    OR has_function_privilege('radar_app_runtime',gateway,'EXECUTE')
    OR has_function_privilege('radar_worker_runtime',gateway,'EXECUTE')
    OR NOT has_function_privilege('radar_app_runtime',readiness,'EXECUTE')
    OR EXISTS (SELECT FROM pg_proc p
      WHERE p.oid IN (gateway,readiness) AND (
        NOT p.prosecdef OR pg_get_userbyid(p.proowner) IN (ops_login,'radar_app_runtime','radar_worker_runtime')
        OR NOT ('search_path=pg_catalog, pg_temp'=ANY(p.proconfig))
        OR EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))) THEN
    RAISE EXCEPTION 'Unexpected OPS gateway definition, owner or EXECUTE grants';
  END IF;

  IF has_table_privilege(ops_login,'public.sources','UPDATE')
    OR has_table_privilege('radar_app_runtime','public.sources','UPDATE')
    OR EXISTS (SELECT FROM pg_class c CROSS JOIN unnest(privileges) AS v(privilege)
      WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
        AND (c.relname LIKE 'auth_password_reset_%' OR c.relname IN
          ('ops_dou_limits_signing_keys','ops_dou_limits_used_nonces','audit_log'))
        AND has_table_privilege(ops_login,c.oid,v.privilege))
    OR EXISTS (SELECT FROM pg_class c CROSS JOIN unnest(privileges) AS v(privilege)
      WHERE c.oid IN ('public.ops_dou_limits_signing_keys'::regclass,'public.ops_dou_limits_used_nonces'::regclass)
        AND (has_table_privilege('radar_app_runtime',c.oid,v.privilege)
          OR has_table_privilege('radar_worker_runtime',c.oid,v.privilege))) THEN
    RAISE EXCEPTION 'Unexpected direct table privileges';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace
       AND proname='auth_password_reset_redeem')
    OR EXISTS (SELECT FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
       AND p.proname LIKE 'auth_password_reset_%' AND has_function_privilege(ops_login,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Unexpected AUTH function exposure to OPS';
  END IF;
END $$;
