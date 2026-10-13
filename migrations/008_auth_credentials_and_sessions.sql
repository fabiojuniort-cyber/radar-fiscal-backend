CREATE TABLE user_credentials (
    user_id UUID PRIMARY KEY
        REFERENCES app_users(id)
        ON DELETE CASCADE,

    password_hash TEXT NOT NULL,

    password_algorithm TEXT NOT NULL
        DEFAULT 'argon2id'
        CHECK (
            password_algorithm IN (
                'argon2id'
            )
        ),

    password_updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    failed_login_attempts INTEGER NOT NULL
        DEFAULT 0
        CHECK (
            failed_login_attempts >= 0
        ),

    locked_until TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now()
);

CREATE TRIGGER trg_user_credentials_updated_at
BEFORE UPDATE ON user_credentials
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES app_users(id)
        ON DELETE CASCADE,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    last_seen_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    idle_expires_at TIMESTAMPTZ NOT NULL,

    absolute_expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,

    revoke_reason TEXT,

    ip_address INET,

    user_agent TEXT,

    metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    CONSTRAINT chk_auth_session_metadata
        CHECK (
            jsonb_typeof(metadata)
            = 'object'
        ),

    CONSTRAINT chk_auth_session_expiry
        CHECK (
            idle_expires_at <= absolute_expires_at
        ),

    CONSTRAINT chk_auth_session_revoke_date
        CHECK (
            revoked_at IS NULL
            OR revoked_at >= created_at
        )
);

CREATE INDEX ix_auth_sessions_user_active
ON auth_sessions(
    user_id,
    absolute_expires_at DESC
)
WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_sessions_expiry
ON auth_sessions(
    idle_expires_at,
    absolute_expires_at
)
WHERE revoked_at IS NULL;


CREATE TABLE auth_refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    session_id UUID NOT NULL
        REFERENCES auth_sessions(id)
        ON DELETE CASCADE,

    family_id UUID NOT NULL,

    token_hash CHAR(64) NOT NULL,

    parent_token_id UUID
        REFERENCES auth_refresh_tokens(id)
        ON DELETE SET NULL,

    replaced_by_token_id UUID
        REFERENCES auth_refresh_tokens(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    expires_at TIMESTAMPTZ NOT NULL,

    used_at TIMESTAMPTZ,

    revoked_at TIMESTAMPTZ,

    reuse_detected_at TIMESTAMPTZ,

    metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    CONSTRAINT uq_auth_refresh_token_hash
        UNIQUE(token_hash),

    CONSTRAINT chk_auth_refresh_token_metadata
        CHECK (
            jsonb_typeof(metadata)
            = 'object'
        ),

    CONSTRAINT chk_auth_refresh_token_expiry
        CHECK (
            expires_at > created_at
        ),

    CONSTRAINT chk_auth_refresh_token_used
        CHECK (
            used_at IS NULL
            OR used_at >= created_at
        ),

    CONSTRAINT chk_auth_refresh_token_revoked
        CHECK (
            revoked_at IS NULL
            OR revoked_at >= created_at
        ),

    CONSTRAINT chk_auth_refresh_token_reuse
        CHECK (
            reuse_detected_at IS NULL
            OR reuse_detected_at >= created_at
        )
);

CREATE INDEX ix_auth_refresh_tokens_session
ON auth_refresh_tokens(
    session_id,
    created_at DESC
);

CREATE INDEX ix_auth_refresh_tokens_family
ON auth_refresh_tokens(
    family_id,
    created_at DESC
);

CREATE INDEX ix_auth_refresh_tokens_active_expiry
ON auth_refresh_tokens(expires_at)
WHERE
    revoked_at IS NULL
    AND used_at IS NULL;
