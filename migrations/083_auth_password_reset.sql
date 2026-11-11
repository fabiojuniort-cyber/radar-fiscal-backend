-- AUTH-RESET-02 (#9): token opaco + outbox transacional e funcoes restritas ao runtime.
-- Dados existentes nao sao alterados. Aplicacao apenas em ambiente isolado ate gate R3.
CREATE TABLE public.auth_password_reset_tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    CONSTRAINT chk_auth_password_reset_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_auth_password_reset_expiry CHECK (expires_at > created_at)
);

CREATE INDEX ix_auth_password_reset_user_active
ON public.auth_password_reset_tokens (user_id, expires_at DESC)
WHERE used_at IS NULL;

REVOKE ALL ON auth_password_reset_tokens FROM PUBLIC;
REVOKE ALL ON auth_password_reset_tokens FROM radar_app;
REVOKE ALL ON auth_password_reset_tokens FROM radar_worker;

-- Outbox duravel: nenhuma coluna guarda token ou link em claro.
CREATE TABLE public.auth_password_reset_outbox (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    token_hash CHAR(64) NOT NULL UNIQUE
        REFERENCES public.auth_password_reset_tokens(token_hash) ON DELETE CASCADE,
    encrypted_token TEXT,
    nonce TEXT,
    auth_tag TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','CLAIMED','ACCEPTED','FAILED','EXPIRED','CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    claimed_until TIMESTAMPTZ,
    claim_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    error_code TEXT,
    CONSTRAINT chk_password_reset_payload CHECK (
        (status IN ('PENDING','CLAIMED') AND encrypted_token IS NOT NULL
          AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
        OR (status NOT IN ('PENDING','CLAIMED') AND encrypted_token IS NULL
          AND nonce IS NULL AND auth_tag IS NULL)
    )
);

CREATE INDEX ix_auth_password_reset_outbox_ready
ON public.auth_password_reset_outbox (available_at, created_at)
WHERE status IN ('PENDING','CLAIMED');

REVOKE ALL ON public.auth_password_reset_outbox FROM PUBLIC;
REVOKE ALL ON public.auth_password_reset_outbox FROM radar_app;
REVOKE ALL ON public.auth_password_reset_outbox FROM radar_worker;

-- Chamado somente apos o limite de tentativas verificado no app.
-- O runtime nao pode descobrir identidade por consultas diretas a tabela de tokens.
CREATE FUNCTION auth_password_reset_issue(
    p_email TEXT,
    p_token_hash TEXT,
    p_ttl_seconds INTEGER,
    p_encrypted_token TEXT,
    p_nonce TEXT,
    p_auth_tag TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_user_id UUID;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_email IS NULL OR char_length(p_email) > 320
       OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
       OR p_ttl_seconds NOT BETWEEN 60 AND 3600
       OR p_encrypted_token IS NULL OR char_length(p_encrypted_token) NOT BETWEEN 32 AND 256
       OR p_nonce IS NULL OR char_length(p_nonce) NOT BETWEEN 12 AND 32
       OR p_auth_tag IS NULL OR char_length(p_auth_tag) NOT BETWEEN 20 AND 48 THEN
        RAISE EXCEPTION 'invalid_password_reset_request' USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_user_id
      FROM public.app_users
     WHERE lower(email) = lower(btrim(p_email)) AND status = 'ACTIVE'
     FOR UPDATE;

    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    -- A ultima solicitacao prevalece. Links anteriores nao continuam ativos.
    UPDATE public.auth_password_reset_outbox AS o
       SET status = 'CANCELLED', encrypted_token = NULL,
           nonce = NULL, auth_tag = NULL, updated_at = v_now,
           error_code = 'SUPERSEDED'
      FROM public.auth_password_reset_tokens AS t
     WHERE o.token_hash = t.token_hash AND t.user_id = v_user_id
       AND o.status IN ('PENDING','CLAIMED');

    UPDATE public.auth_password_reset_tokens
       SET used_at = v_now
     WHERE user_id = v_user_id AND used_at IS NULL;

    INSERT INTO public.auth_password_reset_tokens (token_hash, user_id, created_at, expires_at)
    VALUES (p_token_hash, v_user_id, v_now,
            v_now + make_interval(secs => p_ttl_seconds));

    INSERT INTO public.auth_password_reset_outbox (
        token_hash, encrypted_token, nonce, auth_tag, available_at
    ) VALUES (p_token_hash, p_encrypted_token, p_nonce, p_auth_tag, v_now);
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION auth_password_reset_issue(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_password_reset_issue(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO radar_app;

-- Consulta barata antes do Argon2; o redeem revalida sob lock.
CREATE FUNCTION auth_password_reset_token_active(p_token_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_active BOOLEAN;
BEGIN
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN FALSE;
    END IF;
    SELECT EXISTS (
        SELECT 1
          FROM public.auth_password_reset_tokens r
          JOIN public.app_users u ON u.id = r.user_id
         WHERE r.token_hash = p_token_hash
           AND r.used_at IS NULL
           AND r.expires_at > clock_timestamp()
           AND u.status = 'ACTIVE'
    ) INTO v_active;
    RETURN v_active;
END;
$$;

REVOKE ALL ON FUNCTION auth_password_reset_token_active(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_password_reset_token_active(TEXT) TO radar_app;

-- Uma transacao indivisivel protege contra reuso/concorrrencia:
-- senha, todos os tokens pendentes e todas as sessoes/refresh do usuario.
CREATE FUNCTION auth_password_reset_redeem(
    p_token_hash TEXT,
    p_password_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
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
      FROM public.auth_password_reset_tokens r
      JOIN public.app_users u ON u.id = r.user_id
     WHERE r.token_hash = p_token_hash AND u.status = 'ACTIVE'
     FOR UPDATE OF u;

    IF v_user_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT expires_at, used_at INTO v_expiry, v_used_at
      FROM public.auth_password_reset_tokens
     WHERE token_hash = p_token_hash AND user_id = v_user_id
     FOR UPDATE;

    -- Reavaliar relogio depois de esperar por locks concorrentes.
    v_now := clock_timestamp();

    IF NOT FOUND OR v_used_at IS NOT NULL OR v_expiry <= v_now THEN
        RETURN FALSE;
    END IF;

    UPDATE public.user_credentials
       SET password_hash = p_password_hash, password_algorithm = 'argon2id',
           password_updated_at = v_now, failed_login_attempts = 0,
           locked_until = NULL
     WHERE user_id = v_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'password_reset_credentials_missing';
    END IF;

    UPDATE public.auth_refresh_tokens
       SET revoked_at = v_now
     WHERE session_id IN (SELECT id FROM public.auth_sessions WHERE user_id = v_user_id)
       AND revoked_at IS NULL;

    UPDATE public.auth_sessions
       SET revoked_at = v_now, revoke_reason = 'PASSWORD_RESET'
     WHERE user_id = v_user_id AND revoked_at IS NULL;

    UPDATE public.auth_password_reset_tokens
       SET used_at = v_now
     WHERE user_id = v_user_id AND used_at IS NULL;

    RETURN TRUE;
END;
$$;


-- O worker tem apenas EXECUTE nestas funcoes; nunca SELECT direto na outbox.
CREATE FUNCTION public.auth_password_reset_reap()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.auth_password_reset_outbox o
     SET status='EXPIRED', encrypted_token=NULL, nonce=NULL, auth_tag=NULL,
         updated_at=clock_timestamp(), error_code='EXPIRED'
    FROM public.auth_password_reset_tokens t
   WHERE o.token_hash=t.token_hash AND o.status IN ('PENDING','CLAIMED')
     AND (t.used_at IS NOT NULL OR t.expires_at<=clock_timestamp());
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Um worker morto na terceira tentativa nao deixa claim abandonado.
  -- Falha terminal invalida EXCLUSIVAMENTE o digest deste job.
  UPDATE public.auth_password_reset_tokens t
     SET used_at=clock_timestamp()
   WHERE t.token_hash IN (
       SELECT o.token_hash FROM public.auth_password_reset_outbox o
        WHERE o.status='CLAIMED' AND o.attempt_count>=3
          AND o.claimed_until<clock_timestamp()
   ) AND t.used_at IS NULL;

  UPDATE public.auth_password_reset_outbox o
     SET status='FAILED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
         claimed_until=NULL,claim_id=NULL,updated_at=clock_timestamp(),
         error_code='LEASE_EXHAUSTED'
   WHERE o.status='CLAIMED' AND o.attempt_count>=3
     AND o.claimed_until<clock_timestamp();
  RETURN v_count;
END; $;
REVOKE ALL ON FUNCTION public.auth_password_reset_reap() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_reap() TO radar_worker;

CREATE FUNCTION public.auth_password_reset_claim(p_lease_seconds INTEGER)
RETURNS TABLE (
  job_id UUID, lease_id UUID, digest TEXT,
  ciphertext TEXT, iv TEXT, mac TEXT, recipient TEXT
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_job UUID;
BEGIN
  IF p_lease_seconds NOT BETWEEN 6 AND 60 THEN
    RAISE EXCEPTION 'invalid_reset_lease' USING ERRCODE='22023';
  END IF;

  SELECT o.id INTO v_job FROM public.auth_password_reset_outbox o
    JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
   WHERE ((o.status='PENDING' AND o.available_at<=clock_timestamp())
      OR (o.status='CLAIMED' AND o.claimed_until<clock_timestamp()))
     AND o.attempt_count<3 AND t.used_at IS NULL
     AND t.expires_at>clock_timestamp()
   ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
    WITH updated AS (
      UPDATE public.auth_password_reset_outbox o
         SET status='CLAIMED', claim_id=pg_catalog.gen_random_uuid(),
             claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
             attempt_count=o.attempt_count+1, updated_at=clock_timestamp()
       WHERE o.id=v_job
       RETURNING o.id,o.claim_id,o.token_hash,o.encrypted_token,o.nonce,o.auth_tag
    )
    SELECT u.id, u.claim_id, u.token_hash::TEXT, u.encrypted_token,
           u.nonce,u.auth_tag,a.email
      FROM updated u
      JOIN public.auth_password_reset_tokens t ON t.token_hash=u.token_hash
      JOIN public.app_users a ON a.id=t.user_id;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_claim(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_claim(INTEGER) TO radar_worker;

CREATE FUNCTION public.auth_password_reset_claim_active(p_job UUID,p_lease UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.auth_password_reset_outbox o
      JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
     WHERE o.id=p_job AND o.claim_id=p_lease AND o.status='CLAIMED'
       AND o.claimed_until>clock_timestamp()
       AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
  )
$$;
REVOKE ALL ON FUNCTION public.auth_password_reset_claim_active(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_claim_active(UUID,UUID) TO radar_worker;

-- ACK so age sobre o claim atual e hash especifico. Falha antiga nao revoga token novo.
CREATE FUNCTION public.auth_password_reset_finish(
  p_job UUID,p_lease UUID,p_accepted BOOLEAN,p_error TEXT,p_delay_seconds INTEGER
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog, public, pg_temp
AS $$
DECLARE
 v_digest CHAR(64); v_attempts INTEGER; v_expire TIMESTAMPTZ;
 v_used TIMESTAMPTZ; v_now TIMESTAMPTZ := clock_timestamp();
 v_status TEXT;
BEGIN
 IF p_delay_seconds NOT BETWEEN 0 AND 600 THEN
   RAISE EXCEPTION 'invalid_reset_retry' USING ERRCODE='22023';
 END IF;

 SELECT o.token_hash,o.attempt_count,t.expires_at,t.used_at,o.status
 INTO v_digest,v_attempts,v_expire,v_used,v_status
 FROM public.auth_password_reset_outbox o
 JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
 WHERE o.id=p_job AND o.claim_id=p_lease
 FOR UPDATE OF o;

 IF NOT FOUND OR v_status<>'CLAIMED' THEN RETURN 'IGNORED'; END IF;
 IF v_used IS NOT NULL OR v_expire<=v_now THEN
   UPDATE public.auth_password_reset_outbox
      SET status='EXPIRED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
          claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code='EXPIRED'
    WHERE id=p_job;
   RETURN 'EXPIRED';
 END IF;

 IF p_accepted THEN
   UPDATE public.auth_password_reset_outbox
      SET status='ACCEPTED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
          claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code=NULL
    WHERE id=p_job;
   RETURN 'ACCEPTED';
 END IF;

 IF v_attempts<3 AND v_expire>v_now+make_interval(secs=>p_delay_seconds) THEN
   UPDATE public.auth_password_reset_outbox
      SET status='PENDING',available_at=v_now+make_interval(secs=>p_delay_seconds),
          claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code='TRANSIENT'
    WHERE id=p_job;
   RETURN 'RETRY';
 END IF;

 UPDATE public.auth_password_reset_outbox
    SET status='FAILED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
        claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code='FINAL'
  WHERE id=p_job;

 UPDATE public.auth_password_reset_tokens
    SET used_at=v_now WHERE token_hash=v_digest AND used_at IS NULL;
 RETURN 'FAILED';
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_finish(UUID,UUID,BOOLEAN,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_finish(UUID,UUID,BOOLEAN,TEXT,INTEGER) TO radar_worker;

REVOKE ALL ON FUNCTION auth_password_reset_redeem(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_password_reset_redeem(TEXT, TEXT) TO radar_app;
