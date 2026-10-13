-- L-17 hotfix: accelerate historical candidate prefilter for >3000 active rules.
-- Index on the SAME immutable normalizer already used by the SQL adapter.
-- Schema-only; does not delete or reclassify any production publications.
-- PostgreSQL evaluates indexed expressions using the INSERT/UPDATE role.
-- This function is a deterministic, database-read-free text normalizer.
-- Grant only EXECUTE (no table privileges) to runtime writer roles so
-- collection inserts do not fail with permission denied.
GRANT EXECUTE ON FUNCTION public.collection_filter_l11_normalize(TEXT)
  TO radar_worker,radar_app,radar_taxonomy_curator;

CREATE INDEX IF NOT EXISTS ix_publications_l17_normalized_type_id
  ON public.publications (public.collection_filter_l11_normalize(act_type),id)
  WHERE act_type IS NOT NULL;
