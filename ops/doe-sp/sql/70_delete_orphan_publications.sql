-- DOE-SP-40 repair A — delete 6 orphan DOE-SP publications. ONE TRANSACTION.
--
-- NOT AUTHORIZED BY ITSELF. Runs only after independent review of this file's
-- SHA and explicit authorization (tribusca-control Issue #1).
--
-- The 6 rows were created by a DOE-SP run on 2026-09-24 (before the rebuild)
-- and have no version and no origin: shells of acts the current rules exclude
-- (read-only diagnostic, Issue #1). Nothing else references them except run
-- history:
--   collection_items.publication_id  (FK NO ACTION)   -> set to NULL, rows kept
--   collection_run_publications      (FK CASCADE)     -> deleted with the row
--   company_publications             (FK CASCADE)     -> must be 0 (guard)
--   publication_scope_events/state   (FK RESTRICT)    -> must be 0 (guard;
--     SUPPRESS/RESTORE audit is never deleted by this repair)
--
-- Usage:
--   dry execution (default): every statement runs, counts are printed as
--     DOE_SP_ORPHANS_RESULT, then ROLLBACK;
--   commit: -v confirm=DELETE_DOE_SP_ORPHANS -v expected_items=<n>
--     -v expected_run_links=<n>, with the counts printed by the dry execution.
\set ON_ERROR_STOP 1
\if :{?confirm}
\else
\set confirm DRY
\endif
SELECT :'confirm' = 'DELETE_DOE_SP_ORPHANS' AS do_commit \gset
\if :do_commit
\if :{?expected_items}
\else
\echo 'ABORT: expected_items is required to commit'
SELECT 1/0 AS abort_missing_expected;
\endif
\if :{?expected_run_links}
\else
\echo 'ABORT: expected_run_links is required to commit'
SELECT 1/0 AS abort_missing_expected;
\endif
\else
\set expected_items -1
\set expected_run_links -1
\endif

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';

-- Locks before the first query (see 30_rebuild_destructive.sql). The scope
-- ledger is locked too so a concurrent SUPPRESS/RESTORE cannot appear after
-- the guard and before the orphan deletion.
LOCK TABLE collection_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE publications, publication_origins, publication_versions,
  collection_run_publications, company_publications,
  publication_scope_events, publication_scope_state
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE doe_sp_orphans ON COMMIT DROP AS
SELECT id::uuid FROM (VALUES
  ('edb93609-1b91-48a5-8b97-73acf2338b0d'),
  ('fa400479-0ee3-4190-9602-042921cd610a'),
  ('c7b1dd94-dad1-4680-ace5-4c5bb83084a2'),
  ('1e080fc5-fc71-4b81-ad0f-7077ff82abca'),
  ('bad1986a-99b5-4258-9e01-4c5b7909d6b6'),
  ('9cb11b7b-a9cd-48dc-8de4-c5fe33c6c883')
) AS v(id);

CREATE TEMP TABLE doe_sp_orphans_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM publications) AS publications,
  (SELECT count(*) FROM publication_versions) AS versions,
  (SELECT count(*) FROM publication_origins) AS origins,
  (SELECT count(*) FROM collection_items) AS items,
  (SELECT count(*) FROM collection_items WHERE publication_id IS NULL) AS items_unlinked,
  (SELECT count(*) FROM collection_run_publications) AS run_links,
  (SELECT count(*) FROM company_publications) AS company_publications,
  (SELECT count(*) FROM collection_items ci JOIN doe_sp_orphans o ON o.id = ci.publication_id) AS scope_items,
  (SELECT count(*) FROM collection_run_publications crp JOIN doe_sp_orphans o ON o.id = crp.publication_id) AS scope_run_links;

-- ---- guards: every row is still an orphan created by DOE-SP
DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM publications p JOIN doe_sp_orphans o ON o.id = p.id;
  IF v_n <> 6 THEN RAISE EXCEPTION 'guard: % of 6 orphan publications found', v_n; END IF;

  SELECT count(*) INTO v_n FROM publication_versions pv JOIN doe_sp_orphans o ON o.id = pv.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % versions exist (not an orphan any more)', v_n; END IF;

  SELECT count(*) INTO v_n FROM publication_origins po JOIN doe_sp_orphans o ON o.id = po.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % origins exist (not an orphan any more)', v_n; END IF;

  SELECT count(*) INTO v_n FROM company_publications cp JOIN doe_sp_orphans o ON o.id = cp.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % company_publications reference the orphans', v_n; END IF;

  -- SUPPRESS/RESTORE history is append-only evidence. A publication that has
  -- entered scope governance is no longer eligible for this legacy hard delete.
  SELECT count(*) INTO v_n
  FROM publication_scope_events pse
  JOIN doe_sp_orphans o ON o.id = pse.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % publication scope events reference the orphans (preserve SUPPRESS/RESTORE audit; do not delete)', v_n; END IF;

  SELECT count(*) INTO v_n
  FROM publication_scope_state pss
  JOIN doe_sp_orphans o ON o.id = pss.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % publication scope state rows reference the orphans (restore/govern scope first)', v_n; END IF;

  -- Only DOE-SP run history may point at them.
  SELECT count(*) INTO v_n FROM collection_items ci JOIN doe_sp_orphans o ON o.id = ci.publication_id
  JOIN collection_runs cr ON cr.id = ci.collection_run_id JOIN sources s ON s.id = cr.source_id
  WHERE NOT (s.code = 'doe-sp' AND s.connector_key = 'doe-sp');
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % collection_items of other sources reference the orphans', v_n; END IF;

  SELECT count(*) INTO v_n FROM collection_run_publications crp JOIN doe_sp_orphans o ON o.id = crp.publication_id
  JOIN collection_runs cr ON cr.id = crp.collection_run_id JOIN sources s ON s.id = cr.source_id
  WHERE NOT (s.code = 'doe-sp' AND s.connector_key = 'doe-sp');
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % run links of other sources reference the orphans', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'f'
    AND confrelid = 'publications'::regclass
    AND conname NOT IN (
      'publication_origins_publication_id_fkey', 'publication_versions_publication_id_fkey',
      'collection_run_publications_publication_id_fkey', 'fk_collection_item_publication',
      'company_publications_publication_id_fkey',
      'publication_scope_events_publication_id_fkey',
      'publication_scope_state_publication_id_fkey');
  IF v_n <> 0 THEN RAISE EXCEPTION 'guard: % unknown foreign keys reference publications (schema drift)', v_n; END IF;
END
$$;

-- ---- expected counts (commit only) must match the live scope
SELECT :expected_items < 0
    OR (SELECT scope_items FROM doe_sp_orphans_before) = :expected_items AS ok_items,
  :expected_run_links < 0
    OR (SELECT scope_run_links FROM doe_sp_orphans_before) = :expected_run_links AS ok_run_links
\gset
\if :ok_items
\else
\echo 'ABORT: collection_items referencing the orphans differ from the dry execution'
SELECT 1/0 AS abort_expected_mismatch;
\endif
\if :ok_run_links
\else
\echo 'ABORT: run links of the orphans differ from the dry execution'
SELECT 1/0 AS abort_expected_mismatch;
\endif

-- ---- destructive phase (row counts asserted)
WITH x AS (
  UPDATE collection_items ci SET publication_id = NULL, updated_at = now()
  FROM doe_sp_orphans o WHERE ci.publication_id = o.id
  RETURNING 1)
SELECT count(*) = (SELECT scope_items FROM doe_sp_orphans_before) AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_items_unlink;
\endif

WITH x AS (
  DELETE FROM publications p USING doe_sp_orphans o WHERE p.id = o.id
  RETURNING 1)
SELECT count(*) = 6 AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_publications_delete;
\endif

-- ---- post-conditions inside the same transaction
SELECT (
  (SELECT count(*) FROM publications) = b.publications - 6
  AND (SELECT count(*) FROM publication_versions) = b.versions
  AND (SELECT count(*) FROM publication_origins) = b.origins
  AND (SELECT count(*) FROM collection_items) = b.items
  AND (SELECT count(*) FROM collection_items WHERE publication_id IS NULL) = b.items_unlinked + b.scope_items
  AND (SELECT count(*) FROM collection_run_publications) = b.run_links - b.scope_run_links
  AND (SELECT count(*) FROM company_publications) = b.company_publications
  AND (SELECT count(*) FROM publications p JOIN doe_sp_orphans o ON o.id = p.id) = 0
) AS ok_post
FROM doe_sp_orphans_before b \gset
\if :ok_post
\else
\echo 'ABORT: post-conditions failed'
SELECT 1/0 AS abort_post_conditions;
\endif

SELECT 'DOE_SP_ORPHANS_RESULT=' || jsonb_build_object(
  'mode', :'confirm',
  'publicationsDeleted', 6,
  'collectionItemsUnlinked', b.scope_items,
  'runLinksDeleted', b.scope_run_links,
  'postConditions', 'PASS')::text
FROM doe_sp_orphans_before b;

\if :do_commit
COMMIT;
\echo 'DOE_SP_ORPHANS_COMMITTED'
\else
ROLLBACK;
\echo 'DOE_SP_ORPHANS_ROLLED_BACK (dry execution; pass -v confirm=DELETE_DOE_SP_ORPHANS with the expected counts to commit)'
\endif
