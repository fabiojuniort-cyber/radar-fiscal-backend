-- L-11 / 053: ONLY non-destructive lookup indexes used by migration 051.
-- migrate.ts applies this file inside BEGIN/COMMIT. Non-concurrent CREATE INDEX
-- therefore blocks concurrent writes to indexed tables while each build runs;
-- schedule/review the operational window for the ~1 GB collection_items table.
-- No change to publication data, business rules, SQL purge or role privileges.

-- 003/004 left the collection_items FK-side publication lookup unindexed.
-- Exclude NULL history since purge detaches pointers instead of deleting runs.
CREATE INDEX IF NOT EXISTS ix_collection_items_publication_id
  ON public.collection_items (publication_id)
  WHERE publication_id IS NOT NULL;

-- 005 indexed company_publications by company_id (dashboard) only.
-- 051 probes company publication protection twice and publication DELETE
-- also invokes the FK ON DELETE CASCADE check through publication_id.
CREATE INDEX IF NOT EXISTS ix_company_publications_publication_id
  ON public.company_publications (publication_id);

-- 004's collection_run_publications primary key starts with collection_run_id,
-- and its only secondary index starts with publication_id. Cascade deleting
-- publication_versions checks the separate nullable publication_version_id FK.
CREATE INDEX IF NOT EXISTS ix_collection_run_publications_version_id
  ON public.collection_run_publications (publication_version_id)
  WHERE publication_version_id IS NOT NULL;

-- 033's scope state primary key covers publication_id but not the FK referring
-- to publication_scope_events(id, publication_id). 051 deletes state first,
-- then its scope events. Avoid repeated FK-side table scans of remaining state.
CREATE INDEX IF NOT EXISTS ix_publication_scope_state_event_id
  ON public.publication_scope_state (current_event_id, publication_id);

-- 021's unique occurrence_id index covers only ACTIVE links; 051 must purge
-- both ACTIVE and SUPERSEDED references before deleting an occurrence.
CREATE INDEX IF NOT EXISTS ix_taxonomy_candidate_occurrence_links_occurrence
  ON public.taxonomy_candidate_occurrence_links (occurrence_id);

-- 038 keeps sample publication IDs in UUID[]. 051 filters by the overlap &&
-- operator before removing IDs; a GIN array_ops index supports that lookup.
CREATE INDEX IF NOT EXISTS ix_collection_filter_new_types_sample_publication_ids
  ON public.collection_filter_new_types USING GIN (sample_publication_ids);

-- Already indexed by leading lookup key: collection_run_publications.publication_id
-- (004), publication_scope_state.publication_id PK and scope_events.publication_id
-- (033), publication_versions.publication_id and publication_origins.publication_id
-- (004), publication_files.publication_version_id (004), publication_source_feed
-- (029), taxonomy_curator_tags.version and taxonomy_scans.version (031),
-- ncm_mentions.version (026), ncm_scans.version (028),
-- taxonomy_unmapped_occurrences.run_id (021), taxonomy_runs.version (020),
-- taxonomy_assertions.run_id / supersedes_assertion_id (020),
-- taxonomy_spans.assertion_id, taxonomy_reviews.assertion_id (020).
