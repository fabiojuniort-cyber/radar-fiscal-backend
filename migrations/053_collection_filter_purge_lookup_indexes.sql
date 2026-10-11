-- L-11 / 053: ONLY non-destructive lookup indexes used by migration 051 purge.
-- The migrator (migrate.ts) wraps each file in BEGIN/COMMIT; CONCURRENTLY
-- cannot be used here. Build during a controlled window because regular
-- CREATE INDEX briefly blocks writes on the indexed tables.
--
-- 051 UPDATE collection_items SET publication_id=NULL ... has no supporting
-- FK-side lookup index in migration 003/004. Leave historical NULLs out.
CREATE INDEX IF NOT EXISTS ix_collection_items_publication_id
  ON public.collection_items (publication_id)
  WHERE publication_id IS NOT NULL;

-- Migration 021 has a partial unique occurrence_id index only for ACTIVE
-- links. The 051 purge deletes both ACTIVE and SUPERSEDED history.
CREATE INDEX IF NOT EXISTS ix_taxonomy_candidate_occurrence_links_occurrence
  ON public.taxonomy_candidate_occurrence_links (occurrence_id);

-- Migration 038 uses UUID[] samples. Migration 051 removes references with
-- sample_publication_ids && p_ids; GIN array_ops accelerates that predicate.
CREATE INDEX IF NOT EXISTS ix_collection_filter_new_types_sample_publication_ids
  ON public.collection_filter_new_types
  USING GIN (sample_publication_ids);

-- Other 051 delete predicates already have leading-column B-tree indexes:
-- collection_run_publications.publication_id (004), publication_scope_state
-- PK (033), publication_scope_events.publication_id (033),
-- publication_versions.publication_id (004), taxonomy_curator_tags.version
-- (031), taxonomy_scans.version (031), ncm_mentions.version (026),
-- taxonomy_unmapped_occurrences.run_id (021), taxonomy_runs.version (020),
-- taxonomy_assertions.run_id (020), taxonomy_spans.assertion_id (020),
-- taxonomy_reviews.assertion_id (020).
-- No DELETE/UPDATE of domain records, grants, business rules or purge
-- functions is performed by this migration.
