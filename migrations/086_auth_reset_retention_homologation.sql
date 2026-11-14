-- Manual maintenance only. Preserve the existing account-deletion cascade.
CREATE FUNCTION public.auth_password_reset_retention(
  p_request_days INTEGER,
  p_outbox_days INTEGER,
  p_token_hours INTEGER,
  p_batch_size INTEGER DEFAULT 5000,
  p_dry_run BOOLEAN DEFAULT TRUE
) RETURNS TABLE (
  requests BIGINT, outbox BIGINT, tokens BIGINT,
  tokens_deferred BIGINT, tokens_waiting_active_outbox BIGINT,
  oldest_waiting_active_seconds BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_outbox_cutoff TIMESTAMPTZ;
  v_token_cutoff TIMESTAMPTZ;
  v_hashes CHAR(64)[];
BEGIN
  IF p_request_days IS NULL OR p_request_days NOT BETWEEN 1 AND 3650
     OR p_outbox_days IS NULL OR p_outbox_days NOT BETWEEN 1 AND 3650
     OR p_token_hours IS NULL OR p_token_hours NOT BETWEEN 1 AND 87600
     OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000
     OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'invalid_reset_retention_policy' USING ERRCODE = '22023';
  END IF;
  -- The child recheck must see transactions committed before the parent lock.
  IF NOT p_dry_run AND current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'reset_retention_requires_read_committed' USING ERRCODE = '25000';
  END IF;

  v_outbox_cutoff := v_now - make_interval(hours => p_outbox_days * 24);
  v_token_cutoff := v_now - make_interval(hours => p_token_hours);

  SELECT count(*), count(*) FILTER (WHERE o.status IN ('PENDING','CLAIMED')),
         COALESCE(EXTRACT(EPOCH FROM (v_now - min(o.created_at)
           FILTER (WHERE o.status IN ('PENDING','CLAIMED'))))::BIGINT, 0)
  INTO tokens_deferred, tokens_waiting_active_outbox, oldest_waiting_active_seconds
  FROM public.auth_password_reset_tokens t
  JOIN public.auth_password_reset_outbox o USING (token_hash)
  WHERE LEAST(t.used_at, t.expires_at) < v_token_cutoff
    AND (o.status IN ('PENDING','CLAIMED') OR o.updated_at >= v_outbox_cutoff
         OR o.encrypted_token IS NOT NULL OR o.nonce IS NOT NULL OR o.auth_tag IS NOT NULL);

  IF p_dry_run THEN
    requests := public.auth_password_reset_purge_terminal(p_request_days, TRUE);
    SELECT count(*) INTO outbox FROM public.auth_password_reset_outbox o
    WHERE o.status IN ('ACCEPTED','FAILED','EXPIRED','CANCELLED')
      AND o.updated_at < v_outbox_cutoff
      AND o.encrypted_token IS NULL AND o.nonce IS NULL AND o.auth_tag IS NULL;
    SELECT count(*) INTO tokens FROM public.auth_password_reset_tokens t
    WHERE LEAST(t.used_at, t.expires_at) < v_token_cutoff AND NOT EXISTS (
      SELECT 1 FROM public.auth_password_reset_outbox o WHERE o.token_hash = t.token_hash
        AND (o.status IN ('PENDING','CLAIMED') OR o.updated_at >= v_outbox_cutoff
             OR o.encrypted_token IS NOT NULL OR o.nonce IS NOT NULL OR o.auth_tag IS NOT NULL)
    );
    RETURN NEXT;
    RETURN;
  END IF;

  -- Reuse the existing request sweep at its fixed ceiling of 5,000.
  requests := public.auth_password_reset_purge_terminal(p_request_days, FALSE);

  WITH eligible AS (
    SELECT o.id FROM public.auth_password_reset_outbox o
    WHERE o.status IN ('ACCEPTED','FAILED','EXPIRED','CANCELLED')
      AND o.updated_at < v_outbox_cutoff
      AND o.encrypted_token IS NULL AND o.nonce IS NULL AND o.auth_tag IS NULL
    ORDER BY o.updated_at, o.id
    LIMIT p_batch_size FOR UPDATE OF o SKIP LOCKED
  )
  DELETE FROM public.auth_password_reset_outbox o USING eligible e WHERE o.id = e.id;
  GET DIAGNOSTICS outbox = ROW_COUNT;

  SELECT array_agg(locked.token_hash) INTO v_hashes FROM (
    SELECT t.token_hash FROM public.auth_password_reset_tokens t
    WHERE LEAST(t.used_at, t.expires_at) < v_token_cutoff AND NOT EXISTS (
      SELECT 1 FROM public.auth_password_reset_outbox o WHERE o.token_hash = t.token_hash
    )
    ORDER BY LEAST(t.used_at, t.expires_at), t.token_hash
    LIMIT p_batch_size FOR UPDATE OF t SKIP LOCKED
  ) locked;

  -- FOR UPDATE conflicts with the FK's KEY SHARE lock. Recheck children
  -- in a fresh snapshot after taking parent locks, before DELETE can cascade.
  DELETE FROM public.auth_password_reset_tokens t
  WHERE t.token_hash = ANY(v_hashes) AND NOT EXISTS (
    SELECT 1 FROM public.auth_password_reset_outbox o WHERE o.token_hash = t.token_hash
  );
  GET DIAGNOSTICS tokens = ROW_COUNT;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_password_reset_retention(INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN)
  FROM PUBLIC, radar_app, radar_worker;
