-- Disposable CI only (ANAT-ADMIN-01 / P3-D). Minimal authentication tables and grants of main, so the HTTP tests use
-- the real JWT + session check (auth.plugin / validateSession) and the real platform-admin read (platform-role).
DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;
-- 008 (reduced to the columns validateSession reads, plus its expiry checks).
CREATE TABLE auth_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL, revoked_at timestamptz, revoke_reason text,
 CHECK (idle_expires_at <= absolute_expires_at));
REVOKE ALL ON auth_sessions FROM PUBLIC;
-- 009: runtime grants on the identity tables.
GRANT SELECT, INSERT, UPDATE ON app_users TO radar_app;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO radar_app;
-- 031/036: platform_user_roles readable by radar_app under RLS (own rows, or every row for an admin).
ALTER TABLE platform_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_user_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_user_roles FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT SELECT ON platform_user_roles TO radar_app;
CREATE POLICY platform_user_roles_app_select ON platform_user_roles FOR SELECT TO radar_app
 USING (user_id = app_current_user_id() OR app_user_is_platform_admin());
