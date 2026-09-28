-- DOE-SP rebuild — 20 dry-run (READ ONLY, aggregates only).
-- Computes, per table, exactly what 30_rebuild_destructive.sql will change,
-- plus every blocker. Output:
--   DOE_SP_DRY_RUN=<json>
--   \gset-compatible variables expected_* (consumed by 30 via psql -v).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';
\ir 00_assert_read_only.sql

WITH src AS (SELECT id, is_active FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'),
doe_pub AS (SELECT DISTINCT po.publication_id AS id FROM publication_origins po JOIN src ON src.id = po.source_id),
ver AS (SELECT pv.id FROM publication_versions pv JOIN doe_pub d ON d.id = pv.publication_id)
SELECT
  (SELECT count(*) FROM doe_pub) AS expected_publications_kept,
  (SELECT count(*) FROM ver) AS expected_versions_deleted,
  (SELECT count(*) FROM publication_files pf JOIN ver ON ver.id = pf.publication_version_id) AS expected_files_deleted,
  (SELECT count(*) FROM publication_origins po JOIN src ON src.id = po.source_id) AS expected_origins_deleted,
  (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id WHERE crp.publication_version_id IS NOT NULL) AS expected_run_links_version_cleared,
  (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id) AS expected_run_links_kept,
  (SELECT count(*) FROM collection_items ci JOIN doe_pub d ON d.id = ci.publication_id) AS expected_collection_items_kept,
  (SELECT count(*) FROM collection_checkpoints cc JOIN src ON src.id = cc.source_id WHERE cc.connector_key = 'doe-sp') AS expected_checkpoints_deleted,
  CASE WHEN to_regclass('public.norma_clara_translations') IS NULL THEN 0 ELSE
    (xpath('/row/c/text()', query_to_xml(
      'SELECT count(*) AS c FROM norma_clara_translations t WHERE t.publication_version_id IN (
         SELECT pv.id FROM publication_versions pv WHERE pv.publication_id IN (
           SELECT po.publication_id FROM publication_origins po JOIN sources s ON s.id = po.source_id
           WHERE s.code = ''doe-sp'' AND s.connector_key = ''doe-sp''))',
      false, true, '')))[1]::text::bigint END AS expected_translations_deleted,
  -- blockers (all must be 0 for 30 to proceed)
  (SELECT count(*) FROM publication_origins po JOIN doe_pub d ON d.id = po.publication_id JOIN src ON po.source_id <> src.id) AS blocker_cross_source_origins,
  (SELECT count(*) FROM company_publications cp JOIN doe_pub d ON d.id = cp.publication_id) AS blocker_company_publications,
  (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id JOIN collection_runs cr ON cr.id = crp.collection_run_id JOIN src ON cr.source_id <> src.id) AS blocker_foreign_run_links,
  (SELECT count(*) FROM collection_items ci JOIN doe_pub d ON d.id = ci.publication_id JOIN collection_runs cr ON cr.id = ci.collection_run_id JOIN src ON cr.source_id <> src.id) AS blocker_foreign_items,
  (SELECT count(*) FROM collection_runs cr JOIN src ON src.id = cr.source_id WHERE cr.status IN ('PENDING', 'RUNNING')) AS blocker_active_runs,
  (SELECT count(*) FROM src WHERE is_active) AS blocker_source_active,
  (SELECT count(*) FROM pg_constraint WHERE contype = 'f'
     AND confrelid IN ('publications'::regclass, 'publication_versions'::regclass)
     AND conname NOT IN (
       'publication_origins_publication_id_fkey',
       'publication_versions_publication_id_fkey',
       'publication_files_publication_version_id_fkey',
       'collection_run_publications_publication_id_fkey',
       'collection_run_publications_publication_version_id_fkey',
       'fk_collection_item_publication',
       'company_publications_publication_id_fkey',
       'norma_clara_translations_publication_version_id_fkey')) AS blocker_unknown_foreign_keys,
  -- global totals before (30 asserts totals after = before - deleted)
  (SELECT count(*) FROM publications) AS global_publications,
  (SELECT count(*) FROM publication_versions) AS global_versions,
  (SELECT count(*) FROM publication_files) AS global_files,
  (SELECT count(*) FROM publication_origins) AS global_origins,
  (SELECT count(*) FROM collection_run_publications) AS global_run_links,
  (SELECT count(*) FROM collection_items) AS global_collection_items,
  (SELECT count(*) FROM collection_checkpoints) AS global_checkpoints
\gset

SELECT 'DOE_SP_DRY_RUN=' || jsonb_build_object(
  'expected', jsonb_build_object(
    'publications_kept', :expected_publications_kept,
    'publication_versions_deleted', :expected_versions_deleted,
    'publication_files_deleted', :expected_files_deleted,
    'publication_origins_deleted', :expected_origins_deleted,
    'collection_run_publications_version_cleared', :expected_run_links_version_cleared,
    'collection_run_publications_kept', :expected_run_links_kept,
    'collection_items_kept', :expected_collection_items_kept,
    'collection_checkpoints_deleted', :expected_checkpoints_deleted,
    'norma_clara_translations_deleted', :expected_translations_deleted),
  'blockers', jsonb_build_object(
    'cross_source_origins', :blocker_cross_source_origins,
    'company_publications', :blocker_company_publications,
    'foreign_run_links', :blocker_foreign_run_links,
    'foreign_items', :blocker_foreign_items,
    'active_runs', :blocker_active_runs,
    'source_active', :blocker_source_active,
    'unknown_foreign_keys', :blocker_unknown_foreign_keys),
  'globalBefore', jsonb_build_object(
    'publications', :global_publications, 'publication_versions', :global_versions,
    'publication_files', :global_files, 'publication_origins', :global_origins,
    'collection_run_publications', :global_run_links, 'collection_items', :global_collection_items,
    'collection_checkpoints', :global_checkpoints),
  'expectedGlobalAfter', jsonb_build_object(
    'publications', :global_publications,
    'publication_versions', :global_versions - :expected_versions_deleted,
    'publication_files', :global_files - :expected_files_deleted,
    'publication_origins', :global_origins - :expected_origins_deleted,
    'collection_run_publications', :global_run_links,
    'collection_items', :global_collection_items,
    'collection_checkpoints', :global_checkpoints - :expected_checkpoints_deleted)
)::text;

-- Command line for 30 (counts only; safe to publish).
SELECT 'DOE_SP_REBUILD_ARGS=' ||
  '-v expected_publications_kept=' || :expected_publications_kept ||
  ' -v expected_versions_deleted=' || :expected_versions_deleted ||
  ' -v expected_files_deleted=' || :expected_files_deleted ||
  ' -v expected_origins_deleted=' || :expected_origins_deleted ||
  ' -v expected_run_links_version_cleared=' || :expected_run_links_version_cleared ||
  ' -v expected_checkpoints_deleted=' || :expected_checkpoints_deleted ||
  ' -v expected_translations_deleted=' || :expected_translations_deleted;

COMMIT;
