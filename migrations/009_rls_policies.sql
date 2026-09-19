DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'radar_app'
    ) THEN
        CREATE ROLE radar_app
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'radar_worker'
    ) THEN
        CREATE ROLE radar_worker
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOBYPASSRLS;
    END IF;
END;
$$;

ALTER ROLE radar_app
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

ALTER ROLE radar_worker
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO radar_app, radar_worker',
        current_database()
    );
END;
$$;

REVOKE CREATE ON SCHEMA public
FROM PUBLIC;

GRANT USAGE ON SCHEMA public
TO radar_app, radar_worker;


CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(
        current_setting('app.user_id', true),
        ''
    )::uuid;
$$;


CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(
        current_setting('app.tenant_id', true),
        ''
    )::uuid;
$$;


CREATE OR REPLACE FUNCTION app_user_has_tenant_access(
    p_tenant_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tenant_memberships tm
        JOIN app_users u
          ON u.id = tm.user_id
        JOIN tenants t
          ON t.id = tm.tenant_id
        WHERE tm.tenant_id = p_tenant_id
          AND tm.user_id = app_current_user_id()
          AND u.status = 'ACTIVE'
          AND t.status = 'ACTIVE'
    );
$$;


CREATE OR REPLACE FUNCTION app_user_is_tenant_admin(
    p_tenant_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tenant_memberships tm
        JOIN app_users u
          ON u.id = tm.user_id
        JOIN tenants t
          ON t.id = tm.tenant_id
        WHERE tm.tenant_id = p_tenant_id
          AND tm.user_id = app_current_user_id()
          AND tm.role IN ('OWNER', 'ADMIN')
          AND u.status = 'ACTIVE'
          AND t.status = 'ACTIVE'
    );
$$;


CREATE OR REPLACE FUNCTION app_company_is_in_current_tenant(
    p_company_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM companies c
        WHERE c.id = p_company_id
          AND c.tenant_id = app_current_tenant_id()
    );
$$;


CREATE OR REPLACE FUNCTION app_establishment_is_in_current_tenant(
    p_establishment_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM establishments e
        JOIN companies c
          ON c.id = e.company_id
        WHERE e.id = p_establishment_id
          AND c.tenant_id = app_current_tenant_id()
    );
$$;


CREATE OR REPLACE FUNCTION app_company_publication_is_in_current_tenant(
    p_company_publication_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM company_publications cp
        JOIN companies c
          ON c.id = cp.company_id
        WHERE cp.id = p_company_publication_id
          AND c.tenant_id = app_current_tenant_id()
    );
$$;


REVOKE ALL ON FUNCTION app_current_user_id()
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_current_tenant_id()
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_user_has_tenant_access(UUID)
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_user_is_tenant_admin(UUID)
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_company_is_in_current_tenant(UUID)
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_establishment_is_in_current_tenant(UUID)
FROM PUBLIC;

REVOKE ALL ON FUNCTION app_company_publication_is_in_current_tenant(UUID)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_current_user_id()
TO radar_app, radar_worker;

GRANT EXECUTE ON FUNCTION app_current_tenant_id()
TO radar_app, radar_worker;

GRANT EXECUTE ON FUNCTION app_user_has_tenant_access(UUID)
TO radar_app;

GRANT EXECUTE ON FUNCTION app_user_is_tenant_admin(UUID)
TO radar_app;

GRANT EXECUTE ON FUNCTION app_company_is_in_current_tenant(UUID)
TO radar_app, radar_worker;

GRANT EXECUTE ON FUNCTION app_establishment_is_in_current_tenant(UUID)
TO radar_app, radar_worker;

GRANT EXECUTE ON FUNCTION app_company_publication_is_in_current_tenant(UUID)
TO radar_app, radar_worker;


REVOKE ALL ON ALL TABLES IN SCHEMA public
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
ON app_users
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON user_credentials
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON auth_sessions
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON auth_refresh_tokens
TO radar_app;

GRANT SELECT, UPDATE
ON tenants
TO radar_app;

GRANT SELECT, INSERT, UPDATE, DELETE
ON tenant_memberships
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON companies
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON company_tax_profiles
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON establishments
TO radar_app;

GRANT SELECT, INSERT, UPDATE, DELETE
ON company_cnaes
TO radar_app;

GRANT SELECT, INSERT, UPDATE, DELETE
ON establishment_cnaes
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON monitoring_profiles
TO radar_app;

GRANT SELECT, INSERT, UPDATE
ON company_publications
TO radar_app;

GRANT SELECT, INSERT
ON publication_matches
TO radar_app;

GRANT SELECT, INSERT
ON audit_log
TO radar_app;

GRANT SELECT
ON cnaes,
   establishment_types,
   sources,
   collection_runs,
   collection_attempts,
   collection_items,
   collection_run_publications,
   publications,
   publication_origins,
   publication_versions,
   publication_files,
   v_source_monitoring
TO radar_app;


GRANT SELECT
ON cnaes,
   establishment_types,
   sources,
   companies,
   company_tax_profiles,
   establishments,
   company_cnaes,
   establishment_cnaes,
   monitoring_profiles,
   company_publications,
   publication_matches,
   publications,
   publication_origins,
   publication_versions,
   publication_files,
   v_source_monitoring
TO radar_worker;

GRANT SELECT, INSERT, UPDATE
ON collection_runs,
   collection_attempts,
   collection_items,
   collection_run_publications,
   publications,
   publication_origins,
   publication_versions,
   publication_files
TO radar_worker;

GRANT SELECT, INSERT, UPDATE
ON company_publications
TO radar_worker;

GRANT SELECT, INSERT
ON publication_matches,
   audit_log
TO radar_worker;


ALTER TABLE tenants
ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants
FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_select
ON tenants
FOR SELECT
TO radar_app
USING (
    app_user_has_tenant_access(id)
);

CREATE POLICY tenants_update
ON tenants
FOR UPDATE
TO radar_app
USING (
    id = app_current_tenant_id()
    AND app_user_is_tenant_admin(id)
)
WITH CHECK (
    id = app_current_tenant_id()
    AND app_user_is_tenant_admin(id)
);


ALTER TABLE tenant_memberships
ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_memberships
FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_memberships_select
ON tenant_memberships
FOR SELECT
TO radar_app
USING (
    user_id = app_current_user_id()
    OR (
        tenant_id = app_current_tenant_id()
        AND app_user_is_tenant_admin(tenant_id)
    )
);

CREATE POLICY tenant_memberships_insert
ON tenant_memberships
FOR INSERT
TO radar_app
WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_user_is_tenant_admin(tenant_id)
);

CREATE POLICY tenant_memberships_update
ON tenant_memberships
FOR UPDATE
TO radar_app
USING (
    tenant_id = app_current_tenant_id()
    AND app_user_is_tenant_admin(tenant_id)
)
WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_user_is_tenant_admin(tenant_id)
);

CREATE POLICY tenant_memberships_delete
ON tenant_memberships
FOR DELETE
TO radar_app
USING (
    tenant_id = app_current_tenant_id()
    AND app_user_is_tenant_admin(tenant_id)
);


ALTER TABLE companies
ENABLE ROW LEVEL SECURITY;

ALTER TABLE companies
FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_app
ON companies
FOR ALL
TO radar_app
USING (
    tenant_id = app_current_tenant_id()
    AND app_user_has_tenant_access(tenant_id)
)
WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_user_has_tenant_access(tenant_id)
);

CREATE POLICY companies_worker_select
ON companies
FOR SELECT
TO radar_worker
USING (
    tenant_id = app_current_tenant_id()
);


ALTER TABLE company_tax_profiles
ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_tax_profiles
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_tax_profiles_app
ON company_tax_profiles
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY company_tax_profiles_worker_select
ON company_tax_profiles
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);


ALTER TABLE establishments
ENABLE ROW LEVEL SECURITY;

ALTER TABLE establishments
FORCE ROW LEVEL SECURITY;

CREATE POLICY establishments_app
ON establishments
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY establishments_worker_select
ON establishments
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);


ALTER TABLE company_cnaes
ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_cnaes
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_cnaes_app
ON company_cnaes
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY company_cnaes_worker_select
ON company_cnaes
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);


ALTER TABLE establishment_cnaes
ENABLE ROW LEVEL SECURITY;

ALTER TABLE establishment_cnaes
FORCE ROW LEVEL SECURITY;

CREATE POLICY establishment_cnaes_app
ON establishment_cnaes
FOR ALL
TO radar_app
USING (
    app_establishment_is_in_current_tenant(
        establishment_id
    )
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_establishment_is_in_current_tenant(
        establishment_id
    )
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY establishment_cnaes_worker_select
ON establishment_cnaes
FOR SELECT
TO radar_worker
USING (
    app_establishment_is_in_current_tenant(
        establishment_id
    )
);


ALTER TABLE monitoring_profiles
ENABLE ROW LEVEL SECURITY;

ALTER TABLE monitoring_profiles
FORCE ROW LEVEL SECURITY;

CREATE POLICY monitoring_profiles_app
ON monitoring_profiles
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY monitoring_profiles_worker_select
ON monitoring_profiles
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);


ALTER TABLE company_publications
ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_publications
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_publications_app
ON company_publications
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY company_publications_worker
ON company_publications
FOR ALL
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
);


ALTER TABLE publication_matches
ENABLE ROW LEVEL SECURITY;

ALTER TABLE publication_matches
FORCE ROW LEVEL SECURITY;

CREATE POLICY publication_matches_app
ON publication_matches
FOR SELECT
TO radar_app
USING (
    app_company_publication_is_in_current_tenant(
        company_publication_id
    )
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY publication_matches_app_insert
ON publication_matches
FOR INSERT
TO radar_app
WITH CHECK (
    app_company_publication_is_in_current_tenant(
        company_publication_id
    )
    AND app_user_has_tenant_access(
        app_current_tenant_id()
    )
);

CREATE POLICY publication_matches_worker
ON publication_matches
FOR SELECT
TO radar_worker
USING (
    app_company_publication_is_in_current_tenant(
        company_publication_id
    )
);

CREATE POLICY publication_matches_worker_insert
ON publication_matches
FOR INSERT
TO radar_worker
WITH CHECK (
    app_company_publication_is_in_current_tenant(
        company_publication_id
    )
);


ALTER TABLE audit_log
ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_log
FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_app_select
ON audit_log
FOR SELECT
TO radar_app
USING (
    tenant_id = app_current_tenant_id()
    AND app_user_has_tenant_access(tenant_id)
);

CREATE POLICY audit_log_app_insert
ON audit_log
FOR INSERT
TO radar_app
WITH CHECK (
    tenant_id = app_current_tenant_id()
    AND app_user_has_tenant_access(tenant_id)
);

CREATE POLICY audit_log_worker_select
ON audit_log
FOR SELECT
TO radar_worker
USING (
    tenant_id IS NULL
    OR tenant_id = app_current_tenant_id()
);

CREATE POLICY audit_log_worker_insert
ON audit_log
FOR INSERT
TO radar_worker
WITH CHECK (
    actor_type IN ('WORKER', 'SYSTEM')
    AND (
        tenant_id IS NULL
        OR tenant_id = app_current_tenant_id()
    )
);
