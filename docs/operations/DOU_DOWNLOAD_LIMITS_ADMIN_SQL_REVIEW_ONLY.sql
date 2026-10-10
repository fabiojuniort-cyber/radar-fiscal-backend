-- DOU DOWNLOAD LIMITS — DRAFT FOR SECURITY REVIEW ONLY.
-- NOT A MIGRATION 049+, NOT APPROVED, NOT TO BE EXECUTED ON RAILWAY.
-- Owner authorization + independent SQL review required before migration.
-- Existing table: public.sources.connector_config JSONB.
-- Role radar_app has SELECT only on public.sources, never direct UPDATE.
-- SECURITY DEFINER is the ONLY write path; audit and transaction atomic.
-- Values cannot exceed the existing parser hard ceiling. No PDF proof admissions.

CREATE OR REPLACE FUNCTION public.platform_admin_set_dou_limits(p_limits jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $dou_limits$
DECLARE
  v_actor uuid;
  v_limits jsonb;
  v_before jsonb;
  v_pdf int;
  v_zip int;
  v_expand int;
  v_xml int;
BEGIN
  v_actor := public.app_current_user_id();
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;
  IF p_limits IS NULL OR pg_catalog.jsonb_typeof(p_limits) <> 'object'
     OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_limits)) <> 4
     OR NOT (p_limits ?& ARRAY['pdfMiB','zipMiB','expandedZipMiB','xmlEntryMiB'])
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_dou_limits';
  END IF;
  IF (SELECT bool_and(pg_catalog.jsonb_typeof(value)='number'
      AND value::text ~ '^[0-9]{1,3}$')
      FROM pg_catalog.jsonb_each(p_limits)) IS DISTINCT FROM TRUE
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_dou_limits';
  END IF;

  v_pdf := (p_limits->>'pdfMiB')::int;
  v_zip := (p_limits->>'zipMiB')::int;
  v_expand := (p_limits->>'expandedZipMiB')::int;
  v_xml := (p_limits->>'xmlEntryMiB')::int;
  IF v_pdf NOT BETWEEN 1 AND 20
    OR v_zip NOT BETWEEN 1 AND 64
    OR v_expand NOT BETWEEN 1 AND 128
    OR v_xml NOT BETWEEN 1 AND 8
    OR v_expand < v_zip
  THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_dou_limits';
  END IF;
  v_limits := pg_catalog.jsonb_build_object(
    'pdfMiB', v_pdf, 'zipMiB', v_zip,
    'expandedZipMiB', v_expand, 'xmlEntryMiB', v_xml
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-dou-download-limits', 0)
  );
  SELECT s.connector_config -> 'douDownloadLimits'
    INTO v_before
    FROM public.sources AS s
   WHERE s.code='dou' AND s.connector_key='dou'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='dou_source_not_found';
  END IF;
  IF v_before IS NOT DISTINCT FROM v_limits THEN RETURN; END IF;

  UPDATE public.sources AS s
     SET connector_config = s.connector_config ||
       pg_catalog.jsonb_build_object('douDownloadLimits', v_limits),
       updated_at = pg_catalog.now()
   WHERE s.code='dou' AND s.connector_key='dou';

  INSERT INTO public.audit_log(
    tenant_id, actor_type, actor_id, action,
    entity_type, entity_id, before_data, after_data, correlation_id
  ) VALUES (
    NULL, 'ADMIN', v_actor::text, 'DOU_DOWNLOAD_LIMITS_UPDATED',
    'sources.connector_config', 'dou',
    v_before, v_limits, pg_catalog.gen_random_uuid()
  );
END
$dou_limits$;

REVOKE ALL ON FUNCTION public.platform_admin_set_dou_limits(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_admin_set_dou_limits(jsonb) TO radar_app;

-- Preflight required BEFORE approval:
-- 1. PostgreSQL16/18, radar_app login direct UPDATE sources DENIED, nonadmin EXECUTE DENIED.
-- 2. ACTIVE PLATFORM_ADMIN can change allowed values and audit event is complete.
-- 3. Concurrent admins, last-write-wins serialized with audit; no tenant exposure.
-- 4. Worker read-only SELECT sources works; invalid config => FAIL-CLOSED.
-- 5. No change of source.is_active, schedule, credential, taxonomy or TAX13 R9.
-- 6. Network 404/503/oversize differs from NO_RELEVANT_PUBLICATIONS.
-- 7. No DOU historical rescan/deploy, no migration 049+ or R9 bypass.
