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

COMMIT;
