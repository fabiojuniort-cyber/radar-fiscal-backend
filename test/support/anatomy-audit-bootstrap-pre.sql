-- Disposable CI only (ANAT-ADMIN-01 / P3-B1). Minimal prerequisites of the vendored audit chain; not a migration.
DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_user<>'postgres'
 OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 OR inet_server_port() IS DISTINCT FROM 5432 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;
-- Roles as in 009/018 (NOLOGIN, no elevated attributes).
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['radar_app','radar_worker','radar_taxonomy_curator'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
  END IF;
 END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO radar_app, radar_worker, radar_taxonomy_curator;
-- 001 (reduced): only the key referenced by audit_log.tenant_id.
CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
-- 009: session helpers, verbatim bodies.
CREATE FUNCTION app_current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.user_id', true), '')::uuid; $$;
CREATE FUNCTION app_current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid; $$;
-- 009 reads tenant_memberships/app_users, absent here: fail-closed stub (no tenant access). ANAT events are global
-- (tenant_id NULL), so they never depend on it.
CREATE FUNCTION app_user_has_tenant_access(p_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE
 SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT false; $$;
GRANT EXECUTE ON FUNCTION app_current_user_id(), app_current_tenant_id() TO radar_app, radar_worker;
GRANT EXECUTE ON FUNCTION app_user_has_tenant_access(uuid) TO radar_app;
