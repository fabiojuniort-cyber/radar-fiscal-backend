-- L-11: targeted writes into the single active APPROVED policy.
-- Deliberately never removes publications. Discarding rule changes use the
-- existing preview/confirm + bounded 500-per-request path from migration 051.
-- No reintroduction of DRAFT, simulation, approval or a second rule engine.
CREATE OR REPLACE FUNCTION public.collection_filter_direct_admin_edit(
  p_action TEXT, p_payload JSONB
)
RETURNS TABLE(policy_revision INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
DECLARE
  v_actor UUID := public.app_current_user_id();
  v_policy UUID;
  v_revision INTEGER;
  v_source TEXT := lower(btrim(coalesce(p_payload->>'sourceCode','')));
  v_section TEXT := upper(btrim(coalesce(p_payload->>'section','')));
  v_type TEXT := upper(btrim(coalesce(p_payload->>'canonicalType','')));
  v_mode TEXT := p_payload->>'mode';
  v_old JSONB := p_payload->'old';
  v_term JSONB := p_payload->'term';
  v_old_term JSONB := p_payload->'oldTerm';
  v_new_type_id UUID;
  v_term_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_edit';
  END IF;

  -- Serialize with direct-rule preview/confirm, preventing concurrent edits.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('collection-filter-direct-rule',0)
  );
  SELECT p.id INTO v_policy FROM public.collection_filter_policies p
    WHERE p.status='APPROVED' FOR UPDATE;
  IF v_policy IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='approved_collection_filter_required';
  END IF;

  IF p_action='RULE_KEEP' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR v_mode<>'KEEP_ALWAYS' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='only_non_discard_rule_edit_allowed';
    END IF;
    INSERT INTO public.collection_filter_type_rules(
      policy_id,source_code,section,canonical_type,mode,help_text)
      VALUES(v_policy,v_source,v_section,v_type,v_mode,NULL)
    ON CONFLICT(policy_id,source_code,section,canonical_type)
      DO UPDATE SET mode=EXCLUDED.mode;

  ELSIF p_action='RULE_DELETE' THEN
    IF v_source='' OR v_section='' OR v_type='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_rule_identity';
    END IF;
    DELETE FROM public.collection_filter_type_rules
      WHERE policy_id=v_policy AND source_code=v_source
        AND section=v_section AND canonical_type=v_type;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_rule_not_found';
    END IF;

  ELSIF p_action='TERM_PUT' THEN
    IF v_term IS NULL OR btrim(coalesce(v_term->>'text',''))=''
       OR btrim(coalesce(v_term->>'normalizedTerm',''))=''
       OR v_term->>'strength' NOT IN('STRONG','WEAK','NEGATIVE')
       OR coalesce(v_term->>'locationScope','ANY') NOT IN
            ('ANY','TITLE','SUMMARY','BODY') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_term';
    END IF;
    IF v_old_term IS NOT NULL THEN
      SELECT t.id INTO v_term_id FROM public.collection_filter_terms t
      WHERE t.policy_id=v_policy
        AND t.normalized_term=v_old_term->>'normalizedTerm'
        AND t.strength=v_old_term->>'strength'
        AND coalesce(t.source_code,'')=coalesce(v_old_term->>'sourceCode','')
        AND coalesce(t.section,'')=coalesce(v_old_term->>'section','')
        AND coalesce(t.canonical_type,'')=coalesce(v_old_term->>'canonicalType','')
        AND t.location_scope=coalesce(v_old_term->>'locationScope','ANY')
      FOR UPDATE;
      IF v_term_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_term_not_found';
      END IF;
      UPDATE public.collection_filter_terms SET
        term_text=btrim(v_term->>'text'),
        normalized_term=v_term->>'normalizedTerm',
        strength=v_term->>'strength',
        source_code=nullif(lower(btrim(coalesce(v_term->>'sourceCode',''))),''),
        section=nullif(upper(btrim(coalesce(v_term->>'section',''))),''),
        canonical_type=nullif(upper(btrim(coalesce(v_term->>'canonicalType',''))),''),
        location_scope=coalesce(v_term->>'locationScope','ANY')
      WHERE id=v_term_id;
    ELSE
      INSERT INTO public.collection_filter_terms(
        policy_id,term_text,normalized_term,strength,
        source_code,section,canonical_type,location_scope
      ) VALUES(
        v_policy,btrim(v_term->>'text'),v_term->>'normalizedTerm',
        v_term->>'strength',
        nullif(lower(btrim(coalesce(v_term->>'sourceCode',''))),''),
        nullif(upper(btrim(coalesce(v_term->>'section',''))),''),
        nullif(upper(btrim(coalesce(v_term->>'canonicalType',''))),''),
        coalesce(v_term->>'locationScope','ANY')
      );
    END IF;

  ELSIF p_action='TERM_DELETE' THEN
    IF v_old_term IS NULL THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='term_identity_required';
    END IF;
    DELETE FROM public.collection_filter_terms t
      WHERE t.policy_id=v_policy
        AND t.normalized_term=v_old_term->>'normalizedTerm'
        AND t.strength=v_old_term->>'strength'
        AND coalesce(t.source_code,'')=coalesce(v_old_term->>'sourceCode','')
        AND coalesce(t.section,'')=coalesce(v_old_term->>'section','')
        AND coalesce(t.canonical_type,'')=coalesce(v_old_term->>'canonicalType','')
        AND t.location_scope=coalesce(v_old_term->>'locationScope','ANY');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_term_not_found';
    END IF;

  ELSIF p_action='ALIAS_PUT' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR btrim(coalesce(p_payload->>'alias',''))='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_direct_alias';
    END IF;
    INSERT INTO public.collection_filter_type_aliases(
      policy_id,source_code,section,normalized_alias,canonical_type
    ) VALUES(
      v_policy,v_source,v_section,upper(btrim(p_payload->>'alias')),v_type)
    ON CONFLICT(policy_id,source_code,section,normalized_alias)
      DO UPDATE SET canonical_type=EXCLUDED.canonical_type;

  ELSIF p_action='ALIAS_DELETE' THEN
    DELETE FROM public.collection_filter_type_aliases
      WHERE policy_id=v_policy AND source_code=v_source AND section=v_section
        AND normalized_alias=upper(btrim(coalesce(p_payload->>'alias','')));
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='direct_alias_not_found';
    END IF;

  ELSIF p_action='NEWTYPE_MERGE' THEN
    IF v_source='' OR v_section='' OR v_type=''
       OR btrim(coalesce(p_payload->>'alias',''))='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_merge';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.collection_filter_type_rules
      WHERE policy_id=v_policy AND source_code=v_source
        AND section=v_section AND canonical_type=v_type) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='merge_target_not_found';
    END IF;
    v_new_type_id=(p_payload->>'newTypeId')::uuid;
    UPDATE public.collection_filter_new_types
      SET status='MERGED',resolved_canonical_type=v_type, resolved_at=now(),
          resolved_by=v_actor
      WHERE id=v_new_type_id AND source_code=v_source AND section=v_section
        AND status='OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='open_new_type_not_found';
    END IF;
    INSERT INTO public.collection_filter_type_aliases(
      policy_id,source_code,section,normalized_alias,canonical_type)
      VALUES(v_policy,v_source,v_section,
        upper(btrim(p_payload->>'alias')),v_type)
      ON CONFLICT(policy_id,source_code,section,normalized_alias)
        DO UPDATE SET canonical_type=EXCLUDED.canonical_type;

  ELSIF p_action='NEWTYPE_KEEP' THEN
    IF v_source='' OR v_section='' OR v_type='' THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid_new_type_keep';
    END IF;
    v_new_type_id=(p_payload->>'newTypeId')::uuid;
    UPDATE public.collection_filter_new_types
      SET status='RESOLVED',resolved_canonical_type=v_type,resolved_at=now(),
          resolved_by=v_actor
      WHERE id=v_new_type_id AND source_code=v_source AND section=v_section
        AND status='OPEN';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='open_new_type_not_found';
    END IF;
    INSERT INTO public.collection_filter_type_rules(
      policy_id,source_code,section,canonical_type,mode,help_text)
      VALUES(v_policy,v_source,v_section,v_type,'KEEP_ALWAYS',NULL)
    ON CONFLICT(policy_id,source_code,section,canonical_type)
      DO UPDATE SET mode='KEEP_ALWAYS';

  ELSE
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='unsupported_direct_edit';
  END IF;

  UPDATE public.collection_filter_policies
    SET revision=revision+1,updated_at=now()
    WHERE id=v_policy RETURNING revision INTO v_revision;
  INSERT INTO public.audit_log(
    tenant_id,actor_type,actor_id,action,entity_type,entity_id,
    after_data,correlation_id
  ) VALUES(
    NULL,'ADMIN',v_actor::text,'COLLECTION_FILTER_DIRECT_ADMIN_EDIT',
    'collection_filter_policy',v_policy::text,
    pg_catalog.jsonb_build_object(
      'action',p_action,'policyRevision',v_revision,
      'payload',p_payload
    ),pg_catalog.gen_random_uuid()
  );
  RETURN QUERY SELECT v_revision;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_direct_admin_edit(TEXT,JSONB)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_direct_admin_edit(TEXT,JSONB)
  TO radar_app;
