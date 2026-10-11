-- L-17: Align historical archived candidate type conflict with the
-- runtime canonical-specific type behavior. Preserve generic source type
-- as provenance and preserve TYPE_CONFLICT on unrelated classifications.
-- This changes the privileged SQL prefilter's evidence flag only; the
-- shared TypeScript evaluateCollectionFilter remains the decision engine.
-- No purge or UPDATE takes place during migration.
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
        AND public.collection_filter_l11_normalize(o.metadata->'dou'->>'sourceActType')
          <> public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
        AND public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
          NOT LIKE public.collection_filter_l11_normalize(o.metadata->'dou'->>'sourceActType') || ' %')
      OR (NULLIF(btrim(v.source_metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND public.collection_filter_l11_normalize(v.source_metadata->'dou'->>'sourceActType')
          <> public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
        AND public.collection_filter_l11_normalize(COALESCE(p.act_type,''))
          NOT LIKE public.collection_filter_l11_normalize(v.source_metadata->'dou'->>'sourceActType') || ' %')
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


