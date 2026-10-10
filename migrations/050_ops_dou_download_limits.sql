-- OPS-DL-01: independent admin settings only. No TAX13 migration 049+.
-- Does not modify any TAX13 schema, legal attestation, DOU scheduler or PDF pipeline.
-- New functions are fail-closed, privileged writes are scoped only to DOU limits.
-- This script belongs to normal schema migration flow on an APPROVED deployment;
-- no direct production execution without required review/test gates.
-- Requires migrations 003,006,009,036, not any R9/TAX13 migration.

CREATE FUNCTION public.platform_admin_set_dou_limits(p_limits jsonb)
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
  v_updated int;
BEGIN
  -- Serialize with platform-admin role changes BEFORE authorizing the actor.
  -- The role-revocation gateway (migration 036) takes the same lock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform-admin-role', 0)
  );
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
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='dou_source_update_not_unique';
  END IF;

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

-- Gate to execute deployment: independent PG16/PG18 and permission validation.
-- Preflight required BEFORE approval:
-- 1. PostgreSQL16/18, radar_app login direct UPDATE sources DENIED, nonadmin EXECUTE DENIED.
-- 2. ACTIVE PLATFORM_ADMIN can change allowed values and audit event is complete.
-- 3. Concurrent admins, last-write-wins serialized with audit; no tenant exposure.
-- 4. Worker read-only SELECT sources works; invalid config => FAIL-CLOSED.
-- 5. No change of source.is_active, schedule, credential, taxonomy or TAX13 R9.
-- 6. Network 404/503/oversize differs from NO_RELEVANT_PUBLICATIONS.
-- 7. No DOU historical rescan/deploy, no migration 049+ or R9 bypass.
