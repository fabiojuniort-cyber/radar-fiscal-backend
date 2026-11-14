-- AUTH-RESET-04 R4 (#9): observabilidade por estagio sem alterar grants
-- existentes e politica candidata de retencao (somente DBA, SEM job automatico).
-- Manter a assinatura da health para compatibilidade com consumidores R3.
-- Linha 1 = delivery/outbox (contrato legado); linha 2 = neutral/request.
-- A ordem e garantida por stage_order; o novo worker exige ambas.
CREATE OR REPLACE FUNCTION public.auth_password_reset_queue_health()
RETURNS TABLE (
  pending BIGINT,
  claimed BIGINT,
  failed BIGINT,
  oldest_pending_seconds BIGINT
)
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
  WITH stages AS (
    SELECT 1 AS stage_order,
      count(*) FILTER (WHERE status='PENDING') AS pending,
      count(*) FILTER (WHERE status='CLAIMED') AS claimed,
      count(*) FILTER (WHERE status='FAILED') AS failed,
      COALESCE(EXTRACT(EPOCH FROM (
        clock_timestamp()-
        min(created_at) FILTER (WHERE status='PENDING')
      ))::BIGINT,0) AS oldest_pending_seconds
    FROM public.auth_password_reset_outbox

    UNION ALL

    SELECT 2 AS stage_order,
      count(*) FILTER (WHERE status='PENDING') AS pending,
      count(*) FILTER (WHERE status='CLAIMED') AS claimed,
      count(*) FILTER (WHERE status='FAILED') AS failed,
      COALESCE(EXTRACT(EPOCH FROM (
        clock_timestamp()-
        min(created_at) FILTER (WHERE status='PENDING')
      ))::BIGINT,0) AS oldest_pending_seconds
    FROM public.auth_password_reset_requests
  )
  SELECT pending,claimed,failed,oldest_pending_seconds
  FROM stages ORDER BY stage_order
$$;
-- A assinatura e os EXECUTE grants anteriores de queue_health permanecem.

-- RET-P3: ferramenta administrativa opt-in, SEM acionamento por janitor/reaper.
-- 30 dias e somente uma HIPOTESE, nao prazo empresarial aprovado.
-- NAO entregar EXECUTE aos runtimes app/worker. dry_run default TRUE.
CREATE FUNCTION public.auth_password_reset_purge_terminal(
  p_retention_days INTEGER,
  p_dry_run BOOLEAN DEFAULT TRUE
) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_count BIGINT := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days NOT BETWEEN 1 AND 3650
      OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'invalid_reset_retention_policy' USING ERRCODE='22023';
  END IF;
  v_cutoff := clock_timestamp() - make_interval(days=>p_retention_days);
  IF p_dry_run THEN
    SELECT count(*) INTO v_count
    FROM public.auth_password_reset_requests r
    WHERE r.status IN ('PREPARED','UNKNOWN','SUPERSEDED','EXPIRED','FAILED')
      AND r.updated_at < v_cutoff
      AND r.encrypted_email IS NULL AND r.nonce IS NULL AND r.auth_tag IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.auth_password_reset_tokens t
        WHERE t.email_digest=r.email_digest AND t.used_at IS NULL
          AND t.expires_at>clock_timestamp()
      );
    RETURN v_count;
  END IF;

  WITH eligible AS (
    SELECT r.id
    FROM public.auth_password_reset_requests r
    WHERE r.status IN ('PREPARED','UNKNOWN','SUPERSEDED','EXPIRED','FAILED')
      AND r.updated_at < v_cutoff
      AND r.encrypted_email IS NULL AND r.nonce IS NULL AND r.auth_tag IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.auth_password_reset_tokens t
        WHERE t.email_digest=r.email_digest AND t.used_at IS NULL
          AND t.expires_at>clock_timestamp()
      )
    ORDER BY r.updated_at,r.id
    FOR UPDATE OF r SKIP LOCKED
    LIMIT 5000
  )
  DELETE FROM public.auth_password_reset_requests r
  USING eligible
  WHERE r.id=eligible.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

-- Esta funcao nova nao e exposta aos principals de runtime.
REVOKE ALL ON FUNCTION public.auth_password_reset_purge_terminal(INTEGER,BOOLEAN)
  FROM PUBLIC,radar_app,radar_worker;
