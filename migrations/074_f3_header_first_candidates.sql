-- F3-PERF-02: split title/section preflight from heavy legal evidence.
-- Same pagination, canonical section fallbacks, source authorization, and
-- row-level provenance selection as migration 069; no change to original.
-- Full legal evidence is loaded ONLY for exact IDs selected by compiled
-- TypeScript necessary-condition patterns (never SQL title-string filtering).
CREATE OR REPLACE FUNCTION public.collection_filter_f3_headers(
  p_after UUID,p_limit INTEGER,p_source TEXT
) RETURNS TABLE(publication_id UUID,title TEXT,section TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
  SELECT p.id,p.title,COALESCE(
    NULLIF(btrim(CASE WHEN p_source='dou' THEN o.metadata->'dou'->>'section'
      ELSE o.metadata->>'section' END),''),
    NULLIF(btrim(CASE WHEN p_source='dou' THEN v.source_metadata->'dou'->>'section'
      ELSE v.source_metadata->>'section' END),''),
    ''
  ) AS section
  FROM public.publications p
  JOIN LATERAL(
    SELECT po.metadata FROM public.publication_origins po
    JOIN public.sources so ON so.id=po.source_id
    WHERE po.publication_id=p.id AND lower(so.code)=p_source
    ORDER BY po.id LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL(
    SELECT pv.source_metadata FROM public.publication_versions pv
    WHERE pv.publication_id=p.id AND pv.is_current LIMIT 1
  ) v ON true
  WHERE p_after IS NULL OR p.id>p_after
  ORDER BY p.id LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_f3_headers(UUID,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_f3_headers(UUID,INTEGER,TEXT) TO radar_app,radar_worker;

-- The by-ID function is a copy of the 069 evidence semantics with ONLY the
-- p_after/limit restriction replaced by an explicitly bounded p_ids array.
CREATE OR REPLACE FUNCTION public.collection_filter_f3_candidates_by_ids(
  p_ids UUID[],p_source TEXT
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
  IF p_ids IS NULL OR cardinality(p_ids)<1 OR cardinality(p_ids)>500
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
      AND upper(btrim(e.origin_type))<>upper(btrim(e.version_type)))
      OR (e.origin_section IS NOT NULL AND e.version_section IS NOT NULL
        AND upper(btrim(e.origin_section))<>upper(btrim(e.version_section))),
    EXISTS(SELECT 1 FROM public.company_publications cp WHERE cp.publication_id=p.id),
    (SELECT count(*)>1 FROM public.publication_origins po2 WHERE po2.publication_id=p.id),
    v.content_hash::text
  FROM public.publications p
  JOIN LATERAL(
    SELECT po.metadata FROM public.publication_origins po
    JOIN public.sources so ON so.id=po.source_id
    WHERE po.publication_id=p.id AND lower(so.code)=p_source ORDER BY po.id LIMIT 1
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
  WHERE p.id=ANY(p_ids) ORDER BY p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_filter_f3_candidates_by_ids(UUID[],TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_f3_candidates_by_ids(UUID[],TEXT) TO radar_app,radar_worker;
