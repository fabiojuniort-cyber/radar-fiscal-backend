-- AUTH-RESET-01 (#9): tokens opacos de uso unico, sem acesso direto pelo runtime.
-- Dados existentes nao sao alterados. Aplicacao apenas em ambiente isolado ate gate R3.
CREATE TABLE auth_password_reset_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    CONSTRAINT chk_auth_password_reset_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_auth_password_reset_expiry CHECK (expires_at > created_at)
);

CREATE INDEX ix_auth_password_reset_user_active
ON auth_password_reset_tokens (user_id, expires_at DESC)
WHERE used_at IS NULL;

REVOKE ALL ON auth_password_reset_tokens FROM PUBLIC;
REVOKE ALL ON auth_password_reset_tokens FROM radar_app;
REVOKE ALL ON auth_password_reset_tokens FROM radar_worker;

-- Chamado somente apos o limite de tentativas verificado no app.
-- O runtime nao pode descobrir identidade por consultas diretas a tabela de tokens.
CREATE FUNCTION auth_password_reset_issue(
    p_email TEXT,
    p_token_hash TEXT,
    p_ttl_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_id UUID;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_email IS NULL OR char_length(p_email) > 320
       OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
       OR p_ttl_seconds NOT BETWEEN 60 AND 3600 THEN
        RAISE EXCEPTION 'invalid_password_reset_request' USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_user_id
      FROM app_users
     WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE'
     FOR UPDATE;

    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- A ultima solicitacao prevalece. Links anteriores nao continuam ativos.
    UPDATE auth_password_reset_tokens
       SET used_at = v_now
     WHERE user_id = v_user_id AND used_at IS NULL;

    INSERT INTO auth_password_reset_tokens (token_hash, user_id, created_at, expires_at)
    VALUES (
        p_token_hash, v_user_id, v_now,
        v_now + make_interval(secs => p_ttl_seconds)
    );
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION auth_password_reset_issue(TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_password_reset_issue(TEXT, TEXT, INTEGER) TO radar_app;

-- Uma transacao indivisivel protege contra reuso/concorrrencia:
-- senha, todos os tokens pendentes e todas as sessoes/refresh do usuario.
CREATE FUNCTION auth_password_reset_redeem(
    p_token_hash TEXT,
    p_password_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_id UUID;
    v_expiry TIMESTAMPTZ;
    v_used_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
       OR p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
        RETURN FALSE;
    END IF;

    -- Serializa tokens concorrentes do mesmo usuario antes de bloquear o token.
    SELECT u.id INTO v_user_id
      FROM auth_password_reset_tokens r
      JOIN app_users u ON u.id = r.user_id
     WHERE r.token_hash = p_token_hash AND u.status = 'ACTIVE'
     FOR UPDATE OF u;

    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT expires_at, used_at INTO v_expiry, v_used_at
      FROM auth_password_reset_tokens
     WHERE token_hash = p_token_hash AND user_id = v_user_id
     FOR UPDATE;

    IF NOT FOUND OR v_used_at IS NOT NULL OR v_expiry <= v_now THEN
        RETURN FALSE;
    END IF;

    UPDATE user_credentials
       SET password_hash = p_password_hash, password_algorithm = 'argon2id',
           password_updated_at = v_now, failed_login_attempts = 0,
           locked_until = NULL
     WHERE user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'password_reset_credentials_missing';
    END IF;

    UPDATE auth_refresh_tokens
       SET revoked_at = v_now
     WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = v_user_id)
       AND revoked_at IS NULL;

    UPDATE auth_sessions
       SET revoked_at = v_now, revoke_reason = 'PASSWORD_RESET'
     WHERE user_id = v_user_id AND revoked_at IS NULL;

    UPDATE auth_password_reset_tokens
       SET used_at = v_now
     WHERE user_id = v_user_id AND used_at IS NULL;

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION auth_password_reset_redeem(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_password_reset_redeem(TEXT, TEXT) TO radar_app;
