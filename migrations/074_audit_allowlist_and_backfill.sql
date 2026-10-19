-- R7 installs policy, guard and a separate batch entrypoint. NO historical UPDATE.
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS audit_policy_version SMALLINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_audit_r7_pending ON public.audit_log(id) WHERE audit_policy_version=0;
CREATE INDEX IF NOT EXISTS ix_audit_r7_company_event ON public.audit_log(tenant_id,entity_type,entity_id,action);

CREATE OR REPLACE FUNCTION public.audit_event_policy(p_action TEXT,p_type TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $policy$
 SELECT $json${"COMPANY_CREATED|company":{"company_id":"uuid","is_active":"bool","version":"int"},"COMPANY_UPDATED|company":{"company_id":"uuid","is_active":"bool","version":"int"},"COMPANY_PURGED|company":{"purged":"bool"},"ESTABLISHMENT_CREATED|establishment":{"company_id":"uuid","is_active":"bool"},"ESTABLISHMENT_UPDATED|establishment":{"company_id":"uuid","is_active":"bool"},"ESTABLISHMENT_DELETED|establishment":{"company_id":"uuid","is_active":"bool"},"COMPANY_TAX_PROFILE_UPDATED|company_tax_profile":{"company_id":"uuid","version":"int"},"COMPANY_PRODUCT_PROFILE_UPDATED|company_product_profile":{"company_id":"uuid","is_active":"bool"},"PLATFORM_ROLE_GRANTED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"]},"PLATFORM_ROLE_REVOKED|platform_user_role":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"]},"PLATFORM_ROLE_GRANTED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"]},"PLATFORM_ROLE_REVOKED|app_user":{"role":["PLATFORM_ADMIN","TAXONOMY_CURATOR"]},"COLLECTION_FILTER_DRAFT_SAVED|collection_filter_policy":{"version":"int","revision":"int"},"COLLECTION_FILTER_SIMULATION_REQUESTED|collection_filter_simulation":{"policyId":"uuid","version":"int","revision":"int","scope":["SAMPLE","FULL_ARCHIVE","FULL_HISTORY","ALL"],"reviewMode":["PREVIEW","APPROVAL","REVIEW","SAMPLE","FULL"]},"COLLECTION_FILTER_POLICY_APPROVED|collection_filter_policy":{"version":"int","revision":"int","simulationId":"uuid"},"COLLECTION_FILTER_DIRECT_ADMIN_EDIT|collection_filter_policy":{"policyRevision":"int","action":["RULE_KEEP","RULE_DELETE","TERM_PUT","TERM_DELETE","ALIAS_PUT","ALIAS_DELETE","NEWTYPE_MERGE","NEWTYPE_KEEP"]},"COLLECTION_FILTER_DIRECT_RULE_CHANGED|collection_filter_type_rule":{"policyRevision":"int","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"]},"COLLECTION_FILTER_DIRECT_PURGE|collection_filter_type_rule":{"deletedCount":"int","deletedIds":"uuids","mode":["KEEP_ALWAYS","KEEP_IF_TAX_TERM","EXCLUDE_UNLESS_STRONG","EXCLUDE_ALWAYS","EXCLUDE_ONCE"]},"L17_HIDDEN_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"]},"L17_RULE_PURGE|publications":{"deletedCount":"int","deletedIds":"uuids","policyId":"uuid","policyRevision":"int","mode":["RETENTION","EXCLUDE_ALWAYS"]},"L18_PRESERVATION_RULES|collection_filter_policy":{"policyId":"uuid","policyRevision":"int","changedRuleCount":"int","addedStrongTerms":"int"},"BASELINE_IMPORT_STARTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"]},"BASELINE_IMPORT_FAILED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"]},"BASELINE_IMPORT_VALIDATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"]},"BASELINE_IMPORT_COMMITTED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"]},"TAXONOMY_RELEASE_CREATED|taxonomy_baseline":{"manifestSha256":"sha256","derivationFingerprint":"sha256","status":["DRAFT","PUBLISHED"]},"TAXONOMY_SUCCESSOR_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"]},"TAXONOMY_RELEASE_CREATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"]},"TAXONOMY_RELEASE_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"]},"TAXONOMY_SUCCESSOR_PUBLISHED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"]},"TAXONOMY_RELEASE_VALIDATED|taxonomy_release":{"manifestSha256":"sha256","snapshotSha256":"sha256","sourceReleaseId":"uuid","status":["DRAFT","PUBLISHED"]},"TAXONOMY_CURATION_DRAFT_CREATED|taxonomy_curation":{"sourceReleaseId":"uuid","initialCuration":"bool"},"TAXONOMY_CURATION_DIMENSION_UPDATED|taxonomy_curation":{},"TAXONOMY_CURATION_DIMENSION_RETIRED|taxonomy_curation":{},"TAXONOMY_CURATION_CONCEPT_CREATED|taxonomy_curation":{},"TAXONOMY_CURATION_CONCEPT_UPDATED|taxonomy_curation":{},"TAXONOMY_RUNTIME_SETTING_UPDATED|taxonomy_curation":{},"TAXONOMY_CURATION_GROUP_CREATED|taxonomy_curation":{"groupId":"uuid"},"TAXONOMY_CURATION_GROUP_UPDATED|taxonomy_curation":{"groupId":"uuid"},"TAXONOMY_CURATION_GROUP_DELETED|taxonomy_curation":{"groupId":"uuid"},"TAXONOMY_CURATION_IMPORT|taxonomy_curation":{"rows":"int","created":"int","updated":"int","errors":"int"},"TAXONOMY_CURATION_GRID_SAVE|taxonomy_curation":{"created":"int","updated":"int","retired":"int","groupsCreated":"int","groupsUpdated":"int"},"TAXONOMY_CURATION_PUBLISHED|taxonomy_curation":{"snapshotSha256":"sha256"},"F2_T02_ACTUACAO_INITIALIZED|taxonomy_curation":{"seedSha256":"sha256"},"F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED|taxonomy_curation":{"sourceSha256":"sha256","projectionSha256":"sha256","originCount":"int","publicationRequested":"bool"},"TAXONOMY_F2_SUGGESTIONS_CHANGED|taxonomy_curation":{"productsCount":"int","ncmsCount":"int"},"F2_TAB03_CNAE_ACTUACOES_CHANGED|taxonomy_curation":{"published":"bool"},"OFFICIAL_CATALOG_IMPORTED|official_catalog_edition":{"editionId":"uuid","inserted":"int","updated":"int","total":"int","sourceSha256":"sha256"},"PUBLICATION_TAG_CURATED|publication":{"action":["ADD","REMOVE","RESTORE"]},"PUBLICATION_PRESENTATION_REFRESHED|publication_version":{"savedPageSha256":"sha256","htmlChars":"int","effectiveUntil":"date"},"TAXONOMY_V1_1_DRAFT_CREATED|taxonomy_release":{"sourceReleaseId":"uuid"},"TAXONOMY_V1_1_PUBLISHED|taxonomy_release":{"artifactSha256":"sha256"}}$json$::jsonb -> (p_action||'|'||p_type)
$policy$;

CREATE OR REPLACE FUNCTION public.audit_entity_reference(p_value TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE SET search_path=pg_catalog AS $ref$
 SELECT CASE WHEN p_value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN lower(p_value) ELSE NULL END
$ref$;

-- Flat, typed fields only. No arbitrary strings, nested payloads, messages or keys.
-- Used explicitly by the existing writer adapters and the separately run backfill.
CREATE OR REPLACE FUNCTION public.audit_project(p_action TEXT,p_type TEXT,p_json JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $project$
DECLARE v_rules JSONB:=public.audit_event_policy(p_action,p_type);
 v_out JSONB:='{}'; v_key TEXT; v_rule JSONB; v_value JSONB; v_ok BOOLEAN;
BEGIN
 IF p_json IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(p_json)<>'object' OR v_rules IS NULL THEN RETURN '{}'::jsonb; END IF;
 FOR v_key,v_rule IN SELECT key,value FROM jsonb_each(v_rules) LOOP
  v_value:=p_json->v_key; v_ok:=false;
  IF v_value IS NULL THEN CONTINUE; END IF;
  IF jsonb_typeof(v_rule)='array' THEN
    v_ok:=jsonb_typeof(v_value)='string' AND v_rule @> jsonb_build_array(v_value);
  ELSIF v_rule='"bool"'::jsonb THEN v_ok:=jsonb_typeof(v_value)='boolean';
  ELSIF v_rule='"int"'::jsonb THEN
    v_ok:=jsonb_typeof(v_value)='number' AND v_value::text ~ '^[0-9]{1,12}$';
  ELSIF v_rule='"uuid"'::jsonb THEN
    v_ok:=jsonb_typeof(v_value)='string' AND (v_value#>>'{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  ELSIF v_rule='"sha256"'::jsonb THEN
    v_ok:=jsonb_typeof(v_value)='string' AND (v_value#>>'{}') ~ '^[0-9a-fA-F]{64}$';
  ELSIF v_rule='"date"'::jsonb THEN
    v_ok:=jsonb_typeof(v_value)='string' AND (v_value#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  ELSIF v_rule='"uuids"'::jsonb AND jsonb_typeof(v_value)='array' THEN
    v_ok:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_value) e
      WHERE jsonb_typeof(e)<>'string' OR NOT (e#>>'{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
  END IF;
  IF v_ok THEN v_out:=v_out||jsonb_build_object(v_key,v_value); END IF;
 END LOOP;
 RETURN v_out;
END;
$project$;

CREATE OR REPLACE FUNCTION public.audit_allowlist_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $guard$
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.audit_event_policy(NEW.action,NEW.entity_type) IS NULL THEN
    RAISE EXCEPTION 'audit_event_not_registered' USING ERRCODE='23514';
  END IF;
 ELSE
  -- Runtime roles have no UPDATE. Only the table owner may transform legacy rows,
  -- preserving immutable headers and using exactly the event's canonical projection.
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.audit_log'::regclass)
     OR OLD.audit_policy_version<>0
     OR (to_jsonb(NEW)-ARRAY['entity_id','before_data','after_data','audit_policy_version','request_id'])
       IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['entity_id','before_data','after_data','audit_policy_version','request_id'])
     OR NEW.entity_id IS DISTINCT FROM public.audit_entity_reference(OLD.entity_id)
     OR NEW.before_data IS DISTINCT FROM public.audit_project(OLD.action,OLD.entity_type,OLD.before_data)
     OR NEW.after_data IS DISTINCT FROM public.audit_project(OLD.action,OLD.entity_type,OLD.after_data)
     OR NEW.request_id IS DISTINCT FROM public.audit_entity_reference(OLD.request_id)
  THEN RAISE EXCEPTION 'audit_immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.entity_id IS NOT NULL AND public.audit_entity_reference(NEW.entity_id) IS NULL THEN
   RAISE EXCEPTION 'audit_invalid_reference' USING ERRCODE='23514';
 END IF;
 IF NEW.request_id IS NOT NULL AND public.audit_entity_reference(NEW.request_id) IS NULL THEN
   RAISE EXCEPTION 'audit_invalid_request_reference' USING ERRCODE='23514';
 END IF;
 IF NEW.before_data IS DISTINCT FROM public.audit_project(NEW.action,NEW.entity_type,NEW.before_data)
    OR NEW.after_data IS DISTINCT FROM public.audit_project(NEW.action,NEW.entity_type,NEW.after_data)
 THEN RAISE EXCEPTION 'audit_field_not_allowed' USING ERRCODE='23514'; END IF;
 NEW.audit_policy_version:=1;
 RETURN NEW;
END;
$guard$;
DROP TRIGGER IF EXISTS audit_allowlist_guard ON public.audit_log;
CREATE TRIGGER audit_allowlist_guard BEFORE INSERT OR UPDATE ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public.audit_allowlist_guard();

CREATE TABLE IF NOT EXISTS public.audit_backfill_checkpoint(
 job_key TEXT PRIMARY KEY CHECK(job_key='onb02-r7-v1'),
 processed BIGINT NOT NULL DEFAULT 0,
 last_batch_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
REVOKE ALL ON public.audit_backfill_checkpoint FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator;

CREATE OR REPLACE FUNCTION public.audit_backfill_batch(p_limit INTEGER DEFAULT 5000)
RETURNS TABLE(processed INTEGER,remaining BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $batch$
DECLARE v_count INTEGER; v_remaining BIGINT;
BEGIN
 IF p_limit<1 OR p_limit>10000 THEN RAISE EXCEPTION 'invalid_batch_limit'; END IF;
 INSERT INTO public.audit_backfill_checkpoint(job_key) VALUES('onb02-r7-v1') ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.audit_backfill_checkpoint WHERE job_key='onb02-r7-v1' FOR UPDATE;
 WITH picked AS MATERIALIZED (
   SELECT id FROM public.audit_log WHERE audit_policy_version=0 ORDER BY id
   LIMIT p_limit FOR UPDATE
 ), changed AS (
   UPDATE public.audit_log a SET
     entity_id=public.audit_entity_reference(a.entity_id),
     request_id=public.audit_entity_reference(a.request_id),
     before_data=public.audit_project(a.action,a.entity_type,a.before_data),
     after_data=public.audit_project(a.action,a.entity_type,a.after_data),
     audit_policy_version=1
   FROM picked WHERE a.id=picked.id RETURNING a.id
 ) SELECT count(*)::int INTO v_count FROM changed;
 SELECT count(*) INTO v_remaining FROM public.audit_log WHERE audit_policy_version=0;
 UPDATE public.audit_backfill_checkpoint SET processed=audit_backfill_checkpoint.processed+v_count,
   last_batch_at=clock_timestamp(),
   completed_at=CASE WHEN v_remaining=0 THEN clock_timestamp() ELSE NULL END
 WHERE job_key='onb02-r7-v1';
 RETURN QUERY SELECT v_count,v_remaining;
END;
$batch$;
REVOKE ALL ON FUNCTION public.audit_backfill_batch(INTEGER) FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator;

-- Existing SQL writers now project to each explicit event policy before INSERT.
CREATE OR REPLACE FUNCTION platform_admin_grant_by_email(
    p_email TEXT
)
RETURNS TABLE (
    action TEXT,
    target_user_id UUID,
    target_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID;
    v_target public.app_users%ROWTYPE;
    v_existing UUID;
BEGIN
    v_actor := public.app_current_user_id();

    IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'platform_admin_required';
    END IF;

    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'platform_admin_email_required';
    END IF;

    SELECT u.*
      INTO v_target
      FROM public.app_users u
     WHERE lower(u.email) = lower(btrim(p_email));

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_not_found';
    END IF;

    IF v_target.status <> 'ACTIVE' THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_inactive';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('platform-admin-role', 0)
    );

    SELECT r.id
      INTO v_existing
      FROM public.platform_user_roles r
     WHERE r.user_id = v_target.id
       AND r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
     LIMIT 1;

    IF v_existing IS NOT NULL THEN
        RETURN QUERY
        SELECT 'ALREADY_GRANTED'::TEXT, v_target.id, v_target.email;
        RETURN;
    END IF;

    INSERT INTO public.platform_user_roles (
        user_id,
        role,
        granted_by
    ) VALUES (
        v_target.id,
        'PLATFORM_ADMIN',
        'app:' || v_actor::TEXT
    );

    INSERT INTO public.audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        after_data,
        correlation_id
    ) VALUES (
    NULL,
    'ADMIN',
    v_actor::TEXT,
    'PLATFORM_ROLE_GRANTED',
    'platform_user_role',
    public.audit_entity_reference((v_target.id::TEXT)::text),
    public.audit_project('PLATFORM_ROLE_GRANTED','platform_user_role',pg_catalog.jsonb_build_object('role', 'PLATFORM_ADMIN')),
    pg_catalog.gen_random_uuid()
);

    RETURN QUERY
    SELECT 'GRANTED'::TEXT, v_target.id, v_target.email;
END;
$$;

CREATE OR REPLACE FUNCTION platform_admin_revoke_by_email(
    p_email TEXT
)
RETURNS TABLE (
    action TEXT,
    target_user_id UUID,
    target_email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID;
    v_target public.app_users%ROWTYPE;
    v_existing UUID;
    v_active_admins BIGINT;
BEGIN
    v_actor := public.app_current_user_id();

    IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
        RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'platform_admin_required';
    END IF;

    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'platform_admin_email_required';
    END IF;

    SELECT u.*
      INTO v_target
      FROM public.app_users u
     WHERE lower(u.email) = lower(btrim(p_email));

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'platform_admin_user_not_found';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('platform-admin-role', 0)
    );

    SELECT r.id
      INTO v_existing
      FROM public.platform_user_roles r
     WHERE r.user_id = v_target.id
       AND r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
     LIMIT 1;

    IF v_existing IS NULL THEN
        RETURN QUERY
        SELECT 'NOT_GRANTED'::TEXT, v_target.id, v_target.email;
        RETURN;
    END IF;

    SELECT count(*)
      INTO v_active_admins
      FROM public.platform_user_roles r
      JOIN public.app_users u
        ON u.id = r.user_id
     WHERE r.role = 'PLATFORM_ADMIN'
       AND r.revoked_at IS NULL
       AND u.status = 'ACTIVE';

    IF v_target.status = 'ACTIVE' AND v_active_admins <= 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'last_platform_admin';
    END IF;

    UPDATE public.platform_user_roles
       SET revoked_at = now(),
           revoked_by = 'app:' || v_actor::TEXT
     WHERE id = v_existing;

    INSERT INTO public.audit_log (
        tenant_id,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        correlation_id
    ) VALUES (
    NULL,
    'ADMIN',
    v_actor::TEXT,
    'PLATFORM_ROLE_REVOKED',
    'platform_user_role',
    public.audit_entity_reference((v_target.id::TEXT)::text),
    public.audit_project('PLATFORM_ROLE_REVOKED','platform_user_role',pg_catalog.jsonb_build_object('role', 'PLATFORM_ADMIN')),
    pg_catalog.gen_random_uuid()
);

    RETURN QUERY
    SELECT 'REVOKED'::TEXT, v_target.id, v_target.email;
END;
$$;




CREATE OR REPLACE FUNCTION public.collection_filter_direct_admin_edit(
  p_action TEXT, p_payload JSONB
)
RETURNS TABLE(policy_revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy UUID;
  v_revision INTEGER;
  v_source TEXT := lower(btrim(coalesce(p_payload->>'sourceCode','')));
  v_section TEXT := upper(btrim(coalesce(p_payload->>'section','')));
  v_type TEXT := upper(btrim(coalesce(p_payload->>'canonicalType','')));
  v_mode TEXT := p_payload->>'mode';
  v_old JSONB := p_payload->'old';
  v_term JSONB := p_payload->'term';
  v_old_term JSONB := p_payload->'oldTerm';
  v_new_type_id UUID;
  v_term_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_edit';
  END IF;

  -- Serialize with direct-rule preview/confirm, preventing concurrent edits.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-direct-rule',0)
  );
  SELECT p.id INTO v_policy FROM public.collection_filter_policies p
    WHERE p.status='APPROVED' FOR UPDATE;
  IF v_policy IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='approved_collection_filter_required';
  END IF;

  IF p_action='RULE_KEEP' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR v_mode<>'KEEP_ALWAYS' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='only_non_discard_rule_edit_allowed';
    END IF;
    INSERT INTO public.collection_filter_type_rules(
      policy_id,source_code,section,canonical_type,mode,help_text)
      VALUES(v_policy,v_source,v_section,v_type,v_mode,NULL)
    ON CONFLICT(policy_id,source_code,section,canonical_type)
      DO UPDATE SET mode=EXCLUDED.mode;

  ELSIF p_action='RULE_DELETE' THEN
    IF v_source='' OR v_section='' OR v_type='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_rule_identity';
    END IF;
    DELETE FROM public.collection_filter_type_rules
      WHERE policy_id=v_policy AND source_code=v_source
        AND section=v_section AND canonical_type=v_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_rule_not_found';
    END IF;

  ELSIF p_action='TERM_PUT' THEN
    IF v_term IS NULL OR btrim(coalesce(v_term->>'text',''))=''
       OR btrim(coalesce(v_term->>'normalizedTerm',''))=''
       OR v_term->>'strength' NOT IN('STRONG','WEAK','NEGATIVE')
       OR coalesce(v_term->>'locationScope','ANY') NOT IN
            ('ANY','TITLE','SUMMARY','BODY') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_term';
    END IF;
    IF v_old_term IS NOT NULL THEN
      SELECT t.id INTO v_term_id FROM public.collection_filter_terms t
      WHERE t.policy_id=v_policy
        AND t.normalized_term=v_old_term->>'normalizedTerm'
        AND t.strength=v_old_term->>'strength'
        AND coalesce(t.source_code,'')=coalesce(v_old_term->>'sourceCode','')
        AND coalesce(t.section,'')=coalesce(v_old_term->>'section','')
        AND coalesce(t.canonical_type,'')=coalesce(v_old_term->>'canonicalType','')
        AND t.location_scope=coalesce(v_old_term->>'locationScope','ANY')
      FOR UPDATE;
      IF v_term_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_term_not_found';
      END IF;
      UPDATE public.collection_filter_terms SET
        term_text=btrim(v_term->>'text'),
        normalized_term=v_term->>'normalizedTerm',
        strength=v_term->>'strength',
        source_code=nullif(lower(btrim(coalesce(v_term->>'sourceCode',''))),''),
        section=nullif(upper(btrim(coalesce(v_term->>'section',''))),''),
        canonical_type=nullif(upper(btrim(coalesce(v_term->>'canonicalType',''))),''),
        location_scope=coalesce(v_term->>'locationScope','ANY')
      WHERE id=v_term_id;
    ELSE
      INSERT INTO public.collection_filter_terms(
        policy_id,term_text,normalized_term,strength,
        source_code,section,canonical_type,location_scope
      ) VALUES(
        v_policy,btrim(v_term->>'text'),v_term->>'normalizedTerm',
        v_term->>'strength',
        nullif(lower(btrim(coalesce(v_term->>'sourceCode',''))),''),
        nullif(upper(btrim(coalesce(v_term->>'section',''))),''),
        nullif(upper(btrim(coalesce(v_term->>'canonicalType',''))),''),
        coalesce(v_term->>'locationScope','ANY')
      );
    END IF;

  ELSIF p_action='TERM_DELETE' THEN
    IF v_old_term IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='term_identity_required';
    END IF;
    DELETE FROM public.collection_filter_terms t
      WHERE t.policy_id=v_policy
        AND t.normalized_term=v_old_term->>'normalizedTerm'
        AND t.strength=v_old_term->>'strength'
        AND coalesce(t.source_code,'')=coalesce(v_old_term->>'sourceCode','')
        AND coalesce(t.section,'')=coalesce(v_old_term->>'section','')
        AND coalesce(t.canonical_type,'')=coalesce(v_old_term->>'canonicalType','')
        AND t.location_scope=coalesce(v_old_term->>'locationScope','ANY');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_term_not_found';
    END IF;

  ELSIF p_action='ALIAS_PUT' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR btrim(coalesce(p_payload->>'alias',''))='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_alias';
    END IF;
    INSERT INTO public.collection_filter_type_aliases(
      policy_id,source_code,section,normalized_alias,canonical_type
    ) VALUES(
      v_policy,v_source,v_section,upper(btrim(p_payload->>'alias')),v_type)
    ON CONFLICT(policy_id,source_code,section,normalized_alias)
      DO UPDATE SET canonical_type=EXCLUDED.canonical_type;

  ELSIF p_action='ALIAS_DELETE' THEN
    DELETE FROM public.collection_filter_type_aliases
      WHERE policy_id=v_policy AND source_code=v_source AND section=v_section
        AND normalized_alias=upper(btrim(coalesce(p_payload->>'alias','')));
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_alias_not_found';
    END IF;

  ELSIF p_action='NEWTYPE_MERGE' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR btrim(coalesce(p_payload->>'alias',''))='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_merge';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.collection_filter_type_rules
      WHERE policy_id=v_policy AND source_code=v_source
        AND section=v_section AND canonical_type=v_type) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='merge_target_not_found';
    END IF;
    v_new_type_id=(p_payload->>'newTypeId')::uuid;
    UPDATE public.collection_filter_new_types
      SET status='MERGED',resolved_canonical_type=v_type, resolved_at=now(),
          resolved_by=v_actor
      WHERE id=v_new_type_id AND source_code=v_source AND section=v_section
        AND status='OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='open_new_type_not_found';
    END IF;
    INSERT INTO public.collection_filter_type_aliases(
      policy_id,source_code,section,normalized_alias,canonical_type)
      VALUES(v_policy,v_source,v_section,
        upper(btrim(p_payload->>'alias')),v_type)
      ON CONFLICT(policy_id,source_code,section,normalized_alias)
        DO UPDATE SET canonical_type=EXCLUDED.canonical_type;

  ELSIF p_action='NEWTYPE_KEEP' THEN
    IF v_source='' OR v_section='' OR v_type='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_new_type_keep';
    END IF;
    v_new_type_id=(p_payload->>'newTypeId')::uuid;
    UPDATE public.collection_filter_new_types
      SET status='RESOLVED',resolved_canonical_type=v_type,resolved_at=now(),
          resolved_by=v_actor
      WHERE id=v_new_type_id AND source_code=v_source AND section=v_section
        AND status='OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='open_new_type_not_found';
    END IF;
    INSERT INTO public.collection_filter_type_rules(
      policy_id,source_code,section,canonical_type,mode,help_text)
      VALUES(v_policy,v_source,v_section,v_type,'KEEP_ALWAYS',NULL)
    ON CONFLICT(policy_id,source_code,section,canonical_type)
      DO UPDATE SET mode='KEEP_ALWAYS';

  ELSE
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unsupported_direct_edit';
  END IF;

  UPDATE public.collection_filter_policies
    SET revision=revision+1,updated_at=now()
    WHERE id=v_policy RETURNING revision INTO v_revision;
  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,
    'ADMIN',
    v_actor::text,
    'COLLECTION_FILTER_DIRECT_ADMIN_EDIT',
    'collection_filter_policy',
    public.audit_entity_reference((v_policy::text)::text),
    public.audit_project('COLLECTION_FILTER_DIRECT_ADMIN_EDIT','collection_filter_policy',pg_catalog.jsonb_build_object(
      'action',p_action,'policyRevision',v_revision,
      'payload',p_payload
    )),
    pg_catalog.gen_random_uuid()
);
  RETURN QUERY SELECT v_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.l17_prune_hidden_batch(p_limit INTEGER)
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
 VALUES(
    NULL,
    'SYSTEM',
    'l17:scheduler',
    'L17_HIDDEN_PURGE',
    'publications',
    public.audit_entity_reference(('LEGACY_HIDDEN')::text),
    public.audit_project('L17_HIDDEN_PURGE','publications',pg_catalog.jsonb_build_object(
     'sourceCode','dou','mode','RETENTION','deletedCount',v_count,'deletedIds',p_ids
   )),
    p_operation
);
 RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.l17_prune_always_batch(
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
 INSERT INTO public.audit_log(
   tenant_id,actor_type,actor_id,action,entity_type,entity_id,
   after_data,correlation_id
 ) VALUES(
    NULL,
    'SYSTEM',
    'l17:scheduler',
    'L17_RULE_PURGE',
    'publications',
    public.audit_entity_reference((p_type)::text),
    public.audit_project('L17_RULE_PURGE','publications',pg_catalog.jsonb_build_object(
     'sourceCode','dou','section',p_section,
     'canonicalType',p_type,'mode','EXCLUDE_ALWAYS',
     'policyId',p_policy,'policyRevision',p_revision,
     'deletedCount',v_count,'deletedIds',p_ids
   )),
    p_operation
);
 RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.collection_filter_direct_set_rule(
  p_source TEXT,
  p_section TEXT,
  p_canonical_type TEXT,
  p_mode TEXT,
  p_new_type_id UUID DEFAULT NULL
)
RETURNS TABLE (policy_id UUID, policy_revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy_id UUID;
  v_revision INTEGER;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF lower(btrim(p_source)) NOT IN ('dou','doe-sp')
     OR p_section IS NULL
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

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,
    'ADMIN',
    v_actor::text,
    'COLLECTION_FILTER_DIRECT_RULE_CHANGED',
    'collection_filter_type_rule',
    public.audit_entity_reference((upper(btrim(p_canonical_type)))::text),
    public.audit_project('COLLECTION_FILTER_DIRECT_RULE_CHANGED','collection_filter_type_rule',pg_catalog.jsonb_build_object(
      'sourceCode',lower(btrim(p_source)),'section',upper(btrim(p_section)),
      'canonicalType',upper(btrim(p_canonical_type)),'mode',p_mode,
      'policyRevision',v_revision
    )),
    pg_catalog.gen_random_uuid()
);
  RETURN QUERY SELECT v_policy_id,v_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.collection_filter_direct_purge_batch(
  p_ids UUID[],p_source TEXT,p_section TEXT,p_type TEXT,p_mode TEXT,
  p_operation UUID
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_count INTEGER;
  v_item UUID;
  v_legacy_hidden BOOLEAN := upper(btrim(p_section))='L18_LEGACY_029'
    AND upper(btrim(p_type))='HIDDEN_LEGACY' AND p_mode='EXCLUDE_ALWAYS';
  v_doe_type BOOLEAN := lower(btrim(p_source))='doe-sp'
    AND upper(btrim(p_section))='L18_TYPE_MISMATCH'
    AND upper(btrim(p_type))='EMENDA CONSTITUCIONAL'
    AND p_mode='EXCLUDE_ALWAYS';
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  v_count := cardinality(p_ids);
  IF v_count=0 THEN
    INSERT INTO public.audit_log(
      tenant_id,actor_type,actor_id,action,entity_type,entity_id,
      after_data,correlation_id
    ) VALUES (
    NULL,
    'ADMIN',
    v_actor::text,
    'COLLECTION_FILTER_DIRECT_PURGE',
    'collection_filter_type_rule',
    public.audit_entity_reference((upper(btrim(p_type)))::text),
    public.audit_project('COLLECTION_FILTER_DIRECT_PURGE','collection_filter_type_rule',pg_catalog.jsonb_build_object(
        'sourceCode',lower(btrim(p_source)),
        'section',upper(btrim(p_section)),
        'canonicalType',upper(btrim(p_type)),
        'mode',p_mode,'deletedCount',0,'deletedIds','[]'::jsonb
      )),
    p_operation
);
    RETURN 0;
  END IF;
  IF v_count>100 OR v_count<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
     OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_purge_batch';
  END IF;
  -- Non-DOU sources only via the two exact approved L-18 groups.
  IF lower(btrim(p_source)) NOT IN ('dou','doe-sp') AND NOT v_legacy_hidden THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='only_l18_special_non_dou_supported';
  END IF;
  IF v_legacy_hidden OR v_doe_type THEN
    IF EXISTS(SELECT 1 FROM public.publications p
      WHERE p.id=ANY(p_ids) AND (
        (v_legacy_hidden AND NOT p.is_hidden)
        OR (v_doe_type AND NOT (
          NOT p.is_hidden AND p.act_type='EMENDA CONSTITUCIONAL'
          AND btrim(p.title) NOT ILIKE 'Emenda Constitucional%'
          AND NOT EXISTS(SELECT 1 FROM public.publication_scope_state ss
            WHERE ss.publication_id=p.id AND ss.scope<>'IN_SCOPE')
        ))
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l18_special_eligibility_changed';
    END IF;
    IF EXISTS(SELECT 1 FROM public.publications p WHERE p.id=ANY(p_ids)
      AND (SELECT count(DISTINCT po.source_id) FROM public.publication_origins po
        WHERE po.publication_id=p.id)<>1
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l18_multiple_or_missing_origins';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.company_publications cp
            WHERE cp.publication_id=ANY(p_ids)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='company_publication_protected';
  END IF;
  -- A DOU-only filter must not destroy another official source's provenance.
  IF EXISTS(
    SELECT 1 FROM public.publication_origins po
    JOIN public.sources s ON s.id=po.source_id
    WHERE po.publication_id=ANY(p_ids) AND s.code<>lower(btrim(p_source))
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='cross_source_publication_protected';
  END IF;
  -- Freeze the approved revision used by the TS decision, never classify in SQL.
  IF NOT (v_legacy_hidden OR v_doe_type) THEN
    PERFORM 1 FROM public.collection_filter_policies pol
      WHERE pol.status='APPROVED'
        AND pol.revision::text=current_setting('app.collection_filter_confirmed_revision',true)
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='f3_confirmed_policy_revision_required';
    END IF;
  END IF;
  -- Lock parents; a concurrent tenant match must not be created during purge.
  PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids) FOR UPDATE;
  IF (SELECT count(*) FROM public.publications WHERE id=ANY(p_ids))<>v_count
     OR EXISTS(
       SELECT 1 FROM public.publications p
       WHERE p.id=ANY(p_ids) AND NOT EXISTS (
         SELECT 1 FROM public.publication_origins po
         JOIN public.sources s ON s.id=po.source_id
         WHERE po.publication_id=p.id AND s.code=lower(btrim(p_source))
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_purge_targets_changed';
  END IF;
  IF EXISTS(SELECT 1 FROM public.company_publications cp
            WHERE cp.publication_id=ANY(p_ids)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='company_publication_protected';
  END IF;
  -- Revalidate special group identity AFTER locking, not only beforehand.
  IF v_legacy_hidden OR v_doe_type THEN
    IF EXISTS(SELECT 1 FROM public.publications p WHERE p.id=ANY(p_ids)
      AND (
        (v_legacy_hidden AND NOT p.is_hidden)
        OR (v_doe_type AND NOT (
          NOT p.is_hidden AND p.act_type='EMENDA CONSTITUCIONAL'
          AND btrim(p.title) NOT ILIKE 'Emenda Constitucional%'
          AND NOT EXISTS(SELECT 1 FROM public.publication_scope_state ss
            WHERE ss.publication_id=p.id AND ss.scope<>'IN_SCOPE')
        ))
        OR (SELECT count(DISTINCT po.source_id)
              FROM public.publication_origins po WHERE po.publication_id=p.id)<>1
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='l18_special_locked_targets_changed';
    END IF;
  END IF;

  IF EXISTS(SELECT 1 FROM public.publication_origins po
    WHERE po.publication_id=ANY(p_ids)
    GROUP BY po.publication_id HAVING count(*)<>1) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='f3_another_origin_protected';
  END IF;
  IF EXISTS(SELECT 1 FROM public.publication_origins po
    JOIN public.sources s ON s.id=po.source_id
    WHERE po.publication_id=ANY(p_ids) AND s.code<>lower(btrim(p_source))) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='cross_source_publication_protected';
  END IF;
  PERFORM pg_catalog.set_config('app.collection_filter_confirmed_pattern',p_type,true);
  PERFORM pg_catalog.set_config('app.collection_filter_confirmed_mode',p_mode,true);
  PERFORM pg_catalog.set_config('app.collection_filter_l18_origin',lower(btrim(p_source)),true);
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
  PERFORM pg_catalog.set_config('app.collection_filter_l18_origin','',true);

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES (
    NULL,
    'ADMIN',
    v_actor::text,
    'COLLECTION_FILTER_DIRECT_PURGE',
    'collection_filter_type_rule',
    public.audit_entity_reference((upper(btrim(p_type)))::text),
    public.audit_project('COLLECTION_FILTER_DIRECT_PURGE','collection_filter_type_rule',pg_catalog.jsonb_build_object(
      'sourceCode',lower(btrim(p_source)),
      'section',upper(btrim(p_section)),
      'canonicalType',upper(btrim(p_type)),
      'mode',p_mode,'deletedCount',v_count,'deletedIds',p_ids
    )),
    p_operation
);
  RETURN v_count;
END;
$$;
