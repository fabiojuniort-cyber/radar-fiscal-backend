-- L-11: retire draft/simulation flows and enable direct, admin-only DOU type rules.
-- DRAFT ONLY. Never apply to production without a reviewed purge implementation and gate.
-- Pre-existing migrations 039/040 are intentionally not modified.
BEGIN;

DROP FUNCTION IF EXISTS public.collection_filter_approve_draft(UUID);
DROP FUNCTION IF EXISTS public.collection_filter_save_draft(JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_request_simulation(UUID,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.collection_filter_claim_simulation(TEXT);
DROP FUNCTION IF EXISTS public.collection_filter_simulation_batch(UUID,TEXT,UUID,INTEGER);
DROP FUNCTION IF EXISTS public.collection_filter_record_simulation_batch(UUID,TEXT,UUID,JSONB,JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_finish_simulation(UUID,TEXT,JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_fail_simulation(UUID,TEXT,TEXT);

DROP TABLE IF EXISTS public.collection_filter_simulation_feedback;
DROP TABLE IF EXISTS public.collection_filter_simulation_items;
DROP TABLE IF EXISTS public.collection_filter_simulations;

-- The published filter is never removed: only abandoned drafts are discarded.
DELETE FROM public.collection_filter_policies WHERE status='DRAFT';
DROP INDEX IF EXISTS public.uq_collection_filter_one_draft;

CREATE OR REPLACE FUNCTION public.collection_filter_direct_set_rule(
  p_source TEXT,
  p_section TEXT,
  p_canonical_type TEXT,
  p_mode TEXT,
  p_new_type_id UUID DEFAULT NULL
)
RETURNS TABLE (policy_id UUID, policy_revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy_id UUID;
  v_revision INTEGER;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF lower(btrim(p_source)) <> 'dou'
     OR COALESCE(btrim(p_section),'') = ''
     OR COALESCE(btrim(p_canonical_type),'') = ''
     OR p_mode NOT IN ('KEEP_ALWAYS','KEEP_IF_TAX_TERM','EXCLUDE_UNLESS_STRONG','EXCLUDE_ALWAYS') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_rule';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-direct-rule',0)
  );
  SELECT p.id INTO v_policy_id
    FROM public.collection_filter_policies p
    WHERE p.status='APPROVED' FOR UPDATE;
  IF v_policy_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='approved_collection_filter_required';
  END IF;

  INSERT INTO public.collection_filter_type_rules (
    policy_id,source_code,section,canonical_type,mode,help_text
  ) VALUES (
    v_policy_id,lower(btrim(p_source)),upper(btrim(p_section)),
    upper(btrim(p_canonical_type)),p_mode,NULL
  )
  ON CONFLICT (policy_id,source_code,section,canonical_type)
  DO UPDATE SET mode=EXCLUDED.mode;

  UPDATE public.collection_filter_policies p
    SET revision=p.revision+1,updated_at=now()
    WHERE p.id=v_policy_id
    RETURNING p.revision INTO v_revision;

  IF p_new_type_id IS NOT NULL THEN
    UPDATE public.collection_filter_new_types n
      SET status='RESOLVED',resolved_canonical_type=upper(btrim(p_canonical_type)),
          resolved_at=now(),resolved_by=v_actor
      WHERE n.id=p_new_type_id
        AND n.source_code=lower(btrim(p_source))
        AND n.section=upper(btrim(p_section));
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='new_type_not_found';
    END IF;
  END IF;

  RETURN QUERY SELECT v_policy_id,v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_direct_set_rule(TEXT,TEXT,TEXT,TEXT,UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_set_rule(TEXT,TEXT,TEXT,TEXT,UUID)
  TO radar_app;


-- Admin-only paging over official DOU records, independent of scope RLS.
-- The application performs the decision with its existing TS filter engine.
CREATE OR REPLACE FUNCTION public.collection_filter_direct_candidates(
  p_after UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  publication_id UUID,
  title TEXT,
  act_type TEXT,
  section TEXT,
  content_text TEXT,
  relevant_excerpt TEXT,
  source_act_type TEXT,
  has_material BOOLEAN,
  has_company BOOLEAN,
  content_hash TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $
BEGIN
  IF public.app_current_user_id() IS NULL
     OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_page_limit';
  END IF;

  RETURN QUERY
  SELECT p.id,p.title,p.act_type,
         COALESCE(v.source_metadata->'dou'->>'section',o.metadata->'dou'->>'section',''),
         v.content_text,v.relevant_excerpt,
         COALESCE(v.source_metadata->'dou'->>'sourceActType',o.metadata->'dou'->>'sourceActType'),
         EXISTS (
           SELECT 1 FROM public.publication_files pf
           WHERE pf.publication_version_id=v.id
             AND COALESCE(lower(pf.mime_type),'') NOT IN ('text/html','application/xml','text/xml')
         ),
         EXISTS (
           SELECT 1 FROM public.company_publications cp
           WHERE cp.publication_id=p.id
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
  ORDER BY p.id LIMIT p_limit;
END;
$;
REVOKE ALL ON FUNCTION public.collection_filter_direct_candidates(UUID,INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_candidates(UUID,INTEGER)
  TO radar_app;

COMMIT;
