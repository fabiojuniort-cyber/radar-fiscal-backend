-- L-18: prevent further loss of DOU customs/federal tax acts.
-- Approved by Fábio via CLAUDE-COORD on 11/10/2026.
-- Policy metadata only. No publication insert/delete, no DOU backfill or DOE-SP purge.
-- Uses the already deployed L11 normalizer; does not modify migration 029.
DO $l18$
DECLARE
  v_policy uuid;
  v_revision integer;
  v_changed_rules integer := 0;
  v_added_terms integer := 0;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-direct-rule', 0)
  );

  SELECT id INTO v_policy
  FROM public.collection_filter_policies
  WHERE status='APPROVED'
  FOR UPDATE;
  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'L18_APPROVED_POLICY_MISSING';
  END IF;

  -- Match *existing* classified DOU types, not all declaratory acts:
  --   ATO DECLARATORIO EXECUTIVO COANA
  --   ATO DECLARATORIO EXECUTIVO [..] RFB/SRRF/DRF
  --   PORTARIA RFB
  UPDATE public.collection_filter_type_rules r
    SET mode='KEEP_ALWAYS'
  WHERE r.policy_id=v_policy
    AND lower(r.source_code)='dou'
    AND r.mode<>'KEEP_ALWAYS'
    AND (
      public.collection_filter_l11_normalize(r.canonical_type)='PORTARIA RFB'
      OR (
        public.collection_filter_l11_normalize(r.canonical_type)
          ~ '^ATO DECLARATORIO EXECUTIVO( |$)'
        AND public.collection_filter_l11_normalize(r.canonical_type)
          ~ '(^| )(COANA|RFB|SRRF|DRF)( |$)'
      )
    );
  GET DIAGNOSTICS v_changed_rules = ROW_COUNT;

  -- Terms apply globally, as requested; existing terms are not destroyed.
  -- An existing STRONG global term is left intact by the unique index.
  INSERT INTO public.collection_filter_terms(
    policy_id,term_text,normalized_term,strength,
    source_code,section,canonical_type,location_scope
  )
  SELECT v_policy,t.term_text,t.normalized_term,'STRONG',
    NULL,NULL,NULL,'ANY'
  FROM (VALUES
    ('COANA','COANA'),
    ('aduaneiro','ADUANEIRO'),
    ('Receita Federal','RECEITA FEDERAL'),
    ('RFB','RFB'),
    ('Recof','RECOF'),
    ('Repetro','REPETRO'),
    ('drawback','DRAWBACK')
  ) t(term_text,normalized_term)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added_terms = ROW_COUNT;

  IF v_changed_rules > 0 OR v_added_terms > 0 THEN
    UPDATE public.collection_filter_policies
      SET revision=revision+1,updated_at=now()
    WHERE id=v_policy
    RETURNING revision INTO v_revision;

    INSERT INTO public.audit_log(
      tenant_id,actor_type,actor_id,action,entity_type,entity_id,
      after_data,correlation_id
    ) VALUES (
      NULL,'SYSTEM','L18_COORD_APPROVED','L18_PRESERVATION_RULES',
      'collection_filter_policy',v_policy::text,
      pg_catalog.jsonb_build_object(
        'policyId',v_policy,'policyRevision',v_revision,
        'changedRuleCount',v_changed_rules,
        'addedStrongTerms',v_added_terms,
        'reason','Avoid recurrence before controlled DOU backfill',
        'approval','Fábio/CLAUDE-COORD, 11/10/2026'
      ),pg_catalog.gen_random_uuid()
    );
  END IF;

  RAISE NOTICE 'L18 preservation: changed_rules=%, added_strong_terms=%, policy_revision=%',
    v_changed_rules,v_added_terms,v_revision;
END;
$l18$;
