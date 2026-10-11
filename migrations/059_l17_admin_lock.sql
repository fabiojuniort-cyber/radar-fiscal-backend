-- L-17: lock only a previously selected bounded confirmation batch with
-- owner privileges. radar_app cannot SELECT .. FOR UPDATE on canonical tables.
-- The actor remains a verified PLATFORM_ADMIN, and locks are held until the
-- caller's outer transaction commits. No publication is deleted by this DDL.
CREATE FUNCTION public.l17_lock_confirmation_targets(p_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_count INTEGER;
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  v_count:=cardinality(p_ids);
  IF v_count IS NULL OR v_count<1 OR v_count>500
    OR v_count<>(SELECT count(DISTINCT u.id) FROM unnest(p_ids) u(id))
    OR EXISTS(SELECT 1 FROM unnest(p_ids) u(id) WHERE u.id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='l17_invalid_lock_ids';
  END IF;
  PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids)
    ORDER BY p.id FOR UPDATE;
  IF (SELECT count(*) FROM public.publications p WHERE p.id=ANY(p_ids))<>v_count THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l17_confirmation_targets_changed';
  END IF;
  PERFORM 1 FROM public.publication_scope_state s
    WHERE s.publication_id=ANY(p_ids) ORDER BY s.publication_id FOR UPDATE;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.l17_lock_confirmation_targets(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l17_lock_confirmation_targets(UUID[]) TO radar_app;
