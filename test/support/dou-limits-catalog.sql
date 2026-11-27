-- Snapshot AUTH catalog boundaries and the effective OPS/AUTH privileges in a disposable CI database.
SELECT p.oid::regprocedure::text AS function_signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       p.proconfig AS function_configuration,
       p.proacl::text AS grants,
       has_function_privilege('radar_app_runtime',p.oid,'EXECUTE') AS app_execute,
       has_function_privilege('radar_worker_runtime',p.oid,'EXECUTE') AS worker_execute,
       md5(pg_get_functiondef(p.oid)) AS definition_fingerprint
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'auth_password_reset_%'
ORDER BY function_signature;

SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity,
       c.relforcerowsecurity,c.relacl::text AS grants,pol.polname,
       pg_get_expr(pol.polqual,pol.polrelid) AS using_expression,
       pg_get_expr(pol.polwithcheck,pol.polrelid) AS check_expression
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid=c.oid
WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'auth_password_reset_%'
ORDER BY c.relname,pol.polname;
