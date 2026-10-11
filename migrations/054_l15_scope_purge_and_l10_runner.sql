-- L-15: read-only DOU out-of-scope paging and guarded reuse of 051 purge.
-- L-10: dedicated least-privilege retention batch, preserving all run/attempt
-- and publication history. No data is deleted while applying this migration.

CREATE OR REPLACE FUNCTION public.l15_out_of_scope_candidates(
  p_after UUID, p_limit INTEGER
)
RETURNS TABLE(
  publication_id UUID,
  scope_updated_at TIMESTAMPTZ,
  has_company BOOLEAN,
  has_other_source BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_l15_page_limit';
  END IF;
  RETURN QUERY
    SELECT s.publication_id, s.updated_at,
      EXISTS(SELECT 1 FROM public.company_publications cp
        WHERE cp.publication_id=s.publication_id),
      EXISTS(SELECT 1 FROM public.publication_origins po
        JOIN public.sources src ON src.id=po.source_id
        WHERE po.publication_id=s.publication_id AND src.code<>'dou')
    FROM public.publication_scope_state s
    WHERE s.scope='OUT_OF_SCOPE'
      AND (p_after IS NULL OR s.publication_id>p_after)
      AND EXISTS(SELECT 1 FROM public.publication_origins po
        JOIN public.sources src ON src.id=po.source_id
        WHERE po.publication_id=s.publication_id AND src.code='dou')
    ORDER BY s.publication_id LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.l15_out_of_scope_candidates(UUID,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l15_out_of_scope_candidates(UUID,INTEGER) TO radar_app;

-- Recheck every target after locking parent then scope state, in the same
-- transaction. This protects against concurrent RESTORE and source/tenant links.
-- 051 checks admin auth, DOU-only provenance, tenant links, current parents,
-- removes publication-owned dependency rows, and writes per-batch audit.
CREATE OR REPLACE FUNCTION public.l15_out_of_scope_purge_batch(
  p_ids UUID[], p_operation UUID
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_count INTEGER;
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;
  v_count:=cardinality(p_ids);
  IF v_count IS NULL OR v_count<1 OR v_count>100
     OR v_count<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
     OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_l15_batch';
  END IF;
  -- Preserve parent-before-child order used by 051 and suppression guards.
  PERFORM 1 FROM public.publications p
    WHERE p.id=ANY(p_ids) ORDER BY p.id FOR UPDATE;
  PERFORM 1 FROM public.publication_scope_state s
    WHERE s.publication_id=ANY(p_ids) ORDER BY s.publication_id FOR UPDATE;
  IF (SELECT count(*) FROM public.publication_scope_state s
      WHERE s.publication_id=ANY(p_ids) AND s.scope='OUT_OF_SCOPE')<>v_count THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='l15_scope_targets_changed';
  END IF;
  -- 051 audits every committed batch with type OUT_OF_SCOPE (no rule change).
  RETURN public.collection_filter_direct_purge_batch(
    p_ids, 'dou', 'DOU', 'OUT_OF_SCOPE', 'EXCLUDE_ALWAYS', p_operation
  );
END;
$$;
REVOKE ALL ON FUNCTION public.l15_out_of_scope_purge_batch(UUID[],UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l15_out_of_scope_purge_batch(UUID[],UUID) TO radar_app;

-- L-10 worker-only bounded daily task. Non-scheduler callers cannot invoke
-- via radar_app. Retention cutoff is computed server-side (cannot be loosened).
CREATE OR REPLACE FUNCTION public.l10_prune_collection_items_batch(p_limit INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_count INTEGER;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
  END IF;
  IF p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_l10_batch_limit';
  END IF;
  WITH eligible AS (
    SELECT id FROM public.collection_items
    WHERE created_at < now() - INTERVAL '7 days'
    ORDER BY created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), deleted AS (
    DELETE FROM public.collection_items ci USING eligible e
    WHERE ci.id=e.id AND ci.created_at < now() - INTERVAL '7 days'
    RETURNING ci.id
  )
  SELECT count(*)::integer INTO v_count FROM deleted;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.l10_prune_collection_items_batch(INTEGER) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l10_prune_collection_items_batch(INTEGER) TO radar_worker;

-- Once-per-Brazilian-calendar-day durable execution ledger. No publication
-- deletions, no write during migration; only scheduler claims at 03:30 local.
CREATE TABLE IF NOT EXISTS public.collection_items_retention_daily (
  local_day DATE PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
  deleted_items INTEGER NOT NULL DEFAULT 0 CHECK(deleted_items>=0),
  remaining_eligible BIGINT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
REVOKE ALL ON public.collection_items_retention_daily FROM PUBLIC,radar_app,radar_worker;

CREATE OR REPLACE FUNCTION public.l10_claim_retention_day()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_local TIMESTAMP;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
  END IF;
  v_local:=now() AT TIME ZONE 'America/Sao_Paulo';
  IF v_local::time < TIME '03:30' OR v_local::time >= TIME '03:31' THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.collection_items_retention_daily(local_day,status)
    VALUES(v_local::date,'STARTED') ON CONFLICT DO NOTHING;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.l10_claim_retention_day() FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l10_claim_retention_day() TO radar_worker;

CREATE OR REPLACE FUNCTION public.l10_finish_retention_day(
  p_deleted INTEGER,p_remaining BIGINT,p_success BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
  END IF;
  IF p_deleted<0 OR p_remaining<0 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l10_report';
  END IF;
  UPDATE public.collection_items_retention_daily
    SET status=CASE WHEN p_success THEN 'COMPLETED' ELSE 'FAILED' END,
      deleted_items=p_deleted,remaining_eligible=p_remaining,finished_at=now()
    WHERE local_day=(now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND status='STARTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l10_claim_missing';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.l10_finish_retention_day(INTEGER,BIGINT,BOOLEAN)
  FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l10_finish_retention_day(INTEGER,BIGINT,BOOLEAN)
  TO radar_worker;
