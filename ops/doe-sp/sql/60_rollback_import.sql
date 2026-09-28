-- DOE-SP rebuild — 60 ROLLBACK after a committed 30 (WRITE, one transaction).
--
-- Restores the pre-rebuild DOE-SP rows exactly (same ids) from the backup.
-- Preconditions (asserted):
--   * DOE-SP paused, zero active DOE-SP runs;
--   * the scope has no versions, no DOE-SP origins, no DOE-SP checkpoints
--     (i.e. 30 was just committed, or re-run with fresh 20 counts to clear a
--     partial recapture);
--   * staging schema doe_sp_rollback loaded by runner/rollback-stage.sh from
--     a restore of the verified backup (tables origins, versions, files,
--     run_links, checkpoints — same columns as the live tables, versions
--     without the generated search_vector).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;
LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE publications, publication_origins, publication_versions, publication_files,
  collection_run_publications, collection_checkpoints IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE v_n bigint; v_active boolean;
BEGIN
  SELECT is_active INTO v_active FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp';
  IF v_active IS DISTINCT FROM false THEN RAISE EXCEPTION 'rollback guard: DOE-SP must be paused'; END IF;
  SELECT count(*) INTO v_n FROM collection_runs cr JOIN sources s ON s.id = cr.source_id WHERE s.code = 'doe-sp' AND cr.status IN ('PENDING', 'RUNNING');
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % active DOE-SP runs', v_n; END IF;
  SELECT count(*) INTO v_n FROM publication_origins po JOIN sources s ON s.id = po.source_id WHERE s.code = 'doe-sp';
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % DOE-SP origins still present (run 30 first)', v_n; END IF;
  SELECT count(*) INTO v_n FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id WHERE s.code = 'doe-sp' AND cc.connector_key = 'doe-sp';
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % DOE-SP checkpoints still present', v_n; END IF;
  SELECT count(*) INTO v_n FROM doe_sp_rollback.versions sv WHERE NOT EXISTS (SELECT 1 FROM publications p WHERE p.id = sv.publication_id);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % staged versions whose publication id no longer exists', v_n; END IF;
  SELECT count(*) INTO v_n FROM publication_versions pv JOIN (SELECT DISTINCT publication_id FROM doe_sp_rollback.versions) sp ON sp.publication_id = pv.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % live versions in the staged scope', v_n; END IF;
END
$$;

SELECT
  (SELECT count(*) FROM doe_sp_rollback.origins) AS staged_origins,
  (SELECT count(*) FROM doe_sp_rollback.versions) AS staged_versions,
  (SELECT count(*) FROM doe_sp_rollback.files) AS staged_files,
  (SELECT count(*) FROM doe_sp_rollback.run_links WHERE publication_version_id IS NOT NULL) AS staged_run_links,
  (SELECT count(*) FROM doe_sp_rollback.checkpoints) AS staged_checkpoints
\gset

WITH x AS (INSERT INTO publication_origins SELECT * FROM doe_sp_rollback.origins RETURNING 1)
SELECT count(*) = :staged_origins AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_origins;
\endif

WITH x AS (
  INSERT INTO publication_versions (id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at)
  SELECT id, publication_id, version_no, content_hash, content_text, relevant_excerpt, source_metadata, is_current, captured_at FROM doe_sp_rollback.versions
  RETURNING 1)
SELECT count(*) = :staged_versions AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_versions;
\endif

WITH x AS (INSERT INTO publication_files SELECT * FROM doe_sp_rollback.files RETURNING 1)
SELECT count(*) = :staged_files AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_files;
\endif

WITH x AS (
  UPDATE collection_run_publications crp SET publication_version_id = s.publication_version_id
  FROM doe_sp_rollback.run_links s
  WHERE crp.collection_run_id = s.collection_run_id AND crp.publication_id = s.publication_id
    AND s.publication_version_id IS NOT NULL AND crp.publication_version_id IS NULL
  RETURNING 1)
SELECT count(*) = :staged_run_links AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_run_links;
\endif

WITH x AS (INSERT INTO collection_checkpoints SELECT * FROM doe_sp_rollback.checkpoints RETURNING 1)
SELECT count(*) = :staged_checkpoints AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_checkpoints;
\endif

DROP SCHEMA doe_sp_rollback CASCADE;
SELECT 'DOE_SP_ROLLBACK_RESULT=' || jsonb_build_object(
  'origins', :staged_origins, 'versions', :staged_versions, 'files', :staged_files,
  'runLinks', :staged_run_links, 'checkpoints', :staged_checkpoints)::text;
COMMIT;
\echo 'DOE_SP_ROLLBACK_COMMITTED (source stays paused; resume with 50 only after review)'
