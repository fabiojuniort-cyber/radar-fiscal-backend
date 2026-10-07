-- ACT-SCOPE-02 / Stage 4
-- Controlled draft editing, simulations registry and unknown type inbox.

ALTER TABLE collection_filter_policies
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE UNIQUE INDEX uq_collection_filter_one_draft
ON collection_filter_policies ((status))
WHERE status = 'DRAFT';

CREATE TABLE collection_filter_new_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
  section TEXT NOT NULL DEFAULT '',
  normalized_type TEXT NOT NULL CHECK (btrim(normalized_type) <> ''),
  sample_raw_type TEXT NOT NULL CHECK (btrim(sample_raw_type) <> ''),
  occurrence_count BIGINT NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sample_publication_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','RESOLVED','MERGED')),
  resolved_canonical_type TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  UNIQUE (source_code, section, normalized_type)
);

CREATE TABLE collection_filter_simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES collection_filter_policies(id) ON DELETE CASCADE,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  scope TEXT NOT NULL CHECK (scope IN ('FULL_ARCHIVE','RECENT')),
  review_mode TEXT NOT NULL DEFAULT 'SAMPLE'
    CHECK (review_mode IN ('ALL','SAMPLE','NONE')),
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX ix_collection_filter_simulations_policy
ON collection_filter_simulations (policy_id, policy_revision, created_at DESC);

REVOKE ALL ON collection_filter_new_types, collection_filter_simulations
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON collection_filter_new_types, collection_filter_simulations
TO radar_app;

ALTER TABLE collection_filter_new_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_new_types FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_simulations FORCE ROW LEVEL SECURITY;

CREATE POLICY collection_filter_new_types_app_select
ON collection_filter_new_types
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_simulations_app_select
ON collection_filter_simulations
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE OR REPLACE FUNCTION collection_filter_save_draft(p_document JSONB)
RETURNS TABLE(policy_id UUID, policy_version INTEGER, policy_revision INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy public.collection_filter_policies%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-draft', 0)
  );

  SELECT * INTO v_policy
  FROM public.collection_filter_policies
  WHERE status='DRAFT'
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.collection_filter_policies(
      version,status,context_window_words,weak_score_threshold,
      title_weight,summary_weight,body_weight,change_notes,created_by,revision
    )
    VALUES(
      COALESCE((SELECT max(version)+1 FROM public.collection_filter_policies),1),
      'DRAFT',
      COALESCE((p_document->>'contextWindowWords')::int,12),
      COALESCE((p_document->>'weakScoreThreshold')::int,3),
      COALESCE((p_document->'locationWeights'->>'title')::int,3),
      COALESCE((p_document->'locationWeights'->>'summary')::int,2),
      COALESCE((p_document->'locationWeights'->>'body')::int,1),
      NULLIF(p_document->>'changeNotes',''),
      v_actor,1
    )
    RETURNING * INTO v_policy;
  ELSE
    UPDATE public.collection_filter_policies
    SET context_window_words=COALESCE((p_document->>'contextWindowWords')::int,context_window_words),
        weak_score_threshold=COALESCE((p_document->>'weakScoreThreshold')::int,weak_score_threshold),
        title_weight=COALESCE((p_document->'locationWeights'->>'title')::int,title_weight),
        summary_weight=COALESCE((p_document->'locationWeights'->>'summary')::int,summary_weight),
        body_weight=COALESCE((p_document->'locationWeights'->>'body')::int,body_weight),
        change_notes=NULLIF(p_document->>'changeNotes',''),
        revision=revision+1,
        updated_at=now()
    WHERE id=v_policy.id
    RETURNING * INTO v_policy;
  END IF;

  DELETE FROM public.collection_filter_terms WHERE policy_id=v_policy.id;
  DELETE FROM public.collection_filter_type_aliases WHERE policy_id=v_policy.id;
  DELETE FROM public.collection_filter_type_rules WHERE policy_id=v_policy.id;

  INSERT INTO public.collection_filter_type_rules(
    policy_id,source_code,section,canonical_type,mode,help_text
  )
  SELECT v_policy.id, x.source_code, COALESCE(x.section,''), x.canonical_type, x.mode, x.help_text
  FROM jsonb_to_recordset(COALESCE(p_document->'rules','[]'::jsonb))
    AS x(source_code text, section text, canonical_type text, mode text, help_text text);

  INSERT INTO public.collection_filter_type_aliases(
    policy_id,source_code,section,normalized_alias,canonical_type
  )
  SELECT v_policy.id, x.source_code, COALESCE(x.section,''), x.normalized_alias, x.canonical_type
  FROM jsonb_to_recordset(COALESCE(p_document->'aliases','[]'::jsonb))
    AS x(source_code text, section text, normalized_alias text, canonical_type text);

  INSERT INTO public.collection_filter_terms(
    policy_id,term_text,normalized_term,strength,source_code,section,canonical_type,location_scope
  )
  SELECT v_policy.id,x.term_text,x.normalized_term,x.strength,
         NULLIF(x.source_code,''),NULLIF(x.section,''),NULLIF(x.canonical_type,''),
         COALESCE(NULLIF(x.location_scope,''),'ANY')
  FROM jsonb_to_recordset(COALESCE(p_document->'terms','[]'::jsonb))
    AS x(term_text text, normalized_term text, strength text, source_code text,
         section text, canonical_type text, location_scope text);

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,after_data,correlation_id
  ) VALUES(
    NULL,'ADMIN',v_actor::text,'COLLECTION_FILTER_DRAFT_SAVED',
    'collection_filter_policy',v_policy.id::text,
    jsonb_build_object('version',v_policy.version,'revision',v_policy.revision),
    gen_random_uuid()
  );

  RETURN QUERY SELECT v_policy.id,v_policy.version,v_policy.revision;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_save_draft(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collection_filter_save_draft(JSONB) TO radar_app;

CREATE OR REPLACE FUNCTION collection_filter_resolve_new_type(
  p_id UUID,
  p_status TEXT,
  p_canonical_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_actor UUID := public.app_current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;
  IF p_status NOT IN ('RESOLVED','MERGED') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_new_type_status';
  END IF;
  IF p_canonical_type IS NULL OR btrim(p_canonical_type) = '' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='canonical_type_required';
  END IF;
  UPDATE public.collection_filter_new_types
  SET status=p_status,
      resolved_canonical_type=btrim(p_canonical_type),
      resolved_at=now(),
      resolved_by=v_actor
  WHERE id=p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='new_type_not_found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_resolve_new_type(UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collection_filter_resolve_new_type(UUID,TEXT,TEXT) TO radar_app;
