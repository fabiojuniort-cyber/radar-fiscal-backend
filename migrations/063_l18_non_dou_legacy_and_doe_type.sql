-- L18-2/2b approved by Fábio. DDL only: this migration never runs a purge.
-- Existing DOU-only rule and scope paths remain unchanged; only the two
-- named special categories may now originate outside DOU.
-- L18: add read-only candidates without changing the DOU selection rules.
-- No deletion or recapture on migration.
CREATE FUNCTION public.l18_special_cleanup_candidates(p_after UUID,p_limit INTEGER)
RETURNS TABLE(
  publication_id UUID, updated_at TIMESTAMPTZ, source_code TEXT,
  has_company BOOLEAN, has_other_source BOOLEAN,
  hidden_legacy BOOLEAN, suspect_doe BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $func$
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_l18_page_limit';
  END IF;
  RETURN QUERY
  WITH target_ids AS (
    SELECT p.id FROM public.publications p
    WHERE p.is_hidden AND (p_after IS NULL OR p.id>p_after)
      AND NOT EXISTS(
        SELECT 1 FROM public.publication_origins po
        JOIN public.sources s ON s.id=po.source_id
        WHERE po.publication_id=p.id AND s.code='dou'
      )
    UNION
    SELECT p.id FROM public.publications p
    WHERE NOT p.is_hidden
      AND p.act_type='EMENDA CONSTITUCIONAL'
      AND btrim(p.title) NOT ILIKE 'Emenda Constitucional%'
      AND (p_after IS NULL OR p.id>p_after)
      AND NOT EXISTS(
        SELECT 1 FROM public.publication_scope_state ss
        WHERE ss.publication_id=p.id AND ss.scope<>'IN_SCOPE'
      )
      AND EXISTS(
        SELECT 1 FROM public.publication_origins po
        JOIN public.sources s ON s.id=po.source_id
        WHERE po.publication_id=p.id AND s.code='doe-sp'
      )
  ), limited AS (
    SELECT id FROM target_ids ORDER BY id LIMIT p_limit
  )
  SELECT p.id,p.updated_at,
    (SELECT min(s.code) FROM public.publication_origins po
      JOIN public.sources s ON s.id=po.source_id
      WHERE po.publication_id=p.id),
    EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id),
    (SELECT count(DISTINCT po.source_id)<>1 FROM public.publication_origins po
      WHERE po.publication_id=p.id),
    p.is_hidden,
    NOT p.is_hidden AND p.act_type='EMENDA CONSTITUCIONAL'
      AND btrim(p.title) NOT ILIKE 'Emenda Constitucional%'
      AND EXISTS(SELECT 1 FROM public.publication_origins po
        JOIN public.sources s ON s.id=po.source_id
        WHERE po.publication_id=p.id AND s.code='doe-sp')
  FROM limited l JOIN public.publications p ON p.id=l.id
  ORDER BY p.id;
END;
$func$;
REVOKE ALL ON FUNCTION public.l18_special_cleanup_candidates(UUID,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.l18_special_cleanup_candidates(UUID,INTEGER) TO radar_app;

-- Preserve the existing 051 guarded dependency cleanup, row locks and audits;
-- non-DOU access only with exact L18 sentinel section/type/mode and current
-- locked eligibility. No role/trigger bypass.
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
  -- Non-DOU sources only via the two exact approved L-18 groups.
  IF lower(btrim(p_source))<>'dou' AND NOT (v_legacy_hidden OR v_doe_type) THEN
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

-- Preserve three-month Desconsiderados from migration 058, with the source
-- of the guarded operation instead of hard-coded DOU.
CREATE OR REPLACE FUNCTION public.l17_capture_archive_discard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  v_source public.sources%ROWTYPE;
  v_origin public.publication_origins%ROWTYPE;
  v_section TEXT;
  v_url TEXT;
  v_policy public.collection_filter_policies%ROWTYPE;
  v_rule TEXT;
  v_mode TEXT;
  v_source_code TEXT;
BEGIN
  IF pg_catalog.current_setting('app.collection_filter_l11_purge',true)
     IS DISTINCT FROM 'authorized' THEN
    RETURN OLD;
  END IF;
  IF NOT public.collection_filter_l11_purge_guard() THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='archive_discard_requires_guarded_purge';
  END IF;
  v_source_code:=COALESCE(NULLIF(
    pg_catalog.current_setting('app.collection_filter_l18_origin',true),''),'dou');
  SELECT po.* INTO v_origin
  FROM public.publication_origins po
  JOIN public.sources so ON so.id=po.source_id
  WHERE po.publication_id=OLD.id AND so.code=v_source_code
  ORDER BY po.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_guarded_origin';
  END IF;
  SELECT so.* INTO STRICT v_source FROM public.sources so WHERE so.id=v_origin.source_id;
  v_section:=COALESCE(v_origin.metadata->'dou'->>'section',
    v_origin.metadata->'doe-sp'->>'section','');
  v_url:=COALESCE(NULLIF(OLD.primary_official_url,''),NULLIF(v_origin.official_url,''));
  IF v_url IS NULL OR btrim(v_url)='' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_official_url';
  END IF;
  SELECT * INTO v_policy
    FROM public.collection_filter_policies WHERE status='APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_approved_policy';
  END IF;
  SELECT r.canonical_type,r.mode INTO v_rule,v_mode
    FROM public.collection_filter_type_rules r
    WHERE r.policy_id=v_policy.id AND r.source_code=v_source.code
      AND public.collection_filter_l11_normalize(r.section)=
        public.collection_filter_l11_normalize(v_section)
      AND public.collection_filter_l11_normalize(r.canonical_type)=
        public.collection_filter_l11_normalize(COALESCE(OLD.act_type,''))
    LIMIT 1;
  IF v_source_code<>'dou' AND OLD.is_hidden THEN
    v_rule:='L18_LEGACY_029';v_mode:='EXCLUDE_ALWAYS';
  ELSIF v_source_code='doe-sp'
    AND OLD.act_type='EMENDA CONSTITUCIONAL'
    AND btrim(OLD.title) NOT ILIKE 'Emenda Constitucional%' THEN
    v_rule:='L18_DOE_TYPE_MISMATCH';v_mode:='EXCLUDE_ALWAYS';
  END IF;
  INSERT INTO public.collection_filter_discards(
    source_id,collection_run_id,attempt_id,source_item_key,
    source_code,connector_key,section,raw_type,canonical_type,title,
    act_number,published_on,official_url,reason_code,decisive_term,
    policy_id,policy_version,policy_revision,discard_origin,
    archive_publication_id,rule_mode,archive_policy_rule
  ) VALUES (
    v_source.id,NULL,NULL,'archive:'||OLD.id::text,
    v_source.code,v_source.connector_key,upper(v_section),
    OLD.act_type,COALESCE(v_rule,OLD.act_type),OLD.title,
    OLD.act_number,OLD.published_on,v_url,
    'ARCHIVE_PURGE',NULLIF(pg_catalog.current_setting(
      'app.collection_filter_decisive_term',true),''),
    v_policy.id,v_policy.version,v_policy.revision,'ARCHIVE',
    OLD.id,v_mode,COALESCE(v_rule,'')
  );
  RETURN OLD;
END;
$$;

