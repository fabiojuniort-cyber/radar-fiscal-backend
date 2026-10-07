-- ACT-SCOPE-02 / D-070
-- Global PLATFORM_ADMIN role and controlled in-product administration.
-- The API runtime never receives direct write privileges on platform_user_roles.

ALTER TABLE platform_user_roles
    DROP CONSTRAINT IF EXISTS platform_user_roles_role_check;

ALTER TABLE platform_user_roles
    ADD CONSTRAINT platform_user_roles_role_check
    CHECK (role IN ('TAXONOMY_CURATOR', 'PLATFORM_ADMIN'));

CREATE OR REPLACE FUNCTION app_user_is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.platform_user_roles r
        JOIN public.app_users u
          ON u.id = r.user_id
        WHERE r.user_id = public.app_current_user_id()
          AND r.role = 'PLATFORM_ADMIN'
          AND r.revoked_at IS NULL
          AND u.status = 'ACTIVE'
    );
$$;

REVOKE ALL ON FUNCTION app_user_is_platform_admin()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_user_is_platform_admin()
TO radar_app;

DROP POLICY IF EXISTS platform_user_roles_app_select_own
ON platform_user_roles;

DROP POLICY IF EXISTS platform_user_roles_app_select
ON platform_user_roles;

CREATE POLICY platform_user_roles_app_select
ON platform_user_roles
FOR SELECT
TO radar_app
USING (
    user_id = app_current_user_id()
    OR app_user_is_platform_admin()
);

CREATE OR REPLACE FUNCTION platform_admin_grant_by_email(
    p_email TEXT
)
RETURNS TABLE (
    action TEXT,
    target_user_id UUID,
    target_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID;
    v_target public.app_users%ROWTYPE;
    v_existing UUID;
BEGIN
    v_actor := public.app_current_user_id();

    IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'platform_admin_required';
    END IF;

    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'platform_admin_email_required';
    END IF;

    SELECT u.*
      INTO v_target
      FROM public.app_users u
     WHERE lower(u.email) = lower(btrim(p_email));

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_not_found';
    END IF;

    IF v_target.status <> 'ACTIVE' THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_inactive';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('platform-admin-role', 0)
    );

    SELECT r.id
      INTO v_existing
      FROM public.platform_user_roles r
     WHERE r.user_id = v_target.id
       AND r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
     LIMIT 1;

    IF v_existing IS NOT NULL THEN
        RETURN QUERY
        SELECT 'ALREADY_GRANTED'::TEXT, v_target.id, v_target.email;
        RETURN;
    END IF;

    INSERT INTO public.platform_user_roles (
        user_id,
        role,
        granted_by
    ) VALUES (
        v_target.id,
        'PLATFORM_ADMIN',
        'app:' || v_actor::TEXT
    );

    INSERT INTO public.audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        after_data,
        correlation_id
    ) VALUES (
        NULL,
        'ADMIN',
        v_actor::TEXT,
        'PLATFORM_ROLE_GRANTED',
        'platform_user_role',
        v_target.id::TEXT,
        pg_catalog.jsonb_build_object('role', 'PLATFORM_ADMIN'),
        pg_catalog.gen_random_uuid()
    );

    RETURN QUERY
    SELECT 'GRANTED'::TEXT, v_target.id, v_target.email;
END;
$$;

CREATE OR REPLACE FUNCTION platform_admin_revoke_by_email(
    p_email TEXT
)
RETURNS TABLE (
    action TEXT,
    target_user_id UUID,
    target_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID;
    v_target public.app_users%ROWTYPE;
    v_existing UUID;
    v_active_admins BIGINT;
BEGIN
    v_actor := public.app_current_user_id();

    IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'platform_admin_required';
    END IF;

    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'platform_admin_email_required';
    END IF;

    SELECT u.*
      INTO v_target
      FROM public.app_users u
     WHERE lower(u.email) = lower(btrim(p_email));

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_not_found';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('platform-admin-role', 0)
    );

    SELECT r.id
      INTO v_existing
      FROM public.platform_user_roles r
     WHERE r.user_id = v_target.id
       AND r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
     LIMIT 1;

    IF v_existing IS NULL THEN
        RETURN QUERY
        SELECT 'NOT_GRANTED'::TEXT, v_target.id, v_target.email;
        RETURN;
    END IF;

    SELECT count(*)
      INTO v_active_admins
      FROM public.platform_user_roles r
      JOIN public.app_users u
        ON u.id = r.user_id
     WHERE r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
       AND u.status = 'ACTIVE';

    IF v_target.status = 'ACTIVE' AND v_active_admins <= 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'last_platform_admin';
    END IF;

    UPDATE public.platform_user_roles
       SET revoked_at = now(),
           revoked_by = 'app:' || v_actor::TEXT
     WHERE id = v_existing;

    INSERT INTO public.audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        correlation_id
    ) VALUES (
        NULL,
        'ADMIN',
        v_actor::TEXT,
        'PLATFORM_ROLE_REVOKED',
        'platform_user_role',
        v_target.id::TEXT,
        pg_catalog.jsonb_build_object('role', 'PLATFORM_ADMIN'),
        pg_catalog.gen_random_uuid()
    );

    RETURN QUERY
    SELECT 'REVOKED'::TEXT, v_target.id, v_target.email;
END;
$$;

REVOKE ALL ON FUNCTION platform_admin_grant_by_email(TEXT)
FROM PUBLIC;

REVOKE ALL ON FUNCTION platform_admin_revoke_by_email(TEXT)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION platform_admin_grant_by_email(TEXT)
TO radar_app;

GRANT EXECUTE ON FUNCTION platform_admin_revoke_by_email(TEXT)
TO radar_app;
