-- Disposable CI only (ANAT-ADMIN-01 / P3-B1). audit_log grants and RLS policies copied from 009 and 018 (main).
DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;
REVOKE ALL ON audit_log FROM PUBLIC;
GRANT SELECT, INSERT ON audit_log TO radar_app;
GRANT SELECT, INSERT ON audit_log TO radar_worker;
GRANT SELECT, INSERT ON audit_log TO radar_taxonomy_curator;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_app_select ON audit_log FOR SELECT TO radar_app
 USING (tenant_id = app_current_tenant_id() AND app_user_has_tenant_access(tenant_id));
CREATE POLICY audit_log_app_insert ON audit_log FOR INSERT TO radar_app
 WITH CHECK (tenant_id = app_current_tenant_id() AND app_user_has_tenant_access(tenant_id));
CREATE POLICY audit_log_worker_select ON audit_log FOR SELECT TO radar_worker
 USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id());
CREATE POLICY audit_log_worker_insert ON audit_log FOR INSERT TO radar_worker
 WITH CHECK (actor_type IN ('WORKER', 'SYSTEM') AND (tenant_id IS NULL OR tenant_id = app_current_tenant_id()));
CREATE POLICY audit_log_taxonomy_curator_select ON audit_log FOR SELECT TO radar_taxonomy_curator USING (tenant_id IS NULL);
CREATE POLICY audit_log_taxonomy_curator_insert ON audit_log FOR INSERT TO radar_taxonomy_curator
 WITH CHECK (tenant_id IS NULL AND actor_type IN ('ADMIN', 'SYSTEM'));
