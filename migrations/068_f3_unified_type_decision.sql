-- F3: evidence paging only. No type/section prefilter and no duplicate
-- decision engine. DDL only; applying this migration purges no records.
CREATE OR REPLACE FUNCTION public.collection_filter_confirm_policy_lock()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_revision INTEGER;
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  SELECT revision INTO v_revision FROM public.collection_filter_policies WHERE status='APPROVED' FOR SHARE;
  IF v_revision IS NULL THEN RAISE EXCEPTION 'approved_collection_filter_required'; END IF;
  PERFORM set_config('app.collection_filter_confirmed_revision',v_revision::text,true);
  RETURN v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_confirm_policy_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_confirm_policy_lock() TO radar_app;

CREATE OR REPLACE FUNCTION public.collection_filter_purge_samples(p_ids UUID[])
RETURNS TABLE(id UUID,title TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF cardinality(p_ids)>10 THEN RAISE EXCEPTION 'sample_limit_exceeded'; END IF;
  RETURN QUERY SELECT p.id,p.title FROM public.publications p WHERE p.id=ANY(p_ids) ORDER BY p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_purge_samples(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_purge_samples(UUID[]) TO radar_app;

CREATE OR REPLACE FUNCTION public.collection_filter_capture_protected(
  p_identity_hash TEXT,p_source_id UUID,p_url TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker_role_required';
  END IF;
  RETURN EXISTS(SELECT 1 FROM public.publications p WHERE p.identity_hash=p_identity_hash AND (
    EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id)
    OR EXISTS(SELECT 1 FROM public.publication_origins po WHERE po.publication_id=p.id
      AND (po.source_id<>p_source_id OR po.official_url IS DISTINCT FROM p_url))
    OR (SELECT count(*) FROM public.publication_origins po WHERE po.publication_id=p.id)>1
  ));
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_capture_protected(TEXT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_capture_protected(TEXT,UUID,TEXT) TO radar_worker;

CREATE OR REPLACE FUNCTION public.collection_filter_f3_candidates(
  p_after UUID,p_limit INTEGER,p_source TEXT
) RETURNS TABLE(
  publication_id UUID,title TEXT,act_type TEXT,source_act_type TEXT,
  source_code TEXT,section TEXT,content_text TEXT,relevant_excerpt TEXT,
  evidence_complete BOOLEAN,has_material BOOLEAN,type_conflict BOOLEAN,
  provenance_conflict BOOLEAN,has_company BOOLEAN,has_other_source BOOLEAN,
  content_hash TEXT
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT (public.app_current_user_id() IS NOT NULL AND public.app_user_is_platform_admin())
    AND NOT pg_catalog.pg_has_role(session_user,'radar_worker','MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='admin_or_worker_required';
  END IF;
  IF p_limit IS NULL OR p_limit<1 OR p_limit>500
    OR p_source IS NULL OR p_source NOT IN ('dou','doe-sp') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_f3_evidence_page';
  END IF;
  RETURN QUERY
  SELECT p.id,p.title,p.act_type,COALESCE(e.origin_type,e.version_type),p_source,
    COALESCE(e.origin_section,e.version_section,''),v.content_text,v.relevant_excerpt,
    COALESCE(btrim(v.content_text),'')<>''
      AND NOT COALESCE(o.metadata->'dou'->>'scopeStructureIncomplete'='true',false)
      AND NOT COALESCE(v.source_metadata->'dou'->>'scopeStructureIncomplete'='true',false)
      AND NOT (COALESCE(o.metadata->'dou','{}'::jsonb) ? 'titleFallback')
      AND NOT (COALESCE(v.source_metadata->'dou','{}'::jsonb) ? 'titleFallback'),
    CASE WHEN jsonb_typeof(COALESCE(o.metadata->'files',v.source_metadata->'files'))='array' THEN
      EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.metadata->'files',v.source_metadata->'files')) f
        WHERE COALESCE(f->>'versionRole','')<>'PROVENANCE'
          AND (f->>'versionRole'='MATERIAL_CONTENT' OR f->'metadata'->>'kind'='ATTACHMENT'))
      ELSE EXISTS(SELECT 1 FROM public.publication_files pf WHERE pf.publication_version_id=v.id) END
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(COALESCE(o.metadata->'dou',v.source_metadata->'dou')->'parts','[]'::jsonb)) part
        WHERE part->>'hasHighlightImage'='true'),
    COALESCE(public.collection_filter_l11_normalize(COALESCE(e.origin_type,e.version_type))<>
      public.collection_filter_l11_normalize(p.act_type),false),
    v.id IS NULL OR (SELECT count(*) FROM public.publication_versions vv
      WHERE vv.publication_id=p.id AND vv.is_current)<>1
      OR (e.origin_type IS NOT NULL AND e.version_type IS NOT NULL
      AND public.collection_filter_l11_normalize(e.origin_type)<>
          public.collection_filter_l11_normalize(e.version_type))
      OR (e.origin_section IS NOT NULL AND e.version_section IS NOT NULL
        AND upper(btrim(e.origin_section))<>upper(btrim(e.version_section))),
    EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id),
    (SELECT count(*)>1 FROM public.publication_origins po2 WHERE po2.publication_id=p.id),
    v.content_hash::text
  FROM public.publications p
  JOIN LATERAL(
    SELECT po.metadata FROM public.publication_origins po
    JOIN public.sources so ON so.id=po.source_id
    WHERE po.publication_id=p.id AND so.code=p_source ORDER BY po.id LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL(
    SELECT pv.id,pv.source_metadata,pv.content_text,pv.relevant_excerpt,pv.content_hash
    FROM public.publication_versions pv WHERE pv.publication_id=p.id AND pv.is_current LIMIT 1
  ) v ON true
  CROSS JOIN LATERAL(
    SELECT
      NULLIF(btrim(CASE WHEN p_source='dou' THEN o.metadata->'dou'->>'sourceActType'
        ELSE o.metadata->>'publicationType' END),'') AS origin_type,
      NULLIF(btrim(CASE WHEN p_source='dou' THEN v.source_metadata->'dou'->>'sourceActType'
        ELSE v.source_metadata->>'publicationType' END),'') AS version_type,
      NULLIF(btrim(CASE WHEN p_source='dou' THEN o.metadata->'dou'->>'section'
        ELSE o.metadata->>'section' END),'') AS origin_section,
      NULLIF(btrim(CASE WHEN p_source='dou' THEN v.source_metadata->'dou'->>'section'
        ELSE v.source_metadata->>'section' END),'') AS version_section
  ) e
  WHERE p_after IS NULL OR p.id>p_after ORDER BY p.id LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_f3_candidates(UUID,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_f3_candidates(UUID,INTEGER,TEXT) TO radar_app,radar_worker;

-- Background deletion is retired; only the admin preview/confirm path remains.
REVOKE EXECUTE ON FUNCTION public.l17_prune_always_batch(UUID[],TEXT[],UUID,INTEGER,TEXT,TEXT) FROM radar_worker;
REVOKE EXECUTE ON FUNCTION public.l17_prune_hidden_batch(INTEGER) FROM radar_worker;

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
    v_origin.metadata->'doe-sp'->>'section',v_origin.metadata->>'section','');
  v_url:=COALESCE(NULLIF(OLD.primary_official_url,''),NULLIF(v_origin.official_url,''));
  IF v_url IS NULL OR btrim(v_url)='' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_official_url';
  END IF;
  SELECT * INTO v_policy
    FROM public.collection_filter_policies WHERE status='APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_approved_policy';
  END IF;
  -- The SAME TypeScript decision supplies its winning rule. No exact type
  -- matching here: audit must not report a different rule than the preview.
  v_rule:=NULLIF(current_setting('app.collection_filter_confirmed_pattern',true),'');
  v_mode:=NULLIF(current_setting('app.collection_filter_confirmed_mode',true),'');
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

