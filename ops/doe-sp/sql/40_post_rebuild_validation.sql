-- DOE-SP rebuild — 40 validation right after 30 COMMIT (READ ONLY, aggregates).
-- Requires -v expected_publications_kept=<n> (same value used by 30).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\ir 00_assert_read_only.sql
WITH src AS (SELECT id, is_active FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp')
SELECT
  (SELECT count(*) FROM publication_origins po JOIN src ON src.id = po.source_id) = 0
  AND (SELECT count(*) FROM collection_checkpoints cc JOIN src ON src.id = cc.source_id WHERE cc.connector_key = 'doe-sp') = 0
  AND (SELECT count(*) FROM collection_runs cr JOIN src ON src.id = cr.source_id WHERE cr.status IN ('PENDING', 'RUNNING')) = 0
  AND (SELECT bool_and(NOT is_active) FROM src)
  AND (SELECT count(*) FROM publications p
       WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM publication_versions pv WHERE pv.publication_id = p.id)) = :expected_publications_kept
  AS ok_post_rebuild \gset
SELECT 'DOE_SP_POST_REBUILD=' || CASE WHEN :'ok_post_rebuild' = 't' THEN 'PASS' ELSE 'FAIL' END;
COMMIT;
\if :ok_post_rebuild
\else
SELECT 1/0 AS post_rebuild_failed;
\endif
