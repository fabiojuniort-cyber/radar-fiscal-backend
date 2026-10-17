-- F3-PERF-02: narrow, revision-only read lock for NON-DESTRUCTIVE save.
-- No archive writes; no session purge authorization flags.
-- Unlike collection_filter_confirm_policy_lock(), this helper never sets
-- app.collection_filter_confirmed_revision.
CREATE OR REPLACE FUNCTION public.collection_filter_safe_save_revision()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_revision INTEGER;
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  SELECT revision INTO v_revision
  FROM public.collection_filter_policies WHERE status='APPROVED' FOR SHARE;
  IF v_revision IS NULL THEN RAISE EXCEPTION 'approved_collection_filter_required'; END IF;
  RETURN v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_safe_save_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_safe_save_revision() TO radar_app;
