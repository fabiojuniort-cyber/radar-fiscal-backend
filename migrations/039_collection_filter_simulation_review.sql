-- ACT-SCOPE-02 / Stage 4
-- Simulation review contract and approval gate.
-- No simulation is executed by this migration; Stage 5 provides the runner.

CREATE TABLE collection_filter_simulation_items (
  simulation_id UUID NOT NULL
    REFERENCES collection_filter_simulations(id) ON DELETE CASCADE,
  publication_id UUID NOT NULL,
  source_code TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  raw_type TEXT,
  canonical_type TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('KEEP','DISCARD')),
  reason_code TEXT NOT NULL,
  decisive_term TEXT,
  excerpt TEXT,
  title TEXT NOT NULL,
  published_on DATE,
  official_url TEXT,
  review_sample BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (simulation_id, publication_id)
);

CREATE INDEX ix_collection_filter_simulation_items_review
ON collection_filter_simulation_items (
  simulation_id, review_sample, decision, source_code, section
);

CREATE TABLE collection_filter_simulation_feedback (
  simulation_id UUID NOT NULL
    REFERENCES collection_filter_simulations(id) ON DELETE CASCADE,
  publication_id UUID NOT NULL,
  marked_error BOOLEAN NOT NULL DEFAULT true,
  expected_decision TEXT
    CHECK (expected_decision IS NULL OR expected_decision IN ('KEEP','DISCARD')),
  note TEXT,
  created_by UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (simulation_id, publication_id)
);

CREATE UNIQUE INDEX uq_collection_filter_simulation_active
ON collection_filter_simulations (policy_id, policy_revision)
WHERE status IN ('PENDING','RUNNING');

REVOKE ALL ON collection_filter_simulation_items,
  collection_filter_simulation_feedback
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON collection_filter_simulation_items TO radar_app;
GRANT SELECT, INSERT, UPDATE, DELETE
ON collection_filter_simulation_feedback TO radar_app;

ALTER TABLE collection_filter_simulation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_simulation_items FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_simulation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_simulation_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY collection_filter_simulation_items_admin_select
ON collection_filter_simulation_items
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_simulation_feedback_admin_select
ON collection_filter_simulation_feedback
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_simulation_feedback_admin_insert
ON collection_filter_simulation_feedback
FOR INSERT TO radar_app
WITH CHECK (
  app_user_is_platform_admin()
  AND created_by = app_current_user_id()
  AND EXISTS (
    SELECT 1
    FROM collection_filter_simulations s
    WHERE s.id = simulation_id
      AND s.status = 'COMPLETED'
  )
);

CREATE POLICY collection_filter_simulation_feedback_admin_update
ON collection_filter_simulation_feedback
FOR UPDATE TO radar_app
USING (
  app_user_is_platform_admin()
  AND created_by = app_current_user_id()
)
WITH CHECK (
  app_user_is_platform_admin()
  AND created_by = app_current_user_id()
);

CREATE POLICY collection_filter_simulation_feedback_admin_delete
ON collection_filter_simulation_feedback
FOR DELETE TO radar_app
USING (
  app_user_is_platform_admin()
  AND created_by = app_current_user_id()
);

CREATE OR REPLACE FUNCTION collection_filter_request_simulation(
  p_policy_id UUID,
  p_scope TEXT,
  p_review_mode TEXT
)
RETURNS TABLE (
  simulation_id UUID,
  policy_revision INTEGER,
  action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy public.collection_filter_policies%ROWTYPE;
  v_existing public.collection_filter_simulations%ROWTYPE;
  v_new public.collection_filter_simulations%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;

  IF p_scope NOT IN ('FULL_ARCHIVE','RECENT') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_simulation_scope';
  END IF;
  IF p_review_mode NOT IN ('ALL','SAMPLE','NONE') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_simulation_review_mode';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-simulation', 0)
  );

  SELECT * INTO v_policy
  FROM public.collection_filter_policies
  WHERE id=p_policy_id AND status='DRAFT'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='collection_filter_draft_not_found';
  END IF;

  SELECT * INTO v_existing
  FROM public.collection_filter_simulations AS s
  WHERE s.policy_id=v_policy.id
    AND s.policy_revision=v_policy.revision
    AND s.status IN ('PENDING','RUNNING')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY
    SELECT v_existing.id, v_existing.policy_revision, 'EXISTING'::TEXT;
    RETURN;
  END IF;

  INSERT INTO public.collection_filter_simulations(
    policy_id,policy_revision,status,scope,review_mode,created_by
  ) VALUES(
    v_policy.id,v_policy.revision,'PENDING',p_scope,p_review_mode,v_actor
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,'ADMIN',v_actor::TEXT,'COLLECTION_FILTER_SIMULATION_REQUESTED',
    'collection_filter_simulation',v_new.id::TEXT,
    pg_catalog.jsonb_build_object(
      'policyId',v_policy.id,
      'version',v_policy.version,
      'revision',v_policy.revision,
      'scope',p_scope,
      'reviewMode',p_review_mode
    ),
    pg_catalog.gen_random_uuid()
  );

  RETURN QUERY SELECT v_new.id,v_new.policy_revision,'CREATED'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_request_simulation(UUID,TEXT,TEXT)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collection_filter_request_simulation(UUID,TEXT,TEXT)
TO radar_app;

CREATE OR REPLACE FUNCTION collection_filter_approve_draft(
  p_policy_id UUID
)
RETURNS TABLE (
  policy_id UUID,
  policy_version INTEGER,
  policy_revision INTEGER,
  simulation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy public.collection_filter_policies%ROWTYPE;
  v_simulation public.collection_filter_simulations%ROWTYPE;
  v_first_publication BOOLEAN;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='platform_admin_required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-approval', 0)
  );

  SELECT * INTO v_policy
  FROM public.collection_filter_policies
  WHERE id=p_policy_id
  FOR UPDATE;

  IF NOT FOUND OR v_policy.status <> 'DRAFT' THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='collection_filter_draft_not_found';
  END IF;

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.collection_filter_policies previous
    WHERE previous.id <> v_policy.id
      AND previous.status IN ('APPROVED','SUPERSEDED')
  ) INTO v_first_publication;

  SELECT * INTO v_simulation
  FROM public.collection_filter_simulations AS s
  WHERE s.policy_id=v_policy.id
    AND s.policy_revision=v_policy.revision
    AND s.status='COMPLETED'
    AND (NOT v_first_publication OR s.scope='FULL_ARCHIVE')
  ORDER BY s.completed_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF v_first_publication AND EXISTS (
      SELECT 1
      FROM public.collection_filter_simulations s
      WHERE s.policy_id=v_policy.id
        AND s.policy_revision=v_policy.revision
        AND s.status='COMPLETED'
        AND s.scope <> 'FULL_ARCHIVE'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='P0001',
        MESSAGE='collection_filter_full_archive_simulation_required';
    END IF;
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='collection_filter_fresh_simulation_required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.collection_filter_simulation_feedback f
    WHERE f.simulation_id=v_simulation.id
      AND f.marked_error
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='collection_filter_simulation_has_errors';
  END IF;

  UPDATE public.collection_filter_policies
  SET status='SUPERSEDED', updated_at=now()
  WHERE status='APPROVED';

  UPDATE public.collection_filter_policies
  SET status='APPROVED',
      approved_by=v_actor,
      approved_at=now(),
      updated_at=now()
  WHERE id=v_policy.id;

  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,'ADMIN',v_actor::TEXT,'COLLECTION_FILTER_POLICY_APPROVED',
    'collection_filter_policy',v_policy.id::TEXT,
    pg_catalog.jsonb_build_object(
      'version',v_policy.version,
      'revision',v_policy.revision,
      'simulationId',v_simulation.id
    ),
    pg_catalog.gen_random_uuid()
  );

  RETURN QUERY
  SELECT v_policy.id,v_policy.version,v_policy.revision,v_simulation.id;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_approve_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION collection_filter_approve_draft(UUID) TO radar_app;
