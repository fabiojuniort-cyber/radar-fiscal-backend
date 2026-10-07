-- ACT-SCOPE-02 / Stage 5
-- Least-privilege simulation executor for radar_worker.
-- No direct table write privilege is granted to the Worker.

ALTER TABLE collection_filter_simulations
  ADD COLUMN worker_id TEXT,
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN heartbeat_at TIMESTAMPTZ,
  ADD COLUMN snapshot_at TIMESTAMPTZ,
  ADD COLUMN last_publication_id UUID,
  ADD COLUMN processed_count BIGINT NOT NULL DEFAULT 0
    CHECK (processed_count >= 0);

CREATE INDEX ix_collection_filter_simulations_worker
ON collection_filter_simulations (status, worker_id, heartbeat_at);

CREATE OR REPLACE FUNCTION collection_filter_claim_simulation(
  p_worker_id TEXT
)
RETURNS TABLE (
  simulation_id UUID,
  policy_id UUID,
  policy_version INTEGER,
  policy_revision INTEGER,
  simulation_scope TEXT,
  review_mode TEXT,
  last_publication_id UUID,
  processed_count BIGINT,
  metrics JSONB,
  policy_document JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_worker TEXT := btrim(p_worker_id);
  v_sim public.collection_filter_simulations%ROWTYPE;
  v_policy public.collection_filter_policies%ROWTYPE;
  v_document JSONB;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;
  IF v_worker IS NULL OR v_worker='' OR length(v_worker) > 200 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_simulation_worker_id';
  END IF;

  -- Recover abandoned leases. Partial items are idempotently upserted and the
  -- cursor/metrics remain, so another replica resumes instead of restarting.
  UPDATE public.collection_filter_simulations s
     SET status='PENDING',
         worker_id=NULL,
         heartbeat_at=NULL,
         error_code='STALE_LEASE_RECOVERED'
   WHERE s.status='RUNNING'
     AND s.heartbeat_at < now() - interval '15 minutes';

  -- Prefer continuing work already owned by this process.
  SELECT * INTO v_sim
  FROM public.collection_filter_simulations s
  WHERE s.status='RUNNING'
    AND s.worker_id=v_worker
  ORDER BY s.started_at NULLS LAST, s.created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    SELECT * INTO v_sim
    FROM public.collection_filter_simulations s
    WHERE s.status='PENDING'
    ORDER BY s.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    SELECT * INTO v_policy
    FROM public.collection_filter_policies p
    WHERE p.id=v_sim.policy_id
      AND p.status='DRAFT'
      AND p.revision=v_sim.policy_revision;

    IF NOT FOUND THEN
      UPDATE public.collection_filter_simulations s
         SET status='FAILED',
             error_code='POLICY_REVISION_CHANGED',
             completed_at=now()
       WHERE s.id=v_sim.id;
      RETURN;
    END IF;

    UPDATE public.collection_filter_simulations s
       SET status='RUNNING',
           worker_id=v_worker,
           started_at=COALESCE(s.started_at,now()),
           heartbeat_at=now(),
           snapshot_at=COALESCE(s.snapshot_at,now()),
           error_code=NULL
     WHERE s.id=v_sim.id
     RETURNING * INTO v_sim;
  ELSE
    SELECT * INTO v_policy
    FROM public.collection_filter_policies p
    WHERE p.id=v_sim.policy_id
      AND p.status='DRAFT'
      AND p.revision=v_sim.policy_revision;

    IF NOT FOUND THEN
      UPDATE public.collection_filter_simulations s
         SET status='FAILED',
             error_code='POLICY_REVISION_CHANGED',
             completed_at=now()
       WHERE s.id=v_sim.id;
      RETURN;
    END IF;

    UPDATE public.collection_filter_simulations s
       SET heartbeat_at=now(),
           snapshot_at=COALESCE(s.snapshot_at,now())
     WHERE s.id=v_sim.id
     RETURNING * INTO v_sim;
  END IF;

  SELECT jsonb_build_object(
    'version',v_policy.version,
    'contextWindowWords',v_policy.context_window_words,
    'weakScoreThreshold',v_policy.weak_score_threshold,
    'locationWeights',jsonb_build_object(
      'title',v_policy.title_weight,
      'summary',v_policy.summary_weight,
      'body',v_policy.body_weight
    ),
    'rules',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'sourceCode',r.source_code,
        'section',r.section,
        'canonicalType',r.canonical_type,
        'mode',r.mode
      ) ORDER BY r.source_code,r.section,r.canonical_type)
      FROM public.collection_filter_type_rules r
      WHERE r.policy_id=v_policy.id
    ),'[]'::jsonb),
    'aliases',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'sourceCode',a.source_code,
        'section',a.section,
        'alias',a.normalized_alias,
        'canonicalType',a.canonical_type
      ) ORDER BY a.source_code,a.section,a.normalized_alias)
      FROM public.collection_filter_type_aliases a
      WHERE a.policy_id=v_policy.id
    ),'[]'::jsonb),
    'terms',COALESCE((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'text',t.term_text,
          'strength',t.strength,
          'sourceCode',t.source_code,
          'section',t.section,
          'canonicalType',t.canonical_type,
          'locationScope',t.location_scope
        ))
        ORDER BY t.strength,t.normalized_term
      )
      FROM public.collection_filter_terms t
      WHERE t.policy_id=v_policy.id
    ),'[]'::jsonb)
  ) INTO v_document;

  RETURN QUERY SELECT
    v_sim.id,
    v_policy.id,
    v_policy.version,
    v_policy.revision,
    v_sim.scope,
    v_sim.review_mode,
    v_sim.last_publication_id,
    v_sim.processed_count,
    v_sim.metrics,
    v_document;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_simulation_batch(
  p_simulation_id UUID,
  p_worker_id TEXT,
  p_after_id UUID,
  p_limit INTEGER
)
RETURNS TABLE (
  publication_id UUID,
  title TEXT,
  published_on DATE,
  official_url TEXT,
  act_type TEXT,
  summary TEXT,
  body TEXT,
  evidence_complete BOOLEAN,
  material_attachments_unexamined BOOLEAN,
  type_conflict BOOLEAN,
  provenance_conflict BOOLEAN,
  origins JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sim public.collection_filter_simulations%ROWTYPE;
  v_limit INTEGER;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit,500),1),1000);

  SELECT * INTO v_sim
  FROM public.collection_filter_simulations s
  WHERE s.id=p_simulation_id
    AND s.status='RUNNING'
    AND s.worker_id=btrim(p_worker_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='simulation_lease_not_owned';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT
      p.id,
      p.title,
      p.published_on,
      p.primary_official_url,
      p.act_type,
      p.last_seen_at,
      pv.id AS publication_version_id,
      pv.content_text,
      pv.relevant_excerpt,
      pv.source_metadata,
      jsonb_agg(
        DISTINCT jsonb_build_object(
          'sourceCode',src.code,
          'section',COALESCE(po.metadata->'dou'->>'section','')
        )
      ) FILTER (
        WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
      ) AS eligible_origins,
      count(DISTINCT (
        src.code || E'\x1f' ||
        COALESCE(po.metadata->'dou'->>'section','')
      )) FILTER (
        WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
      ) AS eligible_origin_shapes,
      bool_or(
        src.code='dou'
        AND NULLIF(btrim(po.metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND lower(btrim(po.metadata->'dou'->>'sourceActType'))
            IS DISTINCT FROM lower(btrim(COALESCE(p.act_type,'')))
      ) FILTER (
        WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
      ) AS origin_type_conflict,
      bool_or(
        COALESCE((po.metadata->'dou'->>'scopeStructureIncomplete')::boolean,false)
        OR po.metadata->'dou' ? 'titleFallback'
      ) FILTER (
        WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
      ) AS origin_structure_incomplete,
      bool_or(
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(po.metadata->'files','[]'::jsonb)) ofile
          WHERE ofile->'metadata'->>'kind'='ATTACHMENT'
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(po.metadata->'dou'->'parts','[]'::jsonb)) opart
          WHERE opart->>'hasHighlightImage'='true'
        )
      ) FILTER (
        WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
      ) AS origin_material_unexamined
    FROM public.publications p
    JOIN public.publication_origins po
      ON po.publication_id=p.id
     AND po.first_seen_at <= v_sim.snapshot_at
    JOIN public.sources src ON src.id=po.source_id
    LEFT JOIN LATERAL (
      SELECT pv0.id,pv0.content_text,pv0.relevant_excerpt,pv0.source_metadata
      FROM public.publication_versions pv0
      WHERE pv0.publication_id=p.id
        AND pv0.captured_at <= v_sim.snapshot_at
      ORDER BY pv0.captured_at DESC,pv0.version_no DESC
      LIMIT 1
    ) pv ON true
    WHERE NOT p.is_hidden
      AND p.created_at <= v_sim.snapshot_at
      AND (p_after_id IS NULL OR p.id > p_after_id)
      AND (
        v_sim.scope='FULL_ARCHIVE'
        OR p.last_seen_at >= v_sim.snapshot_at - interval '30 days'
      )
    GROUP BY
      p.id,p.title,p.published_on,p.primary_official_url,p.act_type,p.last_seen_at,
      pv.id,pv.content_text,pv.relevant_excerpt,pv.source_metadata
    HAVING count(*) FILTER (
      WHERE src.code NOT IN ('doe-sp','doe-sp-legado')
    ) > 0
    ORDER BY p.id
    LIMIT v_limit
  )
  SELECT
    e.id,
    e.title,
    e.published_on,
    e.primary_official_url,
    e.act_type,
    e.relevant_excerpt,
    e.content_text,
    (
      e.content_text IS NOT NULL
      AND btrim(e.content_text)<>''
      AND NOT COALESCE(e.origin_structure_incomplete,false)
      AND NOT COALESCE((e.source_metadata->'dou'->>'scopeStructureIncomplete')::boolean,false)
      AND NOT (COALESCE(e.source_metadata->'dou','{}'::jsonb) ? 'titleFallback')
    ) AS evidence_complete,
    (
      COALESCE(e.origin_material_unexamined,false)
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(e.source_metadata->'files','[]'::jsonb)) f
        WHERE f->'metadata'->>'kind'='ATTACHMENT'
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(e.source_metadata->'dou'->'parts','[]'::jsonb)) part
        WHERE part->>'hasHighlightImage'='true'
      )
      OR EXISTS (
        SELECT 1
        FROM public.publication_files pf
        WHERE pf.publication_version_id=e.publication_version_id
      )
    ) AS material_attachments_unexamined,
    (
      COALESCE(e.origin_type_conflict,false)
      OR (
        NULLIF(btrim(e.source_metadata->'dou'->>'sourceActType'),'') IS NOT NULL
        AND lower(btrim(e.source_metadata->'dou'->>'sourceActType'))
            IS DISTINCT FROM lower(btrim(COALESCE(e.act_type,'')))
      )
    ) AS type_conflict,
    e.eligible_origin_shapes > 1 AS provenance_conflict,
    COALESCE(e.eligible_origins,'[]'::jsonb)
  FROM eligible e
  ORDER BY e.id;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_record_simulation_batch(
  p_simulation_id UUID,
  p_worker_id TEXT,
  p_last_publication_id UUID,
  p_items JSONB,
  p_metrics JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;

  PERFORM 1
  FROM public.collection_filter_simulations s
  WHERE s.id=p_simulation_id
    AND s.status='RUNNING'
    AND s.worker_id=btrim(p_worker_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='simulation_lease_not_owned';
  END IF;

  INSERT INTO public.collection_filter_simulation_items(
    simulation_id,publication_id,source_code,section,raw_type,canonical_type,
    decision,reason_code,decisive_term,excerpt,title,published_on,official_url,
    review_sample
  )
  SELECT
    p_simulation_id,
    x.publication_id,
    x.source_code,
    COALESCE(x.section,''),
    x.raw_type,
    x.canonical_type,
    x.decision,
    x.reason_code,
    x.decisive_term,
    x.excerpt,
    x.title,
    x.published_on,
    x.official_url,
    COALESCE(x.review_sample,false)
  FROM jsonb_to_recordset(COALESCE(p_items,'[]'::jsonb))
    AS x(
      publication_id uuid,
      source_code text,
      section text,
      raw_type text,
      canonical_type text,
      decision text,
      reason_code text,
      decisive_term text,
      excerpt text,
      title text,
      published_on date,
      official_url text,
      review_sample boolean
    )
  ON CONFLICT (simulation_id,publication_id)
  DO UPDATE SET
    source_code=EXCLUDED.source_code,
    section=EXCLUDED.section,
    raw_type=EXCLUDED.raw_type,
    canonical_type=EXCLUDED.canonical_type,
    decision=EXCLUDED.decision,
    reason_code=EXCLUDED.reason_code,
    decisive_term=EXCLUDED.decisive_term,
    excerpt=EXCLUDED.excerpt,
    title=EXCLUDED.title,
    published_on=EXCLUDED.published_on,
    official_url=EXCLUDED.official_url,
    review_sample=EXCLUDED.review_sample;

  SELECT jsonb_array_length(COALESCE(p_items,'[]'::jsonb)) INTO v_count;

  UPDATE public.collection_filter_simulations s
     SET last_publication_id=p_last_publication_id,
         processed_count=s.processed_count+v_count,
         metrics=COALESCE(p_metrics,'{}'::jsonb),
         heartbeat_at=now()
   WHERE s.id=p_simulation_id;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_finish_simulation(
  p_simulation_id UUID,
  p_worker_id TEXT,
  p_metrics JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;

  UPDATE public.collection_filter_simulations s
     SET status='COMPLETED',
         metrics=COALESCE(p_metrics,'{}'::jsonb),
         heartbeat_at=now(),
         completed_at=now()
   WHERE s.id=p_simulation_id
     AND s.status='RUNNING'
     AND s.worker_id=btrim(p_worker_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='simulation_lease_not_owned';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_fail_simulation(
  p_simulation_id UUID,
  p_worker_id TEXT,
  p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;

  UPDATE public.collection_filter_simulations s
     SET status='FAILED',
         error_code=left(COALESCE(NULLIF(btrim(p_error_code),''),'SIMULATION_FAILED'),100),
         heartbeat_at=now(),
         completed_at=now()
   WHERE s.id=p_simulation_id
     AND s.status='RUNNING'
     AND s.worker_id=btrim(p_worker_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='simulation_lease_not_owned';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_claim_simulation(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_simulation_batch(UUID,TEXT,UUID,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_record_simulation_batch(UUID,TEXT,UUID,JSONB,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_finish_simulation(UUID,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_fail_simulation(UUID,TEXT,TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION collection_filter_claim_simulation(TEXT) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_simulation_batch(UUID,TEXT,UUID,INTEGER) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_record_simulation_batch(UUID,TEXT,UUID,JSONB,JSONB) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_finish_simulation(UUID,TEXT,JSONB) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_fail_simulation(UUID,TEXT,TEXT) TO radar_worker;
