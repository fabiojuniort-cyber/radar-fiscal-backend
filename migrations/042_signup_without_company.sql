-- ONB-01: conta de usuario nao exige empresa no signup.
-- Preserva consentimento, tenants legados e a assinatura SQL do cadastro publico.
-- Execute via migrator transacional; nenhum dado existente e reescrito.
ALTER TABLE tenant_onboarding_profiles
    ALTER COLUMN company_name DROP NOT NULL;
ALTER TABLE tenant_onboarding_profiles
    DROP CONSTRAINT chk_tenant_onboarding_company_name;
ALTER TABLE tenant_onboarding_profiles
    ADD CONSTRAINT chk_tenant_onboarding_company_name
    CHECK (company_name IS NULL OR char_length(btrim(company_name)) BETWEEN 2 AND 200);

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
    v_company_name TEXT := NULLIF(btrim(p_company_name), '');
    v_cnpj TEXT := NULLIF(btrim(p_cnpj), '');
    v_consent_at TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF v_name IS NULL
       OR v_email IS NULL
       OR char_length(v_name) < 2
       OR char_length(v_name) > 160
       OR char_length(v_email) < 3
       OR char_length(v_email) > 320
       OR (v_company_name IS NOT NULL AND char_length(v_company_name) NOT BETWEEN 2 AND 200)
       OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$' THEN
        RAISE EXCEPTION 'invalid_public_signup_identity'
            USING ERRCODE = '22023';
    END IF;

    IF v_cnpj IS NOT NULL
       AND v_cnpj !~ '^[0-9]{14}$' THEN
        RAISE EXCEPTION 'invalid_public_signup_cnpj'
            USING ERRCODE = '22023';
    END IF;

    IF p_password_hash IS NULL
       OR p_password_hash NOT LIKE '$argon2id$%' THEN
        RAISE EXCEPTION 'invalid_public_signup_password_hash'
            USING ERRCODE = '22023';
    END IF;

    IF p_terms_accepted IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'public_signup_consent_required'
            USING ERRCODE = '22023';
    END IF;

    IF p_tenant_slug IS NULL
       OR p_tenant_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
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
        COALESCE(v_company_name, 'Conta de ' || v_name),
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
