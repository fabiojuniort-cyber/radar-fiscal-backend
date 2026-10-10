-- OPS-DL-01 R2: isolated settings-gateway, not a TAX13 / 049 migration.
-- This migration creates NO active credential and authorizes NO collector action.
-- Provision dedicated password + signature secret by the ops provisioning flow.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $role$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='radar_dou_limits_runtime') THEN
   CREATE ROLE radar_dou_limits_runtime NOLOGIN NOINHERIT
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END
$role$;
ALTER ROLE radar_dou_limits_runtime NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO radar_dou_limits_runtime;
DO $connect$
BEGIN
 EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO radar_dou_limits_runtime',current_database());
END
$connect$;

-- Only the migration owner/provisioning superuser can read a signing secret.
-- Never store the secret in source config, audit rows, HTTP logs, GUCs or PRs.
CREATE TABLE public.ops_dou_limits_signing_keys(
 key_id text PRIMARY KEY CHECK(key_id='v1'),
 key_bytes bytea NOT NULL CHECK(pg_catalog.octet_length(key_bytes)=32),
 installed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON public.ops_dou_limits_signing_keys FROM PUBLIC,
 radar_app,radar_worker,radar_dou_limits_runtime;

-- Same transaction as settings UPDATE; prevents replay of valid signed requests.
CREATE TABLE public.ops_dou_limits_used_nonces(
 nonce uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE RESTRICT,
 issued_at bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON public.ops_dou_limits_used_nonces FROM PUBLIC,
 radar_app,radar_worker,radar_dou_limits_runtime;

-- Authenticated API signs the immutable values: no trust in mutable app.user_id.
-- A stolen generic radar_app_runtime SQL connection has no EXECUTE permission.
CREATE FUNCTION public.platform_admin_set_dou_limits(
 p_actor uuid,p_limits jsonb,p_issued_at bigint,p_nonce uuid,p_mac text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,pg_temp AS $gate$
DECLARE
 v_key bytea;
 v_message text;
 v_actor uuid;
 v_before jsonb;
 v_limits jsonb;
 v_pdf int;
 v_zip int;
 v_expand int;
 v_xml int;
 v_rows int;
BEGIN
 IF session_user <> 'radar_dou_limits_runtime' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 IF p_actor IS NULL OR p_nonce IS NULL OR p_issued_at IS NULL
    OR p_mac IS NULL OR p_mac !~ '^[a-f0-9]{64}$'
    OR pg_catalog.abs(pg_catalog.extract(epoch FROM pg_catalog.clock_timestamp())
      -p_issued_at)>90 THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='dou_limits_signature_invalid';
 END IF;
 IF p_limits IS NULL OR pg_catalog.jsonb_typeof(p_limits)<>'object'
    OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_limits))<>4
    OR NOT (p_limits ?& ARRAY['pdfMiB','zipMiB','expandedZipMiB','xmlEntryMiB'])
    OR (SELECT bool_and(pg_catalog.jsonb_typeof(value)='number'
          AND value::text ~ '^[0-9]{1,3}$')
          FROM pg_catalog.jsonb_each(p_limits)) IS DISTINCT FROM TRUE THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_dou_limits';
 END IF;
 v_pdf:=(p_limits->>'pdfMiB')::int;
 v_zip:=(p_limits->>'zipMiB')::int;
 v_expand:=(p_limits->>'expandedZipMiB')::int;
 v_xml:=(p_limits->>'xmlEntryMiB')::int;
 IF v_pdf NOT BETWEEN 1 AND 20 OR v_zip NOT BETWEEN 1 AND 64
    OR v_expand NOT BETWEEN 1 AND 128 OR v_xml NOT BETWEEN 1 AND 8
    OR v_expand<v_zip THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_dou_limits';
 END IF;
 v_limits:=pg_catalog.jsonb_build_object(
   'pdfMiB',v_pdf,'zipMiB',v_zip,'expandedZipMiB',v_expand,'xmlEntryMiB',v_xml
 );
 v_message:='OPS-DL-01/v1|'||p_actor::text||'|'||p_issued_at::text||
   '|'||p_nonce::text||'|'||v_pdf::text||'|'||v_zip::text||
   '|'||v_expand::text||'|'||v_xml::text;
 SELECT key_bytes INTO v_key FROM public.ops_dou_limits_signing_keys WHERE key_id='v1';
 IF v_key IS NULL OR pg_catalog.encode(public.hmac(pg_catalog.convert_to(v_message,'UTF8'),
     v_key,'sha256'),'hex')<>p_mac THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='dou_limits_signature_invalid';
 END IF;

 -- Role administration uses this same lock; a concurrent revocation cannot
 -- interleave between permission evaluation and this COMMIT.
 PERFORM pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('platform-admin-role',0));
 SELECT u.id INTO v_actor FROM public.app_users u
 JOIN public.platform_user_roles r ON r.user_id=u.id
 WHERE u.id=p_actor AND u.status='ACTIVE' AND r.role='PLATFORM_ADMIN'
   AND r.revoked_at IS NULL LIMIT 1;
 IF v_actor IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
 END IF;
 -- No nonce can be reused even with a genuine signature.
 INSERT INTO public.ops_dou_limits_used_nonces(nonce,actor_id,issued_at)
 VALUES(p_nonce,p_actor,p_issued_at);
 PERFORM pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('platform-dou-download-limits',0));
 SELECT s.connector_config->'douDownloadLimits' INTO v_before
 FROM public.sources s WHERE s.code='dou' AND s.connector_key='dou' FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='dou_source_not_found';
 END IF;
 IF v_before IS NOT DISTINCT FROM v_limits THEN RETURN v_limits; END IF;
 UPDATE public.sources s SET connector_config=s.connector_config||
   pg_catalog.jsonb_build_object('douDownloadLimits',v_limits),
   updated_at=pg_catalog.clock_timestamp()
 WHERE s.code='dou' AND s.connector_key='dou';
 GET DIAGNOSTICS v_rows=ROW_COUNT;
 IF v_rows<>1 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='dou_source_update_not_unique';
 END IF;
 INSERT INTO public.audit_log(tenant_id,actor_type,actor_id,action,
  entity_type,entity_id,before_data,after_data,correlation_id)
 VALUES(NULL,'ADMIN',p_actor::text,'DOU_DOWNLOAD_LIMITS_UPDATED',
  'sources.connector_config','dou',v_before,v_limits,pg_catalog.gen_random_uuid());
 RETURN v_limits;
END
$gate$;
REVOKE ALL ON FUNCTION public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)
 FROM PUBLIC,radar_app,radar_worker;
GRANT EXECUTE ON FUNCTION public.platform_admin_set_dou_limits(uuid,jsonb,bigint,uuid,text)
 TO radar_dou_limits_runtime;

-- Capability flag: no signing secret ever reaches the general app runtime.
CREATE FUNCTION public.platform_dou_limits_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $ready$
 SELECT EXISTS(
  SELECT 1 FROM public.ops_dou_limits_signing_keys WHERE key_id='v1'
 )
$ready$;
REVOKE ALL ON FUNCTION public.platform_dou_limits_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_dou_limits_ready() TO radar_app;
