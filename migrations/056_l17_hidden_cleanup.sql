-- L-17: legacy hidden publications join the L-15 guarded cleanup.
-- DO NOT alter generated is_hidden or historical migration 029.
-- Safe rollout: DDL only, no deleted rows or triggered cleanup in this migration.
CREATE INDEX IF NOT EXISTS ix_publications_l17_hidden_id
  ON public.publications (id) WHERE is_hidden;

-- One candidate per publication. OUT_OF_SCOPE takes priority over HIDDEN
-- to avoid double counting. Non-DOU hidden items are counted as protected,
-- never silently removed. The authoritative 051 purge protects tenants,
-- official cross-source provenance and operational history.
CREATE FUNCTION public.l17_cleanup_candidates(p_after UUID,p_limit INTEGER)
RETURNS TABLE(
  publication_id UUID,scope_updated_at TIMESTAMPTZ,out_of_scope BOOLEAN,
  hidden_legacy BOOLEAN,has_company BOOLEAN,has_other_source BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_page_limit';
 END IF;
 RETURN QUERY
 WITH eligible_ids AS (
   SELECT s.publication_id AS id
     FROM public.publication_scope_state s
     WHERE s.scope='OUT_OF_SCOPE' AND (p_after IS NULL OR s.publication_id>p_after)
       AND EXISTS(SELECT 1 FROM public.publication_origins po
                   JOIN public.sources so ON so.id=po.source_id
                   WHERE po.publication_id=s.publication_id AND so.code='dou')
   UNION
   SELECT p.id FROM public.publications p
     WHERE p.is_hidden AND (p_after IS NULL OR p.id>p_after)
 ), limited AS (
   SELECT id FROM eligible_ids ORDER BY id LIMIT p_limit
 )
 SELECT p.id,COALESCE(s.updated_at,p.updated_at),
        COALESCE(s.scope='OUT_OF_SCOPE',false)
          AND EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so ON so.id=po.source_id
            WHERE po.publication_id=p.id AND so.code='dou'),
        p.is_hidden,
        EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id),
        NOT EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so ON so.id=po.source_id
          WHERE po.publication_id=p.id AND so.code='dou')
        OR EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so ON so.id=po.source_id
          WHERE po.publication_id=p.id AND so.code<>'dou')
 FROM limited l JOIN public.publications p ON p.id=l.id
 LEFT JOIN public.publication_scope_state s ON s.publication_id=p.id
 ORDER BY p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_cleanup_candidates(UUID,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l17_cleanup_candidates(UUID,INTEGER) TO radar_app;

CREATE FUNCTION public.l17_cleanup_admin_batch(p_ids UUID[],p_operation UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_count INTEGER;
BEGIN
 IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 v_count:=cardinality(p_ids);
 IF v_count IS NULL OR v_count<1 OR v_count>100
    OR v_count<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
    OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_batch';
 END IF;
 PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids) ORDER BY p.id FOR UPDATE;
 PERFORM 1 FROM public.publication_scope_state s
   WHERE s.publication_id=ANY(p_ids) ORDER BY s.publication_id FOR UPDATE;
 IF (SELECT count(*) FROM public.publications p
     WHERE p.id=ANY(p_ids)
       AND (p.is_hidden OR EXISTS(SELECT 1 FROM public.publication_scope_state s
           WHERE s.publication_id=p.id AND s.scope='OUT_OF_SCOPE'))
       AND EXISTS(SELECT 1 FROM public.publication_origins po
          JOIN public.sources so ON so.id=po.source_id
          WHERE po.publication_id=p.id AND so.code='dou'))<>v_count THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_cleanup_targets_changed';
 END IF;
 -- 051 performs locked rechecks and append-only per-batch audit. No bypass.
 RETURN public.collection_filter_direct_purge_batch(
   p_ids,'dou','DOU_OR_HIDDEN','OUT_OF_SCOPE','EXCLUDE_ALWAYS',p_operation
 );
END;
$$;
REVOKE ALL ON FUNCTION public.l17_cleanup_admin_batch(UUID[],UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l17_cleanup_admin_batch(UUID[],UUID) TO radar_app;

-- Worker-only scheduled task has separate authorization from 051: never
-- give worker EXECUTE on the generic admin purge. The historical append-only
-- guards accept deletion only by the migration owner while the local purge
-- transaction flag is active, as with 051. Preserve operational history.
CREATE FUNCTION public.l17_prune_hidden_batch(p_limit INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  p_ids UUID[];
  v_count INTEGER;
  v_item UUID;
  p_operation UUID:=gen_random_uuid();
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_batch_limit';
 END IF;
 -- Lock canonical parents in deterministic order and skip collection races.
 SELECT pg_catalog.array_agg(e.id ORDER BY e.id) INTO p_ids FROM (
   SELECT p.id FROM public.publications p
   WHERE p.is_hidden
     AND EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so
       ON so.id=po.source_id WHERE po.publication_id=p.id AND so.code='dou')
     AND NOT EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so
       ON so.id=po.source_id WHERE po.publication_id=p.id AND so.code<>'dou')
     AND NOT EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id)
   ORDER BY p.id LIMIT p_limit FOR UPDATE OF p SKIP LOCKED
 ) e;
 v_count:=COALESCE(cardinality(p_ids),0);
 IF v_count=0 THEN RETURN 0; END IF;
 -- Recheck after the locks; any surprising new tenant/other-source link
 -- aborts the entire batch. The material trigger locks the same parent.
 IF (SELECT count(*) FROM public.publications p WHERE p.id=ANY(p_ids)
     AND p.is_hidden
     AND EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so
       ON so.id=po.source_id WHERE po.publication_id=p.id AND so.code='dou')
     AND NOT EXISTS(SELECT 1 FROM public.publication_origins po JOIN public.sources so
       ON so.id=po.source_id WHERE po.publication_id=p.id AND so.code<>'dou')
     AND NOT EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id))<>v_count THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_worker_targets_changed';
 END IF;
  PERFORM pg_catalog.set_config('app.collection_filter_l11_purge','authorized',true);

  -- Shared operational run history is retained, but pointers to removed acts
  -- are cleared rather than dangling. Run-publication links are act-owned.
  UPDATE public.collection_items SET publication_id=NULL
   WHERE publication_id=ANY(p_ids);
  DELETE FROM public.collection_run_publications WHERE publication_id=ANY(p_ids);
  DELETE FROM public.publication_scope_state WHERE publication_id=ANY(p_ids);
  DELETE FROM public.publication_scope_events WHERE publication_id=ANY(p_ids);

  DELETE FROM public.publication_taxonomy_curator_tags
   WHERE publication_version_id IN (
     SELECT pv.id FROM public.publication_versions pv WHERE pv.publication_id=ANY(p_ids));
  DELETE FROM public.publication_taxonomy_scans
   WHERE publication_version_id IN (
     SELECT pv.id FROM public.publication_versions pv WHERE pv.publication_id=ANY(p_ids));
  DELETE FROM public.publication_ncm_mentions
   WHERE publication_version_id IN (
     SELECT pv.id FROM public.publication_versions pv WHERE pv.publication_id=ANY(p_ids));

  DELETE FROM public.taxonomy_candidate_occurrence_links l
   WHERE EXISTS(SELECT 1 FROM public.taxonomy_unmapped_occurrences u
     JOIN public.publication_taxonomy_runs r ON r.id=u.run_id
     JOIN public.publication_versions pv ON pv.id=r.publication_version_id
     WHERE l.occurrence_id=u.id AND pv.publication_id=ANY(p_ids));
  DELETE FROM public.taxonomy_unmapped_occurrences u
   WHERE EXISTS(SELECT 1 FROM public.publication_taxonomy_runs r
     JOIN public.publication_versions pv ON pv.id=r.publication_version_id
     WHERE u.run_id=r.id AND pv.publication_id=ANY(p_ids));

  DELETE FROM public.publication_taxonomy_reviews r
   WHERE EXISTS(SELECT 1 FROM public.publication_taxonomy_assertions a
     JOIN public.publication_taxonomy_runs t ON t.id=a.run_id
     JOIN public.publication_versions pv ON pv.id=t.publication_version_id
     WHERE r.assertion_id=a.id AND pv.publication_id=ANY(p_ids));
  DELETE FROM public.publication_taxonomy_spans s
   WHERE EXISTS(SELECT 1 FROM public.publication_taxonomy_assertions a
     JOIN public.publication_taxonomy_runs t ON t.id=a.run_id
     JOIN public.publication_versions pv ON pv.id=t.publication_version_id
     WHERE s.assertion_id=a.id AND pv.publication_id=ANY(p_ids));

  -- RESTRICT supersession chains: delete youngest dependents first.
  FOR v_item IN
    WITH RECURSIVE selected AS (
      SELECT a.id,a.supersedes_assertion_id
      FROM public.publication_taxonomy_assertions a
      JOIN public.publication_taxonomy_runs r ON r.id=a.run_id
      JOIN public.publication_versions pv ON pv.id=r.publication_version_id
      WHERE pv.publication_id=ANY(p_ids)
    ), ordered AS (
      SELECT a.id,a.supersedes_assertion_id,0 AS depth FROM selected a
      WHERE NOT EXISTS(SELECT 1 FROM selected newer
                       WHERE newer.supersedes_assertion_id=a.id)
      UNION ALL
      SELECT parent.id,parent.supersedes_assertion_id,ordered.depth+1
      FROM selected parent JOIN ordered ON ordered.supersedes_assertion_id=parent.id
    )
    SELECT id FROM ordered ORDER BY depth,id
  LOOP
    DELETE FROM public.publication_taxonomy_assertions WHERE id=v_item;
  END LOOP;

  FOR v_item IN
    WITH RECURSIVE selected AS (
      SELECT r.id,r.supersedes_run_id
      FROM public.publication_taxonomy_runs r
      JOIN public.publication_versions pv ON pv.id=r.publication_version_id
      WHERE pv.publication_id=ANY(p_ids)
    ), ordered AS (
      SELECT r.id,r.supersedes_run_id,0 AS depth FROM selected r
      WHERE NOT EXISTS(SELECT 1 FROM selected newer WHERE newer.supersedes_run_id=r.id)
      UNION ALL
      SELECT parent.id,parent.supersedes_run_id,ordered.depth+1
      FROM selected parent JOIN ordered ON ordered.supersedes_run_id=parent.id
    )
    SELECT id FROM ordered ORDER BY depth,id
  LOOP
    DELETE FROM public.publication_taxonomy_runs WHERE id=v_item;
  END LOOP;

  UPDATE public.collection_filter_new_types n
    SET sample_publication_ids=ARRAY(
      SELECT id FROM unnest(n.sample_publication_ids) id
      WHERE id<>ALL(p_ids))
    WHERE n.sample_publication_ids && p_ids;

  DELETE FROM public.publications p WHERE p.id=ANY(p_ids);
  PERFORM pg_catalog.set_config('app.collection_filter_l11_purge','',true);
 INSERT INTO public.audit_log(tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id)
 VALUES(NULL,'SYSTEM','l17:scheduler','L17_HIDDEN_PURGE',
   'publications','LEGACY_HIDDEN',pg_catalog.jsonb_build_object(
     'sourceCode','dou','mode','RETENTION','deletedCount',v_count,'deletedIds',p_ids
   ),p_operation);
 RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_prune_hidden_batch(INTEGER) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_prune_hidden_batch(INTEGER) TO radar_worker;

CREATE TABLE public.l17_hidden_cleanup_daily(
 local_day DATE PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
 deleted_publications INTEGER NOT NULL DEFAULT 0 CHECK(deleted_publications>=0),
 batches INTEGER NOT NULL DEFAULT 0 CHECK(batches>=0),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ
);
REVOKE ALL ON public.l17_hidden_cleanup_daily FROM PUBLIC,radar_app,radar_worker;

CREATE FUNCTION public.l17_claim_hidden_day()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_local TIMESTAMP := now() AT TIME ZONE 'America/Sao_Paulo';
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF v_local::time < TIME '03:30' OR v_local::time >= TIME '03:31' THEN
   RETURN FALSE;
 END IF;
 INSERT INTO public.l17_hidden_cleanup_daily(local_day,status) VALUES(v_local::date,'STARTED')
 ON CONFLICT DO NOTHING;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_claim_hidden_day() FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_claim_hidden_day() TO radar_worker;

CREATE FUNCTION public.l17_finish_hidden_day(p_deleted INTEGER,p_batches INTEGER,p_ok BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF p_deleted<0 OR p_batches<0 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_report';
 END IF;
 UPDATE public.l17_hidden_cleanup_daily SET
   status=CASE WHEN p_ok THEN 'COMPLETED' ELSE 'FAILED' END,
   deleted_publications=p_deleted,batches=p_batches,finished_at=now()
 WHERE local_day=(now() AT TIME ZONE 'America/Sao_Paulo')::date AND status='STARTED';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_claim_missing'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_finish_hidden_day(INTEGER,INTEGER,BOOLEAN) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_finish_hidden_day(INTEGER,INTEGER,BOOLEAN) TO radar_worker;
