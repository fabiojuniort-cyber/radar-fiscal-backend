-- DOE-SP rebuild — 30 DESTRUCTIVE (ID-preserving). ONE TRANSACTION.
--
-- NOT AUTHORIZED BY ITSELF. Runs only in the gate that explicitly authorizes
-- the D-052 destructive phase, after: independent review of this file's SHA,
-- fresh backup + restore PASS, DOE-SP paused (sources.is_active = false),
-- zero PENDING/RUNNING DOE-SP runs, and a fresh 20_dry_run_readonly.sql.
--
-- Required psql variables (from 20's DOE_SP_REBUILD_ARGS line):
--   expected_publications_kept, expected_versions_deleted,
--   expected_files_deleted, expected_origins_deleted,
--   expected_run_links_version_cleared, expected_checkpoints_deleted,
--   expected_translations_deleted (must be 0: see ABORT below)
-- Optional: -v confirm=REBUILD_DOE_SP  (anything else => dry execution:
--   every statement runs, every assertion is checked, then ROLLBACK).
--
-- What it does (scope = publications with at least one DOE-SP origin; any
-- publication shared with another source aborts):
--   KEEP     publications rows (ids exposed by the public API stay valid)
--   KEEP     collection_runs, collection_attempts, collection_items
--   KEEP     collection_run_publications rows, version pointer set to NULL
--   DELETE   publication_versions of the scope (publication_files cascade)
--   DELETE   publication_origins of source doe-sp
--   ABORT    if any norma_clara_translations row references a scope version
--            (prototype AI cache, FK ON DELETE CASCADE): deleting it would
--            lose data whose preservation is not designed yet
--   DELETE   collection_checkpoints of connector doe-sp (next run bootstraps
--            from DOE_SP_BOOTSTRAP_START_DATE)
--   KEEP     sources row paused; reactivation is a separate step (runbook)
-- Nothing outside that scope is touched; global totals are asserted.
\set ON_ERROR_STOP 1
\if :{?confirm}
\else
\set confirm DRY
\endif

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL statement_timeout = '300s';
SET LOCAL lock_timeout = '10s';

-- Serialize with Scheduler/Worker/manual triggers. FOR UPDATE on the DOE-SP
-- source row conflicts with the FOR SHARE taken by the scheduler insert
-- (createScheduledCollectionRun), the FOR UPDATE of trigger-doe-sp-run and
-- the FOR KEY SHARE of the collection_runs FK check: no DOE-SP run can be
-- created until this transaction ends, and afterwards the source is still
-- paused, so none is created at all. Table locks keep the scope stable.
SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp' FOR UPDATE;
LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE collection_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE publications, publication_origins, publication_versions, publication_files,
  collection_run_publications, collection_checkpoints IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE doe_sp_rebuild_scope ON COMMIT DROP AS
SELECT DISTINCT po.publication_id AS id
FROM publication_origins po
JOIN sources s ON s.id = po.source_id
WHERE s.code = 'doe-sp' AND s.connector_key = 'doe-sp';

CREATE TEMP TABLE doe_sp_rebuild_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM publications) AS publications,
  (SELECT count(*) FROM publication_versions) AS versions,
  (SELECT count(*) FROM publication_files) AS files,
  (SELECT count(*) FROM publication_origins) AS origins,
  (SELECT count(*) FROM collection_run_publications) AS run_links,
  (SELECT count(*) FROM collection_items) AS items,
  (SELECT count(*) FROM collection_checkpoints) AS checkpoints,
  (SELECT count(*) FROM company_publications) AS company_publications,
  (SELECT count(*) FROM publication_matches) AS matches;

-- ---- guards
DO $$
DECLARE
  v_source_active boolean;
  v_n bigint;
BEGIN
  SELECT is_active INTO v_source_active FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp';
  IF v_source_active IS NULL THEN RAISE EXCEPTION 'guard: DOE-SP source not found'; END IF;
  IF v_source_active THEN RAISE EXCEPTION 'guard: DOE-SP source must be paused (is_active = false)'; END IF;

  SELECT count(*) INTO v_n FROM collection_runs cr JOIN sources s ON s.id = cr.source_id
  WHERE s.code = 'doe-sp' AND cr.status IN ('PENDING', 'RUNNING');
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % active DOE-SP runs', v_n; END IF;

  SELECT count(*) INTO v_n FROM publication_origins po JOIN doe_sp_rebuild_scope d ON d.id = po.publication_id
  JOIN sources s ON s.id = po.source_id WHERE s.code <> 'doe-sp';
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % cross-source origins in scope', v_n; END IF;

  SELECT count(*) INTO v_n FROM company_publications cp JOIN doe_sp_rebuild_scope d ON d.id = cp.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % company_publications (tenant/match links) in scope', v_n; END IF;

  SELECT count(*) INTO v_n FROM collection_run_publications crp JOIN doe_sp_rebuild_scope d ON d.id = crp.publication_id
  JOIN collection_runs cr ON cr.id = crp.collection_run_id JOIN sources s ON s.id = cr.source_id WHERE s.code <> 'doe-sp';
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % foreign run links in scope', v_n; END IF;

  SELECT count(*) INTO v_n FROM collection_items ci JOIN doe_sp_rebuild_scope d ON d.id = ci.publication_id
  JOIN collection_runs cr ON cr.id = ci.collection_run_id JOIN sources s ON s.id = cr.source_id WHERE s.code <> 'doe-sp';
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % collection_items of other sources reference the scope', v_n; END IF;

  IF to_regclass('public.norma_clara_translations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM norma_clara_translations t JOIN publication_versions pv ON pv.id = t.publication_version_id
             JOIN doe_sp_rebuild_scope d ON d.id = pv.publication_id' INTO v_n;
    IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % norma_clara_translations reference scope versions (preservation not designed; do not delete)', v_n; END IF;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'f'
    AND confrelid IN ('publications'::regclass, 'publication_versions'::regclass)
    AND conname NOT IN (
      'publication_origins_publication_id_fkey', 'publication_versions_publication_id_fkey',
      'publication_files_publication_version_id_fkey', 'collection_run_publications_publication_id_fkey',
      'collection_run_publications_publication_version_id_fkey', 'fk_collection_item_publication',
      'company_publications_publication_id_fkey', 'norma_clara_translations_publication_version_id_fkey');
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % unknown foreign keys reference publications/versions (schema drift)', v_n; END IF;
END
$$;

-- ---- expected counts (from the reviewed dry-run) must match the live scope
SELECT
  (SELECT count(*) FROM doe_sp_rebuild_scope) = :expected_publications_kept AS ok_publications,
  (SELECT count(*) FROM publication_versions pv JOIN doe_sp_rebuild_scope d ON d.id = pv.publication_id) = :expected_versions_deleted AS ok_versions,
  (SELECT count(*) FROM publication_files pf JOIN publication_versions pv ON pv.id = pf.publication_version_id JOIN doe_sp_rebuild_scope d ON d.id = pv.publication_id) = :expected_files_deleted AS ok_files,
  (SELECT count(*) FROM publication_origins po JOIN sources s ON s.id = po.source_id WHERE s.code = 'doe-sp') = :expected_origins_deleted AS ok_origins,
  (SELECT count(*) FROM collection_run_publications crp JOIN doe_sp_rebuild_scope d ON d.id = crp.publication_id WHERE crp.publication_version_id IS NOT NULL) = :expected_run_links_version_cleared AS ok_run_links,
  (SELECT count(*) FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id WHERE s.code = 'doe-sp' AND cc.connector_key = 'doe-sp') = :expected_checkpoints_deleted AS ok_checkpoints
\gset
\if :ok_publications
\else
\echo 'ABORT: publications scope differs from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_versions
\else
\echo 'ABORT: versions differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_files
\else
\echo 'ABORT: publication_files differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_origins
\else
\echo 'ABORT: origins differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_run_links
\else
\echo 'ABORT: run links differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_checkpoints
\else
\echo 'ABORT: checkpoints differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif

SELECT to_regclass('public.norma_clara_translations') IS NOT NULL AS has_translations \gset
\if :has_translations
LOCK TABLE norma_clara_translations IN SHARE ROW EXCLUSIVE MODE;
SELECT count(*) = :expected_translations_deleted AS ok_translations
FROM norma_clara_translations t JOIN publication_versions pv ON pv.id = t.publication_version_id
JOIN doe_sp_rebuild_scope d ON d.id = pv.publication_id \gset
\else
SELECT :expected_translations_deleted = 0 AS ok_translations \gset
\endif
\if :ok_translations
\else
\echo 'ABORT: norma_clara_translations differ from dry-run'
SELECT 1/0 AS abort_expected_mismatch;
\endif

-- ---- destructive phase (each statement's row count is asserted)
WITH x AS (
  UPDATE collection_run_publications crp SET publication_version_id = NULL
  FROM doe_sp_rebuild_scope d
  WHERE crp.publication_id = d.id AND crp.publication_version_id IS NOT NULL
  RETURNING 1)
SELECT count(*) = :expected_run_links_version_cleared AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_run_links_update;
\endif

WITH x AS (
  DELETE FROM publication_versions pv USING doe_sp_rebuild_scope d
  WHERE pv.publication_id = d.id
  RETURNING 1)
SELECT count(*) = :expected_versions_deleted AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_versions_delete;
\endif

WITH x AS (
  DELETE FROM publication_origins po USING sources s
  WHERE s.id = po.source_id AND s.code = 'doe-sp'
  RETURNING 1)
SELECT count(*) = :expected_origins_deleted AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_origins_delete;
\endif

WITH x AS (
  DELETE FROM collection_checkpoints cc USING sources s
  WHERE s.id = cc.source_id AND s.code = 'doe-sp' AND cc.connector_key = 'doe-sp'
  RETURNING 1)
SELECT count(*) = :expected_checkpoints_deleted AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_checkpoints_delete;
\endif

-- ---- post-conditions inside the same transaction
SELECT (
  (SELECT count(*) FROM publications) = b.publications
  AND (SELECT count(*) FROM publication_versions) = b.versions - :expected_versions_deleted
  AND (SELECT count(*) FROM publication_files) = b.files - :expected_files_deleted
  AND (SELECT count(*) FROM publication_origins) = b.origins - :expected_origins_deleted
  AND (SELECT count(*) FROM collection_run_publications) = b.run_links
  AND (SELECT count(*) FROM collection_items) = b.items
  AND (SELECT count(*) FROM collection_checkpoints) = b.checkpoints - :expected_checkpoints_deleted
  AND (SELECT count(*) FROM company_publications) = b.company_publications
  AND (SELECT count(*) FROM publication_matches) = b.matches
  AND (SELECT count(*) FROM publication_versions pv JOIN doe_sp_rebuild_scope d ON d.id = pv.publication_id) = 0
  AND (SELECT count(*) FROM publications p JOIN doe_sp_rebuild_scope d ON d.id = p.id) = :expected_publications_kept
) AS ok_post
FROM doe_sp_rebuild_before b \gset
\if :ok_post
\else
\echo 'ABORT: post-conditions failed'
SELECT 1/0 AS abort_post_conditions;
\endif

SELECT 'DOE_SP_REBUILD_RESULT=' || jsonb_build_object(
  'mode', :'confirm',
  'publicationsKept', :expected_publications_kept,
  'versionsDeleted', :expected_versions_deleted,
  'filesDeleted', :expected_files_deleted,
  'originsDeleted', :expected_origins_deleted,
  'runLinksVersionCleared', :expected_run_links_version_cleared,
  'checkpointsDeleted', :expected_checkpoints_deleted,
  'translationsDeleted', :expected_translations_deleted,
  'postConditions', 'PASS')::text;

SELECT :'confirm' = 'REBUILD_DOE_SP' AS do_commit \gset
\if :do_commit
COMMIT;
\echo 'DOE_SP_REBUILD_COMMITTED'
\else
ROLLBACK;
\echo 'DOE_SP_REBUILD_ROLLED_BACK (dry execution; pass -v confirm=REBUILD_DOE_SP to commit)'
\endif
