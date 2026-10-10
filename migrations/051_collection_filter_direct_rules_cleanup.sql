-- L-11: retire draft/simulation flows and enable direct, admin-only DOU type rules.
-- DRAFT ONLY. Never apply to production without a reviewed purge implementation and gate.
-- Pre-existing migrations 039/040 are intentionally not modified.
-- migrate.ts owns BEGIN/COMMIT and records the schema_migrations checksum atomically.

DROP FUNCTION IF EXISTS public.collection_filter_approve_draft(UUID);
DROP FUNCTION IF EXISTS public.collection_filter_save_draft(JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_resolve_new_type(UUID,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.collection_filter_request_simulation(UUID,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.collection_filter_claim_simulation(TEXT);
DROP FUNCTION IF EXISTS public.collection_filter_simulation_batch(UUID,TEXT,UUID,INTEGER);
DROP FUNCTION IF EXISTS public.collection_filter_record_simulation_batch(UUID,TEXT,UUID,JSONB,JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_finish_simulation(UUID,TEXT,JSONB);
DROP FUNCTION IF EXISTS public.collection_filter_fail_simulation(UUID,TEXT,TEXT);

DROP TABLE IF EXISTS public.collection_filter_simulation_feedback;
DROP TABLE IF EXISTS public.collection_filter_simulation_items;
DROP TABLE IF EXISTS public.collection_filter_simulations;

-- L-11: never silently destroy configured draft filters during migration.
-- Fail the entire migration (migrate.ts transaction) if any DRAFT has content.
DO $$
DECLARE
  v_draft RECORD;
BEGIN
  SELECT p.id,p.version,
    (SELECT count(*) FROM public.collection_filter_type_rules r WHERE r.policy_id=p.id) AS rule_count,
    (SELECT count(*) FROM public.collection_filter_type_aliases a WHERE a.policy_id=p.id) AS alias_count,
    (SELECT count(*) FROM public.collection_filter_terms t WHERE t.policy_id=p.id) AS term_count
  INTO v_draft
  FROM public.collection_filter_policies p
  WHERE p.status='DRAFT'
    AND (EXISTS (SELECT 1 FROM public.collection_filter_type_rules r WHERE r.policy_id=p.id)
      OR EXISTS (SELECT 1 FROM public.collection_filter_type_aliases a WHERE a.policy_id=p.id)
      OR EXISTS (SELECT 1 FROM public.collection_filter_terms t WHERE t.policy_id=p.id))
  ORDER BY p.version LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='L11_MIGRATION_BLOCKED_CONFIGURED_DRAFT',
      DETAIL=format('draft policy version=%s id=%s rules=%s aliases=%s terms=%s',
        v_draft.version,v_draft.id,v_draft.rule_count,v_draft.alias_count,v_draft.term_count),
      HINT='Preserve the configured draft and reconcile it through an approved migration before retrying 051';
  END IF;
END;
$$;
-- Empty drafts have no rules, aliases or terms to lose and can be retired.
DELETE FROM public.collection_filter_policies p
WHERE p.status='DRAFT'
  AND NOT EXISTS (SELECT 1 FROM public.collection_filter_type_rules r WHERE r.policy_id=p.id)
  AND NOT EXISTS (SELECT 1 FROM public.collection_filter_type_aliases a WHERE a.policy_id=p.id)
  AND NOT EXISTS (SELECT 1 FROM public.collection_filter_terms t WHERE t.policy_id=p.id);
DROP INDEX IF EXISTS public.uq_collection_filter_one_draft;

-- A fresh installation without an APPROVED policy must still collect DOU.
-- Empty rules are fail-open (unknown type -> KEEP until PLATFORM_ADMIN classifies).
INSERT INTO public.collection_filter_policies(
  version,status,approved_at,change_notes
)
SELECT
  COALESCE((SELECT max(version) FROM public.collection_filter_policies),0)+1,
  'APPROVED',now(),'L-11 initial fail-open policy'
WHERE NOT EXISTS (
  SELECT 1 FROM public.collection_filter_policies WHERE status='APPROVED'
);

ALTER TABLE public.collection_filter_policies
  DROP CONSTRAINT IF EXISTS collection_filter_policies_status_check;
ALTER TABLE public.collection_filter_policies
  ADD CONSTRAINT collection_filter_policies_status_check
  CHECK (status IN ('APPROVED','SUPERSEDED'));

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

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,'ADMIN',v_actor::text,'COLLECTION_FILTER_DIRECT_RULE_CHANGED',
    'collection_filter_type_rule',upper(btrim(p_canonical_type)),
    pg_catalog.jsonb_build_object(
      'sourceCode',lower(btrim(p_source)),'section',upper(btrim(p_section)),
      'canonicalType',upper(btrim(p_canonical_type)),'mode',p_mode,
      'policyRevision',v_revision
    ),pg_catalog.gen_random_uuid()
  );
  RETURN QUERY SELECT v_policy_id,v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_direct_set_rule(TEXT,TEXT,TEXT,TEXT,UUID)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_set_rule(TEXT,TEXT,TEXT,TEXT,UUID)
  TO radar_app;


-- SQL *prefilter only*, not an alternative classification engine. NFKD +
-- diacritic stripping and ASCII token spaces mirror normalizeCollectionFilterType.
-- The TypeScript engine still makes every final KEEP/DISCARD decision.
CREATE OR REPLACE FUNCTION public.collection_filter_l11_normalize(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,public AS $$
  SELECT upper(btrim(regexp_replace(
    regexp_replace(normalize(p_value,NFKD),'[̀-ͯ]','','g'),
    '[^A-Za-z0-9]+',' ','g')));
$$;
REVOKE ALL ON FUNCTION public.collection_filter_l11_normalize(TEXT) FROM PUBLIC;
-- No expression index here: invoking the private normalizer from an index
-- would require granting EXECUTE to every operational INSERT/UPDATE role.
-- Query-time SQL prefilter remains inside the privileged read-only candidate function.

-- Admin-only paging over official DOU records, independent of scope RLS.
-- The application performs the decision with its existing TS filter engine.
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
  IF public.app_current_user_id() IS NULL
     OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
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
        AND lower(btrim(o.metadata->'dou'->>'sourceActType'))
          IS DISTINCT FROM lower(btrim(COALESCE(p.act_type,''))))
      OR (NULLIF(btrim(v.source_metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND lower(btrim(v.source_metadata->'dou'->>'sourceActType'))
          IS DISTINCT FROM lower(btrim(COALESCE(p.act_type,''))))
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

REVOKE ALL ON FUNCTION public.collection_filter_direct_candidates(UUID,INTEGER,TEXT,TEXT[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_candidates(UUID,INTEGER,TEXT,TEXT[])
  TO radar_app;


-- Only a verified SECURITY DEFINER transaction may prune immutable evidence.
-- Never disable global triggers or change existing RESTRICT foreign keys.
CREATE OR REPLACE FUNCTION public.collection_filter_l11_purge_guard()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT current_setting('app.collection_filter_l11_purge',true)='authorized'
    AND current_user=(
      SELECT pg_catalog.pg_get_userbyid(proowner)
      FROM pg_catalog.pg_proc
      WHERE oid=pg_catalog.to_regprocedure(
        'public.collection_filter_direct_purge_batch(uuid[],text,text,text,text,uuid)'
      )
    )
$$;
REVOKE ALL ON FUNCTION public.collection_filter_l11_purge_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.publication_scope_event_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND public.collection_filter_l11_purge_guard() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'PUBLICATION_SCOPE_EVENT_APPEND_ONLY';
END;
$$;

CREATE OR REPLACE FUNCTION public.taxonomy_classification_append_only_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND public.collection_filter_l11_purge_guard() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION public.taxonomy_classification_assertion_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND public.collection_filter_l11_purge_guard() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'publication taxonomy assertions are append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.taxonomy_unmapped_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND public.collection_filter_l11_purge_guard() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION public.taxonomy_candidate_link_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.collection_filter_l11_purge_guard() THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'taxonomy candidate links are historical and cannot be deleted';
  END IF;
  IF OLD.link_status='SUPERSEDED' THEN
    RAISE EXCEPTION 'superseded taxonomy candidate link is immutable';
  END IF;
  IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'taxonomy candidate link identity is immutable';
  END IF;
  IF OLD.link_status='ACTIVE' AND NEW.link_status <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'active taxonomy candidate link only allows supersession';
  END IF;
  RETURN NEW;
END;
$$;

-- One guarded batch. Any unexpected dependent FK or permission failure aborts
-- the whole outer transaction, including the active rule change.
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
      NULL,'ADMIN',v_actor::text,'COLLECTION_FILTER_DIRECT_PURGE',
      'collection_filter_type_rule',upper(btrim(p_type)),
      pg_catalog.jsonb_build_object(
        'sourceCode',lower(btrim(p_source)),
        'section',upper(btrim(p_section)),
        'canonicalType',upper(btrim(p_type)),
        'mode',p_mode,'deletedCount',0,'deletedIds','[]'::jsonb
      ),p_operation
    );
    RETURN 0;
  END IF;
  IF v_count>100 OR v_count<>(SELECT count(DISTINCT id) FROM unnest(p_ids) id)
     OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_purge_batch';
  END IF;
  IF lower(btrim(p_source))<>'dou' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='only_dou_direct_filter_supported';
  END IF;
  IF EXISTS(SELECT 1 FROM public.company_publications cp
            WHERE cp.publication_id=ANY(p_ids)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='company_publication_protected';
  END IF;
  -- A DOU-only filter must not destroy another official source's provenance.
  IF EXISTS(
    SELECT 1 FROM public.publication_origins po
    JOIN public.sources s ON s.id=po.source_id
    WHERE po.publication_id=ANY(p_ids) AND s.code<>'dou'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='cross_source_publication_protected';
  END IF;
  -- Lock parents; a concurrent tenant match must not be created during purge.
  PERFORM 1 FROM public.publications p WHERE p.id=ANY(p_ids) FOR UPDATE;
  IF (SELECT count(*) FROM public.publications WHERE id=ANY(p_ids))<>v_count
     OR EXISTS(
       SELECT 1 FROM public.publications p
       WHERE p.id=ANY(p_ids) AND NOT EXISTS (
         SELECT 1 FROM public.publication_origins po
         JOIN public.sources s ON s.id=po.source_id
         WHERE po.publication_id=p.id AND s.code='dou'
       )
     ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_purge_targets_changed';
  END IF;
  IF EXISTS(SELECT 1 FROM public.company_publications cp
            WHERE cp.publication_id=ANY(p_ids)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='company_publication_protected';
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
  ) VALUES (
    NULL,'ADMIN',v_actor::text,'COLLECTION_FILTER_DIRECT_PURGE',
    'collection_filter_type_rule',upper(btrim(p_type)),
    pg_catalog.jsonb_build_object(
      'sourceCode',lower(btrim(p_source)),
      'section',upper(btrim(p_section)),
      'canonicalType',upper(btrim(p_type)),
      'mode',p_mode,'deletedCount',v_count,'deletedIds',p_ids
    ),p_operation
  );
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_direct_purge_batch(
  UUID[],TEXT,TEXT,TEXT,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_purge_batch(
  UUID[],TEXT,TEXT,TEXT,TEXT,UUID) TO radar_app;

