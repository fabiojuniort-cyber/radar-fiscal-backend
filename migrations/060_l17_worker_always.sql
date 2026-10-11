-- L-17 worker: use the existing read-only SQL candidate evidence and
-- the same TypeScript evaluateCollectionFilter used by collection runtime.
-- Only a radar_worker session can request bounded irreversible batches.
-- This migration changes no historical data on apply.
-- L-17: Align historical archived candidate type conflict with the
-- runtime canonical-specific type behavior. Preserve generic source type
-- as provenance and preserve TYPE_CONFLICT on unrelated classifications.
-- This changes the privileged SQL prefilter's evidence flag only; the
-- shared TypeScript evaluateCollectionFilter remains the decision engine.
-- No purge or UPDATE takes place during migration.
CREATE OR REPLACE FUNCTION public.collection_filter_direct_candidates(
  p_after UUID,
  p_limit INTEGER,
  p_section TEXT,
  p_type_keys TEXT[]
)
RETURNS TABLE (
  publication_id UUID,
  title TEXT,
  act_type TEXT,
  section TEXT,
  content_text TEXT,
  relevant_excerpt TEXT,
  evidence_complete BOOLEAN,
  has_material BOOLEAN,
  type_conflict BOOLEAN,
  provenance_conflict BOOLEAN,
  has_company BOOLEAN,
  has_other_source BOOLEAN,
  content_hash TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT (public.app_current_user_id() IS NOT NULL AND public.app_user_is_platform_admin())
     AND NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='admin_or_worker_required';
  END IF;
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_page_limit';
  END IF;
  IF COALESCE(btrim(p_section),'')='' OR cardinality(p_type_keys) IS NULL
     OR cardinality(p_type_keys)<1 OR cardinality(p_type_keys)>1000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_prefilter';
  END IF;

  RETURN QUERY
  SELECT p.id,p.title,p.act_type,
    COALESCE(NULLIF(o.metadata->'dou'->>'section',''),
      v.source_metadata->'dou'->>'section',''),
    v.content_text,v.relevant_excerpt,
    (
      COALESCE(btrim(v.content_text),'')<>''
      AND NOT COALESCE(o.metadata->'dou'->>'scopeStructureIncomplete'='true',false)
      AND NOT COALESCE(v.source_metadata->'dou'->>'scopeStructureIncomplete'='true',false)
      AND NOT (COALESCE(o.metadata->'dou','{}'::jsonb) ? 'titleFallback')
      AND NOT (COALESCE(v.source_metadata->'dou','{}'::jsonb) ? 'titleFallback')
    ),
    (
      EXISTS (SELECT 1 FROM public.publication_files pf WHERE pf.publication_version_id=v.id)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        COALESCE(o.metadata->'files','[]'::jsonb)) f WHERE f->'metadata'->>'kind'='ATTACHMENT')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        COALESCE(o.metadata->'dou'->'parts','[]'::jsonb)) part
        WHERE part->>'hasHighlightImage'='true')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        COALESCE(v.source_metadata->'files','[]'::jsonb)) f WHERE f->'metadata'->>'kind'='ATTACHMENT')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(
        COALESCE(v.source_metadata->'dou'->'parts','[]'::jsonb)) part
        WHERE part->>'hasHighlightImage'='true')
    ),
    (
(NULLIF(btrim(o.metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND public.collection_filter_l11_normalize(o.metadata->'dou'->>'sourceActType')
          <> public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
        AND public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
          NOT LIKE public.collection_filter_l11_normalize(o.metadata->'dou'->>'sourceActType') || ' %')
      OR (NULLIF(btrim(v.source_metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND public.collection_filter_l11_normalize(v.source_metadata->'dou'->>'sourceActType')
          <> public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
        AND public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
          NOT LIKE public.collection_filter_l11_normalize(v.source_metadata->'dou'->>'sourceActType') || ' %')
    ),
    (
      SELECT count(DISTINCT COALESCE(po3.metadata->'dou'->>'section',''))>1
      FROM public.publication_origins po3
      JOIN public.sources src3 ON src3.id=po3.source_id
      WHERE po3.publication_id=p.id AND src3.code='dou'
    ),
    EXISTS (
      SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id
    ),
    EXISTS (
      SELECT 1 FROM public.publication_origins po2
      JOIN public.sources so2 ON so2.id=po2.source_id
      WHERE po2.publication_id=p.id AND so2.code<>'dou'
    ),
    v.content_hash::text
  FROM public.publications p
  JOIN LATERAL (
    SELECT po.metadata
    FROM public.publication_origins po
    JOIN public.sources so ON so.id=po.source_id
    WHERE po.publication_id=p.id AND so.code='dou'
    ORDER BY po.id LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT pv.id,pv.source_metadata,pv.content_text,pv.relevant_excerpt,pv.content_hash
    FROM public.publication_versions pv
    WHERE pv.publication_id=p.id AND pv.is_current
    LIMIT 1
  ) v ON true
  WHERE (p_after IS NULL OR p.id > p_after)
    AND p.act_type IS NOT NULL
    AND public.collection_filter_l11_normalize(p.act_type)=ANY(p_type_keys)
    AND public.collection_filter_l11_normalize(COALESCE(NULLIF(o.metadata->'dou'->>'section',''),
      v.source_metadata->'dou'->>'section','')) = p_section
  ORDER BY p.id LIMIT p_limit;
END;
$$;



GRANT EXECUTE ON FUNCTION public.collection_filter_direct_candidates(UUID,INTEGER,TEXT,TEXT[]) TO radar_worker;

CREATE FUNCTION public.l17_prune_always_batch(
  p_ids UUID[],p_hashes TEXT[],p_policy UUID,p_revision INTEGER,
  p_section TEXT,p_type TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_count INTEGER;v_item UUID;p_operation UUID:=gen_random_uuid();
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 v_count:=cardinality(p_ids);
 IF v_count IS NULL OR v_count<1 OR v_count>20
    OR cardinality(p_hashes)<>v_count
    OR v_count<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
    OR EXISTS(SELECT 1 FROM unnest(p_ids,p_hashes) e(id,h)
       WHERE e.id IS NULL OR e.h IS NULL OR btrim(e.h)='') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_always_batch';
 END IF;
 PERFORM 1 FROM public.collection_filter_policies pol
   WHERE pol.id=p_policy AND pol.status='APPROVED' AND pol.revision=p_revision
   FOR SHARE;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_policy_revision_changed';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.collection_filter_type_rules r
    WHERE r.policy_id=p_policy AND r.source_code='dou' AND r.mode='EXCLUDE_ALWAYS'
      AND public.collection_filter_l11_normalize(r.section)=
          public.collection_filter_l11_normalize(p_section)
      AND public.collection_filter_l11_normalize(r.canonical_type)=
          public.collection_filter_l11_normalize(p_type)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_rule_no_longer_exclude_always';
 END IF;
 PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids)
   ORDER BY p.id FOR UPDATE;
 -- Locking parent synchronizes origin/version material triggers, and verify
 -- original canonical evidence did not change after TypeScript engine pass.
 IF (SELECT count(*) FROM unnest(p_ids,p_hashes) e(id,h)
   JOIN public.publications p ON p.id=e.id
   JOIN public.publication_versions v ON v.publication_id=p.id AND v.is_current
   WHERE NOT p.is_hidden AND public.publication_scope_is_in_scope(p.id)
     AND v.content_hash::text=e.h
     AND EXISTS(SELECT 1 FROM public.publication_origins po
       JOIN public.sources so ON so.id=po.source_id
       WHERE po.publication_id=p.id AND so.code='dou'
         AND public.collection_filter_l11_normalize(
           COALESCE(NULLIF(po.metadata->'dou'->>'section',''),
              v.source_metadata->'dou'->>'section',''))=
             public.collection_filter_l11_normalize(p_section))
     AND NOT EXISTS(SELECT 1 FROM public.publication_origins po
       JOIN public.sources so ON so.id=po.source_id
       WHERE po.publication_id=p.id AND so.code<>'dou')
     AND NOT EXISTS(SELECT 1 FROM public.company_publications cp
       WHERE cp.publication_id=p.id)
     AND (public.collection_filter_l11_normalize(p.act_type)=
          public.collection_filter_l11_normalize(p_type)
       OR EXISTS(SELECT 1 FROM public.collection_filter_type_aliases a
          WHERE a.policy_id=p_policy AND a.source_code='dou'
            AND public.collection_filter_l11_normalize(a.section)=
                public.collection_filter_l11_normalize(p_section)
            AND public.collection_filter_l11_normalize(a.normalized_alias)=
                public.collection_filter_l11_normalize(p.act_type)
            AND public.collection_filter_l11_normalize(a.canonical_type)=
                public.collection_filter_l11_normalize(p_type)))
   )<>v_count THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_always_eligibility_changed';
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
 RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_prune_always_batch(UUID[],TEXT[],UUID,INTEGER,TEXT,TEXT) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_prune_always_batch(UUID[],TEXT[],UUID,INTEGER,TEXT,TEXT) TO radar_worker;

CREATE TABLE public.l17_always_cleanup_daily(
 local_day DATE PRIMARY KEY,
 status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
 deleted_publications INTEGER NOT NULL DEFAULT 0,
 batches INTEGER NOT NULL DEFAULT 0,
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ
);
REVOKE ALL ON public.l17_always_cleanup_daily FROM PUBLIC,radar_app,radar_worker;
CREATE FUNCTION public.l17_claim_always_day() RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_local TIMESTAMP:=now() AT TIME ZONE 'America/Sao_Paulo';
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF v_local::time<TIME '03:30' OR v_local::time>=TIME '03:31' THEN RETURN FALSE;END IF;
 INSERT INTO public.l17_always_cleanup_daily(local_day,status)
 VALUES(v_local::date,'STARTED') ON CONFLICT DO NOTHING;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_claim_always_day() FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_claim_always_day() TO radar_worker;
CREATE FUNCTION public.l17_finish_always_day(p_deleted INTEGER,p_batches INTEGER,p_ok BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF p_deleted<0 OR p_batches<0 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l17_report';
 END IF;
 UPDATE public.l17_always_cleanup_daily SET
  status=CASE WHEN p_ok THEN 'COMPLETED' ELSE 'FAILED' END,
  deleted_publications=p_deleted,batches=p_batches,finished_at=now()
 WHERE local_day=(now() AT TIME ZONE 'America/Sao_Paulo')::date
   AND status='STARTED';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_claim_missing';END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_finish_always_day(INTEGER,INTEGER,BOOLEAN) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_finish_always_day(INTEGER,INTEGER,BOOLEAN) TO radar_worker;

-- Short transaction-scoped lock, exclusively worker-authorized, for
-- final fresh evaluation by the shared TypeScript engine before deletion.
CREATE FUNCTION public.l17_lock_worker_always_targets(p_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n INTEGER:=cardinality(p_ids);
BEGIN
 IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
 END IF;
 IF n IS NULL OR n<1 OR n>20 OR
    n<>(SELECT count(DISTINCT u.id) FROM unnest(p_ids) u(id))
    OR EXISTS(SELECT 1 FROM unnest(p_ids) u(id) WHERE u.id IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='l17_invalid_worker_lock';
 END IF;
 PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids)
  ORDER BY p.id FOR UPDATE;
 IF (SELECT count(*) FROM public.publications p WHERE p.id=ANY(p_ids))<>n THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_worker_lock_targets_changed';
 END IF;
 RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_lock_worker_always_targets(UUID[]) FROM PUBLIC,radar_app;
GRANT EXECUTE ON FUNCTION public.l17_lock_worker_always_targets(UUID[]) TO radar_worker;
