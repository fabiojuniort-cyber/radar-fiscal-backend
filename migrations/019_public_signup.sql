CREATE TABLE tenant_onboarding_profiles (
    tenant_id UUID PRIMARY KEY
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    company_name TEXT NOT NULL,

    cnpj CHAR(14),

    terms_accepted_at TIMESTAMPTZ NOT NULL,
    privacy_policy_accepted_at TIMESTAMPTZ NOT NULL,
    consent_version TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_tenant_onboarding_company_name
        CHECK (
            char_length(btrim(company_name))
            BETWEEN 2 AND 200
        ),

    CONSTRAINT chk_tenant_onboarding_cnpj
        CHECK (
            cnpj IS NULL
            OR cnpj ~ '^[0-9]{14}$'
        ),

    CONSTRAINT chk_tenant_onboarding_consent_version
        CHECK (
            char_length(btrim(consent_version)) > 0
        )
);


CREATE TABLE public_signup_rate_limits (
    key_hash CHAR(64) PRIMARY KEY,

    window_started_at TIMESTAMPTZ NOT NULL,
    attempt_count INTEGER NOT NULL
        CHECK (attempt_count > 0),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_public_signup_rate_key
        CHECK (
            key_hash ~ '^[0-9a-f]{64}$'
        )
);


ALTER TABLE tenant_onboarding_profiles
ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_onboarding_profiles
FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_onboarding_profiles_select
ON tenant_onboarding_profiles
FOR SELECT
TO radar_app
USING (
    tenant_id = app_current_tenant_id()
    AND app_user_has_tenant_access(tenant_id)
);

GRANT SELECT
ON tenant_onboarding_profiles
TO radar_app;


CREATE OR REPLACE FUNCTION auth_public_signup_rate_limit(
    p_key_hash TEXT,
    p_window_seconds INTEGER,
    p_max_attempts INTEGER
)
RETURNS TABLE (
    allowed BOOLEAN,
    retry_after_seconds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_window_started_at TIMESTAMPTZ;
    v_attempt_count INTEGER;
BEGIN
    IF p_key_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid_rate_limit_key'
            USING ERRCODE = '22023';
    END IF;

    IF p_window_seconds < 60
       OR p_window_seconds > 86400
       OR p_max_attempts < 1
       OR p_max_attempts > 100 THEN
        RAISE EXCEPTION 'invalid_rate_limit_policy'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public_signup_rate_limits AS current_limit (
        key_hash,
        window_started_at,
        attempt_count,
        updated_at
    )
    VALUES (
        p_key_hash,
        v_now,
        1,
        v_now
    )
    ON CONFLICT (key_hash)
    DO UPDATE SET
        window_started_at = CASE
            WHEN current_limit.window_started_at
                 + make_interval(secs => p_window_seconds)
                 <= v_now
            THEN v_now
            ELSE current_limit.window_started_at
        END,
        attempt_count = CASE
            WHEN current_limit.window_started_at
                 + make_interval(secs => p_window_seconds)
                 <= v_now
            THEN 1
            ELSE current_limit.attempt_count + 1
        END,
        updated_at = v_now
    RETURNING
        current_limit.window_started_at,
        current_limit.attempt_count
    INTO
        v_window_started_at,
        v_attempt_count;

    allowed := v_attempt_count <= p_max_attempts;

    IF allowed THEN
        retry_after_seconds := 0;
    ELSE
        retry_after_seconds := GREATEST(
            1,
            CEIL(
                EXTRACT(
                    EPOCH FROM (
                        v_window_started_at
                        + make_interval(secs => p_window_seconds)
                        - v_now
                    )
                )
            )::INTEGER
        );
    END IF;

    RETURN NEXT;
END;
$$;

REVOKE ALL
ON FUNCTION auth_public_signup_rate_limit(
    TEXT,
    INTEGER,
    INTEGER
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION auth_public_signup_rate_limit(
    TEXT,
    INTEGER,
    INTEGER
)
TO radar_app;


CREATE OR REPLACE FUNCTION auth_public_signup_create_account(
    p_name TEXT,
    p_email TEXT,
    p_company_name TEXT,
    p_cnpj TEXT,
    p_password_hash TEXT,
    p_terms_accepted BOOLEAN,
    p_tenant_slug TEXT,
    p_consent_version TEXT
)
RETURNS TABLE (
    user_id UUID,
    tenant_id UUID,
    tenant_slug TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_id UUID;
    v_tenant_id UUID;
    v_email TEXT := lower(btrim(p_email));
    v_name TEXT := btrim(p_name);
    v_company_name TEXT := btrim(p_company_name);
    v_cnpj TEXT := NULLIF(btrim(p_cnpj), '');
    v_consent_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF char_length(v_name) < 2
       OR char_length(v_name) > 160
       OR char_length(v_email) < 3
       OR char_length(v_email) > 320
       OR char_length(v_company_name) < 2
       OR char_length(v_company_name) > 200
       OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
        RAISE EXCEPTION 'invalid_public_signup_identity'
            USING ERRCODE = '22023';
    END IF;

    IF v_cnpj IS NOT NULL
       AND v_cnpj !~ '^[0-9]{14}$' THEN
        RAISE EXCEPTION 'invalid_public_signup_cnpj'
            USING ERRCODE = '22023';
    END IF;

    IF p_password_hash !~ '^[$]argon2id[$]' THEN
        RAISE EXCEPTION 'invalid_public_signup_password_hash'
            USING ERRCODE = '22023';
    END IF;

    IF p_terms_accepted IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'public_signup_consent_required'
            USING ERRCODE = '22023';
    END IF;

    IF p_tenant_slug IS NULL
       OR p_tenant_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
       OR char_length(p_tenant_slug) > 120 THEN
        RAISE EXCEPTION 'invalid_public_signup_tenant_slug'
            USING ERRCODE = '22023';
    END IF;

    IF p_consent_version IS NULL
       OR char_length(btrim(p_consent_version)) = 0 THEN
        RAISE EXCEPTION 'invalid_public_signup_consent_version'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app_users (
        email,
        name,
        status
    )
    VALUES (
        v_email,
        v_name,
        'ACTIVE'
    )
    RETURNING id
    INTO v_user_id;

    INSERT INTO tenants (
        name,
        slug,
        status
    )
    VALUES (
        v_company_name,
        p_tenant_slug,
        'ACTIVE'
    )
    RETURNING id
    INTO v_tenant_id;

    INSERT INTO user_credentials (
        user_id,
        password_hash,
        password_algorithm
    )
    VALUES (
        v_user_id,
        p_password_hash,
        'argon2id'
    );

    INSERT INTO tenant_memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES (
        v_tenant_id,
        v_user_id,
        'OWNER'
    );

    INSERT INTO tenant_onboarding_profiles (
        tenant_id,
        company_name,
        cnpj,
        terms_accepted_at,
        privacy_policy_accepted_at,
        consent_version
    )
    VALUES (
        v_tenant_id,
        v_company_name,
        v_cnpj,
        v_consent_at,
        v_consent_at,
        btrim(p_consent_version)
    );

    user_id := v_user_id;
    tenant_id := v_tenant_id;
    tenant_slug := p_tenant_slug;

    RETURN NEXT;
END;
$$;

REVOKE ALL
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
TO radar_app;

       OR char_length(p_tenant_slug) > 120 THEN
        RAISE EXCEPTION 'invalid_public_signup_tenant_slug'
            USING ERRCODE = '22023';
    END IF;

    IF char_length(btrim(p_consent_version)) = 0 THEN
        RAISE EXCEPTION 'invalid_public_signup_consent_version'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app_users (
        email,
        name,
        status
    )
    VALUES (
        v_email,
        v_name,
        'ACTIVE'
    )
    RETURNING id
    INTO v_user_id;

    INSERT INTO tenants (
        name,
        slug,
        status
    )
    VALUES (
        v_company_name,
        p_tenant_slug,
        'ACTIVE'
    )
    RETURNING id
    INTO v_tenant_id;

    INSERT INTO user_credentials (
        user_id,
        password_hash,
        password_algorithm
    )
    VALUES (
        v_user_id,
        p_password_hash,
        'argon2id'
    );

    INSERT INTO tenant_memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES (
        v_tenant_id,
        v_user_id,
        'OWNER'
    );

    INSERT INTO tenant_onboarding_profiles (
        tenant_id,
        company_name,
        cnpj,
        terms_accepted_at,
        privacy_policy_accepted_at,
        consent_version
    )
    VALUES (
        v_tenant_id,
        v_company_name,
        v_cnpj,
        v_consent_at,
        v_consent_at,
        btrim(p_consent_version)
    );

    user_id := v_user_id;
    tenant_id := v_tenant_id;
    tenant_slug := p_tenant_slug;

    RETURN NEXT;
END;
$$;

REVOKE ALL
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
TO radar_app;
 THEN
        RAISE EXCEPTION 'invalid_public_signup_identity'
            USING ERRCODE = '22023';
    END IF;

    IF v_cnpj IS NOT NULL
       AND v_cnpj !~ '^[0-9]{14}$' THEN
        RAISE EXCEPTION 'invalid_public_signup_cnpj'
            USING ERRCODE = '22023';
    END IF;

    IF p_password_hash !~ '^[$]argon2id[$]' THEN
        RAISE EXCEPTION 'invalid_public_signup_password_hash'
            USING ERRCODE = '22023';
    END IF;

    IF p_terms_accepted IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'public_signup_consent_required'
            USING ERRCODE = '22023';
    END IF;

    IF p_tenant_slug IS NULL
       OR p_tenant_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*
        RAISE EXCEPTION 'invalid_public_signup_tenant_slug'
            USING ERRCODE = '22023';
    END IF;

    IF p_consent_version IS NULL
       OR char_length(btrim(p_consent_version)) = 0 THEN
        RAISE EXCEPTION 'invalid_public_signup_consent_version'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app_users (
        email,
        name,
        status
    )
    VALUES (
        v_email,
        v_name,
        'ACTIVE'
    )
    RETURNING id
    INTO v_user_id;

    INSERT INTO tenants (
        name,
        slug,
        status
    )
    VALUES (
        v_company_name,
        p_tenant_slug,
        'ACTIVE'
    )
    RETURNING id
    INTO v_tenant_id;

    INSERT INTO user_credentials (
        user_id,
        password_hash,
        password_algorithm
    )
    VALUES (
        v_user_id,
        p_password_hash,
        'argon2id'
    );

    INSERT INTO tenant_memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES (
        v_tenant_id,
        v_user_id,
        'OWNER'
    );

    INSERT INTO tenant_onboarding_profiles (
        tenant_id,
        company_name,
        cnpj,
        terms_accepted_at,
        privacy_policy_accepted_at,
        consent_version
    )
    VALUES (
        v_tenant_id,
        v_company_name,
        v_cnpj,
        v_consent_at,
        v_consent_at,
        btrim(p_consent_version)
    );

    user_id := v_user_id;
    tenant_id := v_tenant_id;
    tenant_slug := p_tenant_slug;

    RETURN NEXT;
END;
$$;

REVOKE ALL
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
TO radar_app;

       OR char_length(p_tenant_slug) > 120 THEN
        RAISE EXCEPTION 'invalid_public_signup_tenant_slug'
            USING ERRCODE = '22023';
    END IF;

    IF char_length(btrim(p_consent_version)) = 0 THEN
        RAISE EXCEPTION 'invalid_public_signup_consent_version'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO app_users (
        email,
        name,
        status
    )
    VALUES (
        v_email,
        v_name,
        'ACTIVE'
    )
    RETURNING id
    INTO v_user_id;

    INSERT INTO tenants (
        name,
        slug,
        status
    )
    VALUES (
        v_company_name,
        p_tenant_slug,
        'ACTIVE'
    )
    RETURNING id
    INTO v_tenant_id;

    INSERT INTO user_credentials (
        user_id,
        password_hash,
        password_algorithm
    )
    VALUES (
        v_user_id,
        p_password_hash,
        'argon2id'
    );

    INSERT INTO tenant_memberships (
        tenant_id,
        user_id,
        role
    )
    VALUES (
        v_tenant_id,
        v_user_id,
        'OWNER'
    );

    INSERT INTO tenant_onboarding_profiles (
        tenant_id,
        company_name,
        cnpj,
        terms_accepted_at,
        privacy_policy_accepted_at,
        consent_version
    )
    VALUES (
        v_tenant_id,
        v_company_name,
        v_cnpj,
        v_consent_at,
        v_consent_at,
        btrim(p_consent_version)
    );

    user_id := v_user_id;
    tenant_id := v_tenant_id;
    tenant_slug := p_tenant_slug;

    RETURN NEXT;
END;
$$;

REVOKE ALL
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION auth_public_signup_create_account(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
TO radar_app;
