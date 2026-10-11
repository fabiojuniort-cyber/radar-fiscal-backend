-- L-17: audit every physically purged archive publication in the same
-- transaction, preserving the three-month Desconsiderados retention.
-- Existing collection discards continue to use their real collection_run_id.
-- No existing historical publications or discard rows are backfilled.
ALTER TABLE public.collection_filter_discards
  ALTER COLUMN collection_run_id DROP NOT NULL;

ALTER TABLE public.collection_filter_discards
  ADD COLUMN discard_origin TEXT NOT NULL DEFAULT 'COLLECTION'
    CHECK (discard_origin IN ('COLLECTION','ARCHIVE')),
  ADD COLUMN archive_publication_id UUID,
  ADD COLUMN rule_mode TEXT,
  ADD COLUMN archive_policy_rule TEXT;

ALTER TABLE public.collection_filter_discards
  ADD CONSTRAINT l17_archive_origin_shape CHECK (
    (discard_origin='COLLECTION' AND collection_run_id IS NOT NULL
      AND archive_publication_id IS NULL)
    OR (discard_origin='ARCHIVE' AND collection_run_id IS NULL
      AND archive_publication_id IS NOT NULL)
  );

CREATE UNIQUE INDEX ix_collection_filter_discards_archive_publication
  ON public.collection_filter_discards(archive_publication_id)
  WHERE discard_origin='ARCHIVE';

-- Trigger is intentionally limited to deletions already authorized by the
-- guarded 051/L17 purge transaction. It never makes an item eligible and
-- cannot be called independently by radar_app/radar_worker.
CREATE FUNCTION public.l17_capture_archive_discard()
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
BEGIN
  IF pg_catalog.current_setting('app.collection_filter_l11_purge',true)
     IS DISTINCT FROM 'authorized' THEN
    RETURN OLD;
  END IF;
  IF NOT public.collection_filter_l11_purge_guard() THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='archive_discard_requires_guarded_purge';
  END IF;
  SELECT so,po INTO v_source,v_origin
  FROM public.publication_origins po
  JOIN public.sources so ON so.id=po.source_id
  WHERE po.publication_id=OLD.id AND so.code='dou'
  ORDER BY po.id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='archive_discard_missing_dou_origin';
  END IF;
  v_section:=COALESCE(v_origin.metadata->'dou'->>'section','');
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
    WHERE r.policy_id=v_policy.id AND r.source_code='dou'
      AND public.collection_filter_l11_normalize(r.section)=
        public.collection_filter_l11_normalize(v_section)
      AND public.collection_filter_l11_normalize(r.canonical_type)=
        public.collection_filter_l11_normalize(COALESCE(OLD.act_type,''))
    LIMIT 1;
  INSERT INTO public.collection_filter_discards(
    source_id,collection_run_id,attempt_id,source_item_key,
    source_code,connector_key,section,raw_type,canonical_type,title,
    act_number,published_on,official_url,reason_code,decisive_term,
    policy_id,policy_version,policy_revision,discard_origin,
    archive_publication_id,rule_mode,archive_policy_rule
  ) VALUES (
    v_source.id,NULL,NULL,'archive:'||OLD.id::text,
    'dou',v_source.connector_key,upper(v_section),
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
REVOKE ALL ON FUNCTION public.l17_capture_archive_discard() FROM PUBLIC;
CREATE TRIGGER l17_capture_archive_discard
  BEFORE DELETE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION public.l17_capture_archive_discard();
