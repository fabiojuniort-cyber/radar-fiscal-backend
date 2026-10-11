-- L-10: index-only migration for the 7-day collection_items retention
-- keyset dry-run and bounded DELETE ordered by created_at, id.
-- The project's migrator wraps this in BEGIN/COMMIT: plan the deploy during
-- the authorized :20-:40 window because CREATE INDEX may block writes.
CREATE INDEX IF NOT EXISTS ix_collection_items_created_at_id
  ON public.collection_items (created_at,id);
