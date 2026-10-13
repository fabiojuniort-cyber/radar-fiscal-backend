-- ACT-SCOPE-02 / Stage 6
-- Runtime collection gate, discarded-publication audit trail, retention and rate alerts.

ALTER TABLE collection_items
  DROP CONSTRAINT IF EXISTS collection_items_status_check;

ALTER TABLE collection_items
  ADD CONSTRAINT collection_items_status_check
  CHECK (
    status IN (
      'DISCOVERED',
      'PROCESSED_NEW',
      'PROCESSED_EXISTING',
      'NEW_VERSION',
      'FILTERED_OUT',
      'FAILED'
    )
  );

CREATE TABLE collection_filter_discards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id),
  collection_run_id UUID NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES collection_attempts(id) ON DELETE SET NULL,
  source_item_key TEXT NOT NULL,
  source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
  connector_key TEXT NOT NULL CHECK (btrim(connector_key) <> ''),
  section TEXT NOT NULL DEFAULT '',
  raw_type TEXT,
  canonical_type TEXT,
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  act_number TEXT,
  published_on DATE,
  official_url TEXT NOT NULL CHECK (btrim(official_url) <> ''),
  reason_code TEXT NOT NULL CHECK (btrim(reason_code) <> ''),
  decisive_term TEXT,
  policy_id UUID NOT NULL REFERENCES collection_filter_policies(id),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  discarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '3 months',
  CONSTRAINT uq_collection_filter_discard_run_item
    UNIQUE(collection_run_id, source_item_key)
);

CREATE INDEX ix_collection_filter_discards_recent
ON collection_filter_discards(discarded_at DESC);

CREATE INDEX ix_collection_filter_discards_expiry
ON collection_filter_discards(expires_at);

CREATE INDEX ix_collection_filter_discards_source
ON collection_filter_discards(source_code, discarded_at DESC);

CREATE TABLE collection_filter_discard_run_stats (
  collection_run_id UUID PRIMARY KEY REFERENCES collection_runs(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(id),
  source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
  policy_id UUID NOT NULL REFERENCES collection_filter_policies(id),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  found_count INTEGER NOT NULL CHECK (found_count >= 0),
  discard_count INTEGER NOT NULL CHECK (discard_count >= 0 AND discard_count <= found_count),
  discard_rate NUMERIC(8,6) NOT NULL CHECK (discard_rate >= 0 AND discard_rate <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_collection_filter_discard_stats_source
ON collection_filter_discard_run_stats(source_code, created_at DESC);

CREATE TABLE collection_filter_discard_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_run_id UUID NOT NULL UNIQUE REFERENCES collection_runs(id) ON DELETE CASCADE,
  source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
  discard_rate NUMERIC(8,6) NOT NULL CHECK (discard_rate >= 0 AND discard_rate <= 1),
  baseline_rate NUMERIC(8,6) NOT NULL CHECK (baseline_rate >= 0 AND baseline_rate <= 1),
  threshold_rate NUMERIC(8,6) NOT NULL CHECK (threshold_rate >= 0 AND threshold_rate <= 1),
  found_count INTEGER NOT NULL CHECK (found_count >= 0),
  discard_count INTEGER NOT NULL CHECK (discard_count >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES app_users(id) ON DELETE SET NULL
);

CREATE INDEX ix_collection_filter_discard_alerts_open
ON collection_filter_discard_alerts(status, created_at DESC);

REVOKE ALL ON
  collection_filter_discards,
  collection_filter_discard_run_stats,
  collection_filter_discard_alerts
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON
  collection_filter_discards,
  collection_filter_discard_run_stats,
  collection_filter_discard_alerts
TO radar_app;

ALTER TABLE collection_filter_discards ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_discards FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_discard_run_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_discard_run_stats FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_discard_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_discard_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY collection_filter_discards_admin_select
ON collection_filter_discards
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_discard_stats_admin_select
ON collection_filter_discard_run_stats
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_discard_alerts_admin_select
ON collection_filter_discard_alerts
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE OR REPLACE FUNCTION collection_filter_record_discard(
  p_source_id UUID,
  p_run_id UUID,
  p_attempt_id UUID,
  p_source_item_key TEXT,
  p_external_id TEXT,
  p_source_code TEXT,
  p_connector_key TEXT,
  p_section TEXT,
  p_raw_type TEXT,
  p_canonical_type TEXT,
  p_title TEXT,
  p_act_number TEXT,
  p_published_on DATE,
  p_official_url TEXT,
  p_reason_code TEXT,
  p_decisive_term TEXT,
  p_policy_id UUID,
  p_policy_version INTEGER,
  p_policy_revision INTEGER
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

  INSERT INTO public.collection_items(
    collection_run_id,first_attempt_id,source_item_key,external_id,source_url,
    status,publication_id,error_code,error_message,raw_metadata
  ) VALUES(
    p_run_id,p_attempt_id,p_source_item_key,NULLIF(btrim(p_external_id),''),
    NULLIF(btrim(p_official_url),''),
    'FILTERED_OUT',NULL,NULL,NULL,'{}'::jsonb
  )
  ON CONFLICT (collection_run_id,source_item_key)
  DO UPDATE SET
    external_id=EXCLUDED.external_id,
    source_url=EXCLUDED.source_url,
    status='FILTERED_OUT',
    publication_id=NULL,
    error_code=NULL,
    error_message=NULL,
    raw_metadata='{}'::jsonb,
    updated_at=now();

  INSERT INTO public.collection_filter_discards(
    source_id,collection_run_id,attempt_id,source_item_key,source_code,
    connector_key,section,raw_type,canonical_type,title,act_number,published_on,
    official_url,reason_code,decisive_term,policy_id,policy_version,policy_revision
  ) VALUES(
    p_source_id,p_run_id,p_attempt_id,p_source_item_key,lower(btrim(p_source_code)),
    btrim(p_connector_key),upper(COALESCE(btrim(p_section),'')),
    NULLIF(btrim(p_raw_type),''),NULLIF(btrim(p_canonical_type),''),
    btrim(p_title),NULLIF(btrim(p_act_number),''),p_published_on,
    btrim(p_official_url),btrim(p_reason_code),NULLIF(btrim(p_decisive_term),''),
    p_policy_id,p_policy_version,p_policy_revision
  )
  ON CONFLICT (collection_run_id,source_item_key)
  DO UPDATE SET
    attempt_id=EXCLUDED.attempt_id,
    raw_type=EXCLUDED.raw_type,
    canonical_type=EXCLUDED.canonical_type,
    title=EXCLUDED.title,
    act_number=EXCLUDED.act_number,
    published_on=EXCLUDED.published_on,
    official_url=EXCLUDED.official_url,
    reason_code=EXCLUDED.reason_code,
    decisive_term=EXCLUDED.decisive_term,
    policy_id=EXCLUDED.policy_id,
    policy_version=EXCLUDED.policy_version,
    policy_revision=EXCLUDED.policy_revision,
    discarded_at=now(),
    expires_at=now() + interval '3 months';
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_record_unknown_type(
  p_source_code TEXT,
  p_section TEXT,
  p_raw_type TEXT,
  p_normalized_type TEXT,
  p_publication_id UUID
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

  INSERT INTO public.collection_filter_new_types(
    source_code,section,normalized_type,sample_raw_type,
    occurrence_count,first_seen_at,last_seen_at,sample_publication_ids,status
  ) VALUES(
    lower(btrim(p_source_code)),upper(COALESCE(btrim(p_section),'')),
    btrim(p_normalized_type),btrim(p_raw_type),1,now(),now(),
    ARRAY[p_publication_id]::uuid[],'OPEN'
  )
  ON CONFLICT (source_code,section,normalized_type)
  DO UPDATE SET
    sample_raw_type=EXCLUDED.sample_raw_type,
    occurrence_count=public.collection_filter_new_types.occurrence_count+1,
    last_seen_at=now(),
    sample_publication_ids=CASE
      WHEN p_publication_id=ANY(public.collection_filter_new_types.sample_publication_ids)
        THEN public.collection_filter_new_types.sample_publication_ids
      ELSE (public.collection_filter_new_types.sample_publication_ids || p_publication_id)[1:3]
    END,
    status=CASE
      WHEN public.collection_filter_new_types.status='MERGED' THEN 'MERGED'
      ELSE public.collection_filter_new_types.status
    END;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_cleanup_discards()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_deleted INTEGER;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;

  DELETE FROM public.collection_filter_discards
  WHERE expires_at <= now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION collection_filter_record_run_stats(
  p_run_id UUID,
  p_source_id UUID,
  p_source_code TEXT,
  p_policy_id UUID,
  p_policy_version INTEGER,
  p_policy_revision INTEGER,
  p_found_count INTEGER,
  p_discard_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rate NUMERIC(8,6);
  v_baseline NUMERIC(8,6);
  v_baseline_count INTEGER;
  v_threshold NUMERIC(8,6);
  v_alerted BOOLEAN := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'radar_worker', 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='collection_filter_worker_required';
  END IF;
  IF p_found_count < 0 OR p_discard_count < 0 OR p_discard_count > p_found_count THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_collection_filter_run_stats';
  END IF;

  v_rate := CASE WHEN p_found_count=0 THEN 0
                 ELSE p_discard_count::numeric / p_found_count::numeric END;

  SELECT avg(x.discard_rate)::numeric(8,6),count(*)::int
    INTO v_baseline,v_baseline_count
  FROM (
    SELECT discard_rate
    FROM public.collection_filter_discard_run_stats
    WHERE source_code=lower(btrim(p_source_code))
      AND collection_run_id<>p_run_id
    ORDER BY created_at DESC
    LIMIT 10
  ) x;

  INSERT INTO public.collection_filter_discard_run_stats(
    collection_run_id,source_id,source_code,policy_id,policy_version,
    policy_revision,found_count,discard_count,discard_rate
  ) VALUES(
    p_run_id,p_source_id,lower(btrim(p_source_code)),p_policy_id,
    p_policy_version,p_policy_revision,p_found_count,p_discard_count,v_rate
  )
  ON CONFLICT (collection_run_id)
  DO UPDATE SET
    found_count=EXCLUDED.found_count,
    discard_count=EXCLUDED.discard_count,
    discard_rate=EXCLUDED.discard_rate;

  IF v_baseline_count >= 3 AND p_found_count >= 20 AND p_discard_count >= 10 THEN
    v_threshold := LEAST(1::numeric,GREATEST(0.50::numeric,v_baseline + 0.20::numeric));
    IF v_rate >= v_threshold THEN
      INSERT INTO public.collection_filter_discard_alerts(
        collection_run_id,source_code,discard_rate,baseline_rate,threshold_rate,
        found_count,discard_count
      ) VALUES(
        p_run_id,lower(btrim(p_source_code)),v_rate,v_baseline,v_threshold,
        p_found_count,p_discard_count
      )
      ON CONFLICT (collection_run_id) DO NOTHING;
      v_alerted := true;
    END IF;
  END IF;

  RETURN v_alerted;
END;
$$;

REVOKE ALL ON FUNCTION collection_filter_record_discard(
  UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,UUID,INTEGER,INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_record_unknown_type(TEXT,TEXT,TEXT,TEXT,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_cleanup_discards() FROM PUBLIC;
REVOKE ALL ON FUNCTION collection_filter_record_run_stats(UUID,UUID,TEXT,UUID,INTEGER,INTEGER,INTEGER,INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION collection_filter_record_discard(
  UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT,UUID,INTEGER,INTEGER
) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_record_unknown_type(TEXT,TEXT,TEXT,TEXT,UUID) TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_cleanup_discards() TO radar_worker;
GRANT EXECUTE ON FUNCTION collection_filter_record_run_stats(UUID,UUID,TEXT,UUID,INTEGER,INTEGER,INTEGER,INTEGER) TO radar_worker;
