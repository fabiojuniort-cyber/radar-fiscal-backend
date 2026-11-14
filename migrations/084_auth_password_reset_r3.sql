-- AUTH-RESET-03 R3: neutral intake, worker readiness and robust leases.
-- All objects live in public; SECURITY DEFINER never resolves pg_temp first.

CREATE TABLE public.auth_password_reset_requests (
  id UUID PRIMARY KEY,
  email_digest CHAR(64) NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
  encrypted_email TEXT,
  nonce TEXT,
  auth_tag TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CLAIMED','PREPARED','UNKNOWN','SUPERSEDED','EXPIRED','FAILED')),
  processing_errors INTEGER NOT NULL DEFAULT 0 CHECK (processing_errors BETWEEN 0 AND 3),
  claim_id UUID,
  claimed_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  error_code TEXT,
  CONSTRAINT chk_reset_request_ciphertext CHECK (
    (status IN ('PENDING','CLAIMED') AND encrypted_email IS NOT NULL
      AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
    OR (status NOT IN ('PENDING','CLAIMED') AND encrypted_email IS NULL
      AND nonce IS NULL AND auth_tag IS NULL)
  ),
  CONSTRAINT chk_reset_request_expiry CHECK (expires_at > created_at)
);

CREATE INDEX ix_reset_request_ready
  ON public.auth_password_reset_requests (available_at, created_at)
  WHERE status IN ('PENDING','CLAIMED');
CREATE INDEX ix_reset_request_latest
  ON public.auth_password_reset_requests (email_digest,created_at DESC,id DESC);

ALTER TABLE public.auth_password_reset_outbox
  ADD COLUMN send_started_at TIMESTAMPTZ,
  ADD COLUMN processing_errors INTEGER NOT NULL DEFAULT 0
    CHECK (processing_errors BETWEEN 0 AND 3);

ALTER TABLE public.auth_password_reset_tokens ADD COLUMN email_digest CHAR(64)
  CHECK (email_digest IS NULL OR email_digest ~ '^[0-9a-f]{64}$');
CREATE INDEX ix_reset_token_digest_created
  ON public.auth_password_reset_tokens(email_digest,created_at);

CREATE TABLE public.auth_password_reset_key_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  key_fingerprint CHAR(64) NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{64}$'),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.auth_password_reset_worker_heartbeats (
  instance_id UUID PRIMARY KEY,
  key_fingerprint CHAR(64) NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON public.auth_password_reset_requests FROM PUBLIC,radar_app,radar_worker;
REVOKE ALL ON public.auth_password_reset_key_state FROM PUBLIC,radar_app,radar_worker;
REVOKE ALL ON public.auth_password_reset_worker_heartbeats FROM PUBLIC,radar_app,radar_worker;
-- Only the worker's verified, locked request preparation can invoke issue.
REVOKE ALL ON FUNCTION public.auth_password_reset_issue(TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT)
  FROM PUBLIC,radar_app,radar_worker;

-- Public HTTP ingress performs exactly one neutral insert, independent of account.
CREATE FUNCTION public.auth_password_reset_enqueue(
  p_id UUID,p_digest TEXT,p_cipher TEXT,p_nonce TEXT,p_tag TEXT,p_ttl_secs INTEGER
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF p_id IS NULL OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
     OR p_cipher IS NULL OR length(p_cipher) NOT BETWEEN 16 AND 1200
     OR p_nonce IS NULL OR length(p_nonce) NOT BETWEEN 12 AND 32
     OR p_tag IS NULL OR length(p_tag) NOT BETWEEN 20 AND 48
     OR p_ttl_secs NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid_reset_enqueue' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.auth_password_reset_requests
   (id,email_digest,encrypted_email,nonce,auth_tag,expires_at)
  VALUES
   (p_id,p_digest,p_cipher,p_nonce,p_tag,
    clock_timestamp()+make_interval(secs=>p_ttl_secs));
  RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_enqueue(UUID,TEXT,TEXT,TEXT,TEXT,INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_enqueue(UUID,TEXT,TEXT,TEXT,TEXT,INTEGER)
  TO radar_app;

CREATE FUNCTION public.auth_password_reset_worker_heartbeat(p_instance UUID,p_fingerprint TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_current CHAR(64);
BEGIN
  IF p_instance IS NULL OR p_fingerprint IS NULL
     OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.auth_password_reset_key_state (singleton,key_fingerprint)
  VALUES(TRUE,p_fingerprint) ON CONFLICT (singleton) DO NOTHING;
  SELECT key_fingerprint INTO v_current
    FROM public.auth_password_reset_key_state WHERE singleton=TRUE;
  IF v_current<>p_fingerprint THEN RETURN FALSE; END IF;
  INSERT INTO public.auth_password_reset_worker_heartbeats
    (instance_id,key_fingerprint,last_seen_at)
  VALUES(p_instance,p_fingerprint,clock_timestamp())
  ON CONFLICT(instance_id) DO UPDATE
    SET key_fingerprint=EXCLUDED.key_fingerprint,last_seen_at=clock_timestamp();
  RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_worker_heartbeat(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_worker_heartbeat(UUID,TEXT)
  TO radar_worker;

CREATE FUNCTION public.auth_password_reset_worker_ready(p_fingerprint TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.auth_password_reset_key_state k
    JOIN public.auth_password_reset_worker_heartbeats h
       ON h.key_fingerprint=k.key_fingerprint
    WHERE k.singleton=TRUE AND k.key_fingerprint=p_fingerprint
      AND h.last_seen_at>clock_timestamp()-interval '30 seconds'
  )
$$;
REVOKE ALL ON FUNCTION public.auth_password_reset_worker_ready(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_worker_ready(TEXT) TO radar_app;

-- Explicit rotation gate: only when BOTH request and delivery queues are drained.
CREATE FUNCTION public.auth_password_reset_rotate_key(p_fingerprint TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
   RETURN FALSE;
 END IF;
 PERFORM 1 FROM public.auth_password_reset_key_state
  WHERE singleton=TRUE FOR UPDATE;
 IF EXISTS(
   SELECT 1 FROM public.auth_password_reset_requests
   WHERE status IN('PENDING','CLAIMED')
 ) OR EXISTS(
   SELECT 1 FROM public.auth_password_reset_outbox
   WHERE status IN('PENDING','CLAIMED')
 ) THEN RETURN FALSE; END IF;
 UPDATE public.auth_password_reset_key_state
   SET key_fingerprint=p_fingerprint,activated_at=clock_timestamp()
 WHERE singleton=TRUE;
 DELETE FROM public.auth_password_reset_worker_heartbeats;
 RETURN TRUE;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_rotate_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_rotate_key(TEXT) TO radar_worker;

CREATE FUNCTION public.auth_password_reset_request_claim(p_lease_seconds INTEGER)
RETURNS TABLE(
  request_id UUID,lease_id UUID,email_digest TEXT,
  ciphertext TEXT,iv TEXT,mac TEXT
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_id UUID;
BEGIN
 IF p_lease_seconds NOT BETWEEN 6 AND 60 THEN
   RAISE EXCEPTION 'invalid_reset_request_lease' USING ERRCODE='22023';
 END IF;
 SELECT r.id INTO v_id FROM public.auth_password_reset_requests r
  WHERE ((r.status='PENDING' AND r.available_at<=clock_timestamp())
      OR (r.status='CLAIMED' AND r.claimed_until<clock_timestamp()))
    AND r.processing_errors<3 AND r.expires_at>clock_timestamp()
  ORDER BY r.created_at,r.id
  FOR UPDATE OF r SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY
  WITH changed AS(
    UPDATE public.auth_password_reset_requests r
      SET status='CLAIMED',claim_id=pg_catalog.gen_random_uuid(),
          claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
          updated_at=clock_timestamp()
    WHERE r.id=v_id
    RETURNING r.id,r.claim_id,r.email_digest,
              r.encrypted_email,r.nonce,r.auth_tag
  )
  SELECT c.id,c.claim_id,c.email_digest::TEXT,c.encrypted_email,
         c.nonce,c.auth_tag FROM changed c;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_request_claim(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_request_claim(INTEGER) TO radar_worker;

-- Atomic prepare: request state and token/outbox commit (or roll back) together.
CREATE FUNCTION public.auth_password_reset_prepare_request(
  p_id UUID,p_lease UUID,p_email TEXT,p_token_hash TEXT,
  p_cipher TEXT,p_nonce TEXT,p_tag TEXT,p_ttl INTEGER
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_req public.auth_password_reset_requests%ROWTYPE;
DECLARE v_issued BOOLEAN;
DECLARE v_now TIMESTAMPTZ;
BEGIN
 SELECT * INTO v_req FROM public.auth_password_reset_requests
 WHERE id=p_id AND claim_id=p_lease AND status='CLAIMED'
 FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT FOUND OR v_req.claimed_until<=v_now THEN RETURN 'STALE'; END IF;
 IF v_req.expires_at<=v_now THEN
   UPDATE public.auth_password_reset_requests
    SET status='EXPIRED',encrypted_email=NULL,nonce=NULL,auth_tag=NULL,
        claim_id=NULL,claimed_until=NULL,updated_at=v_now,error_code='EXPIRED'
   WHERE id=p_id;
   RETURN 'EXPIRED';
 END IF;
 IF p_email IS NULL OR length(p_email)>320
   OR lower(btrim(p_email))<>p_email THEN
   RAISE EXCEPTION 'invalid_reset_recipient' USING ERRCODE='22023';
 END IF;
 -- A prior request must never invalidate a newer request already received.
 IF EXISTS(
   SELECT 1 FROM public.auth_password_reset_requests newer
   WHERE newer.email_digest=v_req.email_digest
     AND (newer.created_at,newer.id)>(v_req.created_at,v_req.id)
 ) THEN
   UPDATE public.auth_password_reset_requests
    SET status='SUPERSEDED',encrypted_email=NULL,nonce=NULL,auth_tag=NULL,
        claim_id=NULL,claimed_until=NULL,updated_at=v_now,error_code='SUPERSEDED'
    WHERE id=p_id;
   RETURN 'SUPERSEDED';
 END IF;
 SELECT public.auth_password_reset_issue(
   p_email,p_token_hash,p_ttl,p_cipher,p_nonce,p_tag
 ) INTO v_issued;
 IF v_issued THEN
   UPDATE public.auth_password_reset_tokens SET email_digest=v_req.email_digest
     WHERE token_hash=p_token_hash;
 END IF;
 UPDATE public.auth_password_reset_requests
  SET status=CASE WHEN v_issued THEN 'PREPARED' ELSE 'UNKNOWN' END,
      encrypted_email=NULL,nonce=NULL,auth_tag=NULL,
      claim_id=NULL,claimed_until=NULL,updated_at=clock_timestamp(),
      error_code=NULL
 WHERE id=p_id;
 RETURN CASE WHEN v_issued THEN 'PREPARED' ELSE 'UNKNOWN' END;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_prepare_request(
  UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_prepare_request(
  UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER) TO radar_worker;

CREATE FUNCTION public.auth_password_reset_request_fail(
  p_id UUID,p_lease UUID,p_retry_secs INTEGER
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.auth_password_reset_requests%ROWTYPE;
DECLARE v_now TIMESTAMPTZ;
DECLARE v_next INTEGER;
BEGIN
 IF p_retry_secs NOT BETWEEN 0 AND 300 THEN RETURN 'INVALID'; END IF;
 SELECT * INTO v FROM public.auth_password_reset_requests
  WHERE id=p_id AND claim_id=p_lease AND status='CLAIMED' FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT FOUND OR v.claimed_until<=v_now THEN RETURN 'IGNORED'; END IF;
 v_next:=v.processing_errors+1;
 IF v_next<3 AND v.expires_at>v_now+make_interval(secs=>p_retry_secs) THEN
   UPDATE public.auth_password_reset_requests
    SET status='PENDING',processing_errors=v_next,
        available_at=v_now+make_interval(secs=>p_retry_secs),
        claim_id=NULL,claimed_until=NULL,updated_at=v_now,error_code='PREP_ERROR'
   WHERE id=p_id;
   RETURN 'RETRY';
 END IF;
 UPDATE public.auth_password_reset_requests
  SET status='FAILED',processing_errors=v_next,encrypted_email=NULL,
      nonce=NULL,auth_tag=NULL,claim_id=NULL,claimed_until=NULL,
      updated_at=v_now,error_code='PREP_FAILED'
 WHERE id=p_id;
 RETURN 'FAILED';
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_request_fail(UUID,UUID,INTEGER)
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_request_fail(UUID,UUID,INTEGER)
 TO radar_worker;

CREATE OR REPLACE FUNCTION public.auth_password_reset_token_active(p_token_hash TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
 SELECT 1 FROM public.auth_password_reset_tokens t
 JOIN public.app_users u ON u.id=t.user_id
 WHERE t.token_hash=p_token_hash AND t.used_at IS NULL
   AND t.expires_at>clock_timestamp() AND u.status='ACTIVE'
   AND NOT EXISTS(
     SELECT 1 FROM public.auth_password_reset_requests newer
     WHERE newer.email_digest=t.email_digest AND newer.created_at>t.created_at
   )
 )
$$;

CREATE OR REPLACE FUNCTION public.auth_password_reset_redeem(
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
    IF EXISTS (
      SELECT 1 FROM public.auth_password_reset_tokens t
      JOIN public.auth_password_reset_requests newer
        ON newer.email_digest=t.email_digest
      WHERE t.token_hash=p_token_hash AND newer.created_at>t.created_at
    ) THEN RETURN FALSE; END IF;

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

-- Replace original reaper: recover abandoned claims, invalidate inactive users,
-- expire encrypted delivery requests and discard credentials on terminal states.
CREATE OR REPLACE FUNCTION public.auth_password_reset_reap()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_count INTEGER;
BEGIN
 UPDATE public.auth_password_reset_requests
  SET status='EXPIRED',encrypted_email=NULL,nonce=NULL,auth_tag=NULL,
      claimed_until=NULL,claim_id=NULL,updated_at=clock_timestamp(),
      error_code='EXPIRED'
 WHERE status IN('PENDING','CLAIMED') AND expires_at<=clock_timestamp();
 GET DIAGNOSTICS v_count=ROW_COUNT;

 UPDATE public.auth_password_reset_tokens t
   SET used_at=clock_timestamp()
 WHERE t.used_at IS NULL AND EXISTS(
   SELECT 1 FROM public.auth_password_reset_requests newer
   WHERE newer.email_digest=t.email_digest AND newer.created_at>t.created_at
 );

 UPDATE public.auth_password_reset_tokens t
   SET used_at=clock_timestamp()
 WHERE t.used_at IS NULL AND t.token_hash IN(
   SELECT o.token_hash FROM public.auth_password_reset_outbox o
     JOIN public.app_users u ON u.id=t.user_id
   WHERE o.token_hash=t.token_hash AND u.status<>'ACTIVE'
 );
 UPDATE public.auth_password_reset_outbox o
   SET status='CANCELLED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
       claim_id=NULL,claimed_until=NULL,updated_at=clock_timestamp(),
       error_code='ACCOUNT_INACTIVE'
 FROM public.auth_password_reset_tokens t
 JOIN public.app_users u ON u.id=t.user_id
 WHERE o.token_hash=t.token_hash AND o.status IN('PENDING','CLAIMED')
   AND u.status<>'ACTIVE';

 UPDATE public.auth_password_reset_outbox o
   SET status='EXPIRED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
       claim_id=NULL,claimed_until=NULL,updated_at=clock_timestamp(),
       error_code='EXPIRED'
 FROM public.auth_password_reset_tokens t
 WHERE o.token_hash=t.token_hash AND o.status IN('PENDING','CLAIMED')
   AND (t.used_at IS NOT NULL OR t.expires_at<=clock_timestamp());

 UPDATE public.auth_password_reset_tokens t
    SET used_at=clock_timestamp()
 WHERE t.used_at IS NULL AND t.token_hash IN(
   SELECT o.token_hash FROM public.auth_password_reset_outbox o
   WHERE o.status='CLAIMED' AND o.claimed_until<clock_timestamp()
     AND (o.attempt_count>=3 OR o.processing_errors>=3)
 );
 UPDATE public.auth_password_reset_outbox o
   SET status='FAILED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
       claim_id=NULL,claimed_until=NULL,updated_at=clock_timestamp(),
       error_code='LEASE_EXHAUSTED'
 WHERE o.status='CLAIMED' AND o.claimed_until<clock_timestamp()
   AND (o.attempt_count>=3 OR o.processing_errors>=3);

 DELETE FROM public.auth_password_reset_worker_heartbeats
 WHERE last_seen_at<clock_timestamp()-interval '30 minutes';
 RETURN v_count;
END; $$;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_reap() TO radar_app,radar_worker;

-- Claim may be recovered after process death; claiming alone is NOT a send attempt.
CREATE OR REPLACE FUNCTION public.auth_password_reset_claim(p_lease_seconds INTEGER)
RETURNS TABLE(
 job_id UUID,lease_id UUID,digest TEXT,ciphertext TEXT,iv TEXT,mac TEXT,recipient TEXT
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_job UUID;
BEGIN
 IF p_lease_seconds NOT BETWEEN 6 AND 60 THEN
  RAISE EXCEPTION 'invalid_reset_lease' USING ERRCODE='22023';
 END IF;
 SELECT o.id INTO v_job FROM public.auth_password_reset_outbox o
   JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
   JOIN public.app_users u ON u.id=t.user_id
 WHERE ((o.status='PENDING' AND o.available_at<=clock_timestamp())
     OR (o.status='CLAIMED' AND o.claimed_until<clock_timestamp()))
   AND o.attempt_count<3 AND o.processing_errors<3
   AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
   AND u.status='ACTIVE'
   AND NOT EXISTS(SELECT 1 FROM public.auth_password_reset_requests newer
     WHERE newer.email_digest=t.email_digest AND newer.created_at>t.created_at)
 ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY WITH changed AS(
   UPDATE public.auth_password_reset_outbox o
   SET status='CLAIMED',claim_id=pg_catalog.gen_random_uuid(),
       claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
       send_started_at=NULL,updated_at=clock_timestamp()
   WHERE o.id=v_job
   RETURNING o.id,o.claim_id,o.token_hash,o.encrypted_token,o.nonce,o.auth_tag
 )
 SELECT c.id,c.claim_id,c.token_hash::TEXT,c.encrypted_token,
        c.nonce,c.auth_tag,u.email
 FROM changed c
 JOIN public.auth_password_reset_tokens t ON t.token_hash=c.token_hash
 JOIN public.app_users u ON u.id=t.user_id;
END; $$;

CREATE OR REPLACE FUNCTION public.auth_password_reset_claim_active(p_job UUID,p_lease UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(
 SELECT 1 FROM public.auth_password_reset_outbox o
 JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
 JOIN public.app_users u ON u.id=t.user_id
 WHERE o.id=p_job AND o.claim_id=p_lease AND o.status='CLAIMED'
   AND o.claimed_until>clock_timestamp()
   AND o.attempt_count<3 AND o.processing_errors<3
   AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
   AND u.status='ACTIVE'
   AND NOT EXISTS(SELECT 1 FROM public.auth_password_reset_requests newer
     WHERE newer.email_digest=t.email_digest AND newer.created_at>t.created_at))
$$;

CREATE FUNCTION public.auth_password_reset_begin_send(p_job UUID,p_lease UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_count INTEGER;
BEGIN
 UPDATE public.auth_password_reset_outbox o
   SET attempt_count=o.attempt_count+1,send_started_at=clock_timestamp(),
       updated_at=clock_timestamp()
 FROM public.auth_password_reset_tokens t
 JOIN public.app_users u ON u.id=t.user_id
 WHERE o.id=p_job AND o.claim_id=p_lease AND o.status='CLAIMED'
   AND o.claimed_until>clock_timestamp()
   AND o.attempt_count<3 AND o.processing_errors<3
   AND o.send_started_at IS NULL
   AND t.token_hash=o.token_hash
   AND t.used_at IS NULL AND t.expires_at>clock_timestamp()
   AND u.status='ACTIVE'
   AND NOT EXISTS(SELECT 1 FROM public.auth_password_reset_requests newer
     WHERE newer.email_digest=t.email_digest AND newer.created_at>t.created_at);
 GET DIAGNOSTICS v_count=ROW_COUNT;
 RETURN v_count=1;
END; $$;
REVOKE ALL ON FUNCTION public.auth_password_reset_begin_send(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_begin_send(UUID,UUID) TO radar_worker;

CREATE OR REPLACE FUNCTION public.auth_password_reset_finish(
 p_job UUID,p_lease UUID,p_accepted BOOLEAN,p_error TEXT,p_delay_seconds INTEGER
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 v_digest CHAR(64);v_attempts INTEGER;v_errors INTEGER;
 v_expire TIMESTAMPTZ;v_used TIMESTAMPTZ;
 v_claimed_until TIMESTAMPTZ;v_send_started TIMESTAMPTZ;
 v_status TEXT;v_account_status TEXT;v_now TIMESTAMPTZ;
 v_next_errors INTEGER;
BEGIN
 IF p_delay_seconds NOT BETWEEN 0 AND 600 THEN
  RAISE EXCEPTION 'invalid_reset_retry' USING ERRCODE='22023';
 END IF;
 SELECT o.token_hash,o.attempt_count,o.processing_errors,t.expires_at,t.used_at,
        o.claimed_until,o.send_started_at,o.status,u.status
 INTO v_digest,v_attempts,v_errors,v_expire,v_used,v_claimed_until,
      v_send_started,v_status,v_account_status
 FROM public.auth_password_reset_outbox o
 JOIN public.auth_password_reset_tokens t ON t.token_hash=o.token_hash
 JOIN public.app_users u ON u.id=t.user_id
 WHERE o.id=p_job AND o.claim_id=p_lease
 FOR UPDATE OF o;
 v_now:=clock_timestamp();
 IF NOT FOUND OR v_status<>'CLAIMED' OR v_claimed_until<=v_now THEN
   RETURN 'IGNORED';
 END IF;
 IF v_used IS NOT NULL OR v_expire<=v_now OR v_account_status<>'ACTIVE' THEN
  UPDATE public.auth_password_reset_outbox
   SET status=CASE WHEN v_account_status<>'ACTIVE' THEN 'CANCELLED' ELSE 'EXPIRED' END,
       encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
       claimed_until=NULL,claim_id=NULL,updated_at=v_now,
       error_code='TOKEN_INACTIVE'
  WHERE id=p_job;
  RETURN 'EXPIRED';
 END IF;
 IF p_accepted THEN
   IF v_send_started IS NULL THEN RETURN 'IGNORED'; END IF;
   UPDATE public.auth_password_reset_outbox
    SET status='ACCEPTED',encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
        claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code=NULL
   WHERE id=p_job;
   RETURN 'ACCEPTED';
 END IF;
 v_next_errors:=v_errors+CASE WHEN v_send_started IS NULL THEN 1 ELSE 0 END;
 IF v_attempts<3 AND v_next_errors<3
    AND v_expire>v_now+make_interval(secs=>p_delay_seconds) THEN
   UPDATE public.auth_password_reset_outbox
    SET status='PENDING',processing_errors=v_next_errors,
        available_at=v_now+make_interval(secs=>p_delay_seconds),
        claimed_until=NULL,claim_id=NULL,send_started_at=NULL,
        updated_at=v_now,error_code='TRANSIENT'
   WHERE id=p_job;
   RETURN 'RETRY';
 END IF;
 UPDATE public.auth_password_reset_outbox
  SET status='FAILED',processing_errors=v_next_errors,
      encrypted_token=NULL,nonce=NULL,auth_tag=NULL,
      claimed_until=NULL,claim_id=NULL,updated_at=v_now,error_code='FINAL'
 WHERE id=p_job;
 UPDATE public.auth_password_reset_tokens
   SET used_at=v_now WHERE token_hash=v_digest AND used_at IS NULL;
 RETURN 'FAILED';
END; $$;

-- Read-only observability: aggregates only, no PII or ciphertext.
CREATE FUNCTION public.auth_password_reset_queue_health()
RETURNS TABLE(pending BIGINT,claimed BIGINT,failed BIGINT,oldest_pending_seconds BIGINT)
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT
  count(*) FILTER (WHERE status='PENDING'),
  count(*) FILTER (WHERE status='CLAIMED'),
  count(*) FILTER (WHERE status='FAILED'),
  COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-
    min(created_at) FILTER(WHERE status='PENDING')))::BIGINT,0)
 FROM public.auth_password_reset_outbox
$$;
REVOKE ALL ON FUNCTION public.auth_password_reset_queue_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_password_reset_queue_health() TO radar_worker;
