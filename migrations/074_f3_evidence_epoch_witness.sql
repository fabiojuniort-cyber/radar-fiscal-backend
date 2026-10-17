-- F3-PERF-02. Strict, transactionally maintained evidence revision.
-- A preview witness is invalid after ANY committed change to F3 inputs.
-- Statement-level triggers avoid per-row overhead for large ingestion batches.
-- Per-table epoch rows reduce write contention between different evidence tables.
CREATE TABLE public.collection_filter_f3_evidence_epoch (
  table_name TEXT PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
INSERT INTO public.collection_filter_f3_evidence_epoch(table_name)
VALUES ('publications'),('publication_versions'),('publication_origins'),
  ('publication_files'),('company_publications'),('sources'),
  ('collection_filter_policies'),('collection_filter_type_rules'),
  ('collection_filter_type_aliases'),('collection_filter_terms');
REVOKE ALL ON public.collection_filter_f3_evidence_epoch FROM PUBLIC;

CREATE FUNCTION public.collection_filter_f3_epoch_touch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.collection_filter_f3_evidence_epoch
  SET revision=revision+1 WHERE table_name=TG_TABLE_NAME;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'untracked_f3_evidence_table: %',TG_TABLE_NAME;
  END IF;
  RETURN NULL; -- statement-level trigger; ignored
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_f3_epoch_touch() FROM PUBLIC;

-- Strict snapshot: on save, lock ALL evidence epochs until transaction commit.
-- Every mutation touches its table epoch inside its own writer transaction.
-- The lock serializes concurrent evidence changes after validation, preventing
-- the unchecked window between an accepted preview and saving a policy rule.
CREATE FUNCTION public.collection_filter_f3_evidence_stamp(p_lock BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE v_stamp TEXT;
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.app_user_is_platform_admin() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform_admin_required';
  END IF;
  IF p_lock THEN
    SELECT string_agg(t.table_name||':'||t.revision::text,'|' ORDER BY t.table_name)
      INTO v_stamp
    FROM (SELECT table_name,revision
          FROM public.collection_filter_f3_evidence_epoch
          ORDER BY table_name FOR SHARE) t;
  ELSE
    SELECT string_agg(table_name||':'||revision::text,'|' ORDER BY table_name)
      INTO v_stamp
    FROM public.collection_filter_f3_evidence_epoch;
  END IF;
  RETURN v_stamp;
END;
$$;
REVOKE ALL ON FUNCTION public.collection_filter_f3_evidence_stamp(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collection_filter_f3_evidence_stamp(BOOLEAN) TO radar_app;

-- Track only columns used to classify/rank F3 evidence where possible.
-- INSERT/DELETE/TRUNCATE always invalidate; no old row can be silently reused.
DO $$
DECLARE t RECORD;
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('publications','id,title,act_type'),
   ('publication_versions','id,publication_id,is_current,content_text,relevant_excerpt,source_metadata,content_hash'),
   ('publication_origins','id,publication_id,source_id,metadata'),
   ('publication_files','id,publication_version_id'),
   ('company_publications','publication_id,company_id'),
   ('sources','id,code'),
   ('collection_filter_policies','id,version,revision,status,context_window_words,weak_score_threshold,title_weight,summary_weight,body_weight'),
   ('collection_filter_type_rules','policy_id,source_code,section,canonical_type,mode'),
   ('collection_filter_type_aliases','policy_id,source_code,section,normalized_alias,canonical_type'),
   ('collection_filter_terms','policy_id,term_text,strength,source_code,section,canonical_type,location_scope')
 ) AS tracked(relation_name,updated_columns)
 LOOP
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.collection_filter_f3_epoch_touch()',
     'trg_f3_witness_insert_delete_'||t.relation_name,t.relation_name);
   EXECUTE format('CREATE TRIGGER %I AFTER UPDATE OF %s ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.collection_filter_f3_epoch_touch()',
     'trg_f3_witness_update_'||t.relation_name,t.updated_columns,t.relation_name);
   EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.collection_filter_f3_epoch_touch()',
     'trg_f3_witness_truncate_'||t.relation_name,t.relation_name);
 END LOOP;
END;
$$;
