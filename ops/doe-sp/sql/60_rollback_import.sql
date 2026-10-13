-- DOE-SP rebuild — 60 ROLLBACK to the backup state (WRITE, one transaction).
--
-- Valid right after 30 AND after any partial recapture. Brings the DOE-SP
-- scope back to exactly what the verified backup holds (same ids, same
-- canonical fields, same links), removes everything the recapture created,
-- and leaves every other source untouched.
--
-- Preconditions (asserted):
--   * DOE-SP paused (sources.is_active = false) and zero PENDING/RUNNING
--     DOE-SP runs;
--   * schema doe_sp_rollback staged by runner/rollback-stage.sh from a
--     restore of the verified backup;
--   * nothing outside DOE-SP became linked to the scope during the window
--     (other-source origins/items/run links, company_publications): abort.
--
-- Steps:
--   1. delete DOE-SP runs that did not exist at backup time (recapture runs;
--      cascade: attempts, collection_items, collection_run_publications);
--   2. delete translations and versions (files cascade) of every publication
--      the DOE-SP scope touches now or touched at backup time;
--   3. delete all DOE-SP origins and checkpoints;
--   4. delete publications created during the window (no longer referenced);
--   5. restore the full publications rows of the backup scope (canonical
--      fields: title, effective_on, primary_official_url, last_seen_at, ...);
--   6. re-insert origins, versions, files, translations, checkpoints and
--      re-point the backup-era run links, with row-count assertions.
\set ON_ERROR_STOP 1
-- Detected outside the transaction: the table locks must precede its first query.
SELECT to_regclass('public.norma_clara_translations') IS NOT NULL AS has_translations,
       to_regclass('doe_sp_rollback.translations') IS NOT NULL AS has_staged_translations \gset

BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ WRITE;
SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '10s';
SET LOCAL client_min_messages = warning;

-- Table locks before the first query: the SERIALIZABLE snapshot then includes
-- every write committed while this transaction waited for them, so the guards
-- below see it (same reasoning as 30).
LOCK TABLE collection_runs, collection_items IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE publications, publication_origins, publication_versions, publication_files,
  collection_run_publications, collection_checkpoints IN SHARE ROW EXCLUSIVE MODE;
\if :has_translations
LOCK TABLE norma_clara_translations IN SHARE ROW EXCLUSIVE MODE;
\endif
SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp' FOR UPDATE;

CREATE TEMP TABLE rb_src ON COMMIT DROP AS
  SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp';
CREATE TEMP TABLE rb_staged_pub ON COMMIT DROP AS SELECT id FROM doe_sp_rollback.publications;
CREATE TEMP TABLE rb_post_runs ON COMMIT DROP AS
  SELECT cr.id FROM collection_runs cr JOIN rb_src s ON s.id = cr.source_id
  WHERE cr.id NOT IN (SELECT id FROM doe_sp_rollback.runs);
CREATE TEMP TABLE rb_touched ON COMMIT DROP AS
  SELECT id FROM rb_staged_pub
  UNION SELECT po.publication_id FROM publication_origins po JOIN rb_src s ON s.id = po.source_id
  UNION SELECT crp.publication_id FROM collection_run_publications crp JOIN rb_post_runs r ON r.id = crp.collection_run_id
  UNION SELECT ci.publication_id FROM collection_items ci JOIN rb_post_runs r ON r.id = ci.collection_run_id WHERE ci.publication_id IS NOT NULL;
CREATE TEMP TABLE rb_new_pub ON COMMIT DROP AS
  SELECT id FROM rb_touched WHERE id NOT IN (SELECT id FROM rb_staged_pub);

CREATE TEMP TABLE rb_other_before ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM publication_origins po WHERE po.source_id <> (SELECT id FROM rb_src)) AS origins,
  (SELECT count(*) FROM collection_runs cr WHERE cr.source_id <> (SELECT id FROM rb_src)) AS runs,
  (SELECT count(*) FROM collection_items ci JOIN collection_runs cr ON cr.id = ci.collection_run_id WHERE cr.source_id <> (SELECT id FROM rb_src)) AS items,
  (SELECT count(*) FROM publication_versions pv WHERE pv.publication_id NOT IN (SELECT id FROM rb_touched)) AS versions,
  (SELECT count(*) FROM publications p WHERE p.id NOT IN (SELECT id FROM rb_touched)) AS publications,
  (SELECT count(*) FROM company_publications) AS company_publications,
  (SELECT count(*) FROM publication_matches) AS matches;

DO $$
DECLARE v_n bigint; v_active boolean;
BEGIN
  SELECT is_active INTO v_active FROM sources WHERE id = (SELECT id FROM rb_src);
  IF v_active IS DISTINCT FROM false THEN RAISE EXCEPTION 'rollback guard: DOE-SP must be paused'; END IF;
  SELECT count(*) INTO v_n FROM collection_runs cr WHERE cr.source_id = (SELECT id FROM rb_src) AND cr.status IN ('PENDING', 'RUNNING');
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % active DOE-SP runs', v_n; END IF;
  SELECT count(*) INTO v_n FROM doe_sp_rollback.publications;
  IF v_n = 0 THEN RAISE EXCEPTION 'rollback guard: empty staging (run rollback-stage.sh)'; END IF;
  SELECT count(*) INTO v_n FROM rb_staged_pub s WHERE NOT EXISTS (SELECT 1 FROM publications p WHERE p.id = s.id);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % backup publications no longer exist', v_n; END IF;
  SELECT count(*) INTO v_n FROM publication_origins po JOIN rb_touched t ON t.id = po.publication_id WHERE po.source_id <> (SELECT id FROM rb_src);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % other-source origins on DOE-SP publications', v_n; END IF;
  SELECT count(*) INTO v_n FROM company_publications cp JOIN rb_touched t ON t.id = cp.publication_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % company_publications on DOE-SP publications', v_n; END IF;
  SELECT count(*) INTO v_n FROM collection_items ci JOIN rb_touched t ON t.id = ci.publication_id
    JOIN collection_runs cr ON cr.id = ci.collection_run_id WHERE cr.source_id <> (SELECT id FROM rb_src);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % other-source items reference DOE-SP publications', v_n; END IF;
  SELECT count(*) INTO v_n FROM collection_run_publications crp JOIN rb_touched t ON t.id = crp.publication_id
    JOIN collection_runs cr ON cr.id = crp.collection_run_id WHERE cr.source_id <> (SELECT id FROM rb_src);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % other-source run links reference DOE-SP publications', v_n; END IF;
  SELECT count(*) INTO v_n FROM collection_items ci JOIN rb_new_pub n ON n.id = ci.publication_id
    WHERE ci.collection_run_id NOT IN (SELECT id FROM rb_post_runs);
  IF v_n <> 0 THEN RAISE EXCEPTION 'rollback guard: % backup-era items reference window publications', v_n; END IF;
END
$$;

SELECT
  (SELECT count(*) FROM rb_post_runs) AS post_runs,
  (SELECT count(*) FROM rb_new_pub) AS new_publications,
  (SELECT count(*) FROM doe_sp_rollback.publications) AS staged_publications,
  (SELECT count(*) FROM doe_sp_rollback.origins) AS staged_origins,
  (SELECT count(*) FROM doe_sp_rollback.versions) AS staged_versions,
  (SELECT count(*) FROM doe_sp_rollback.files) AS staged_files,
  (SELECT count(*) FROM doe_sp_rollback.run_links WHERE publication_version_id IS NOT NULL) AS staged_run_links,
  (SELECT count(*) FROM doe_sp_rollback.checkpoints) AS staged_checkpoints
\gset

-- 1. recapture runs (cascade: attempts, items, run links)
WITH x AS (DELETE FROM collection_runs cr USING rb_post_runs r WHERE cr.id = r.id RETURNING 1)
SELECT count(*) = :post_runs AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_post_runs;
\endif

-- 2. translations (cache created in the window for window versions) and versions
\if :has_translations
WITH x AS (
  DELETE FROM norma_clara_translations t USING publication_versions pv, rb_touched tp
  WHERE pv.id = t.publication_version_id AND pv.publication_id = tp.id RETURNING 1)
SELECT count(*) AS window_translations_deleted FROM x \gset
\else
\set window_translations_deleted 0
\endif
UPDATE collection_run_publications crp SET publication_version_id = NULL
FROM rb_touched tp WHERE crp.publication_id = tp.id AND crp.publication_version_id IS NOT NULL;
DELETE FROM publication_versions pv USING rb_touched tp WHERE pv.publication_id = tp.id;

-- 3. origins and checkpoints
DELETE FROM publication_origins po USING rb_src s WHERE po.source_id = s.id;
DELETE FROM collection_checkpoints cc USING rb_src s WHERE cc.source_id = s.id AND cc.connector_key = 'doe-sp';

-- 4. publications created in the window
WITH x AS (DELETE FROM publications p USING rb_new_pub n WHERE p.id = n.id RETURNING 1)
SELECT count(*) = :new_publications AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_new_publications;
\endif

-- 5. canonical publication rows
WITH x AS (
  UPDATE publications p SET
    identity_hash = s.identity_hash, identity_version = s.identity_version,
    identity_strength = s.identity_strength, identity_basis = s.identity_basis,
    jurisdiction_level = s.jurisdiction_level, uf = s.uf, agency = s.agency,
    act_type = s.act_type, act_number = s.act_number, title = s.title,
    published_on = s.published_on, effective_on = s.effective_on,
    primary_official_url = s.primary_official_url, first_collected_at = s.first_collected_at,
    last_seen_at = s.last_seen_at, created_at = s.created_at, updated_at = s.updated_at
  FROM doe_sp_rollback.publications s WHERE p.id = s.id RETURNING 1)
SELECT count(*) = :staged_publications AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_publications;
\endif

-- 6. scope rows back, same ids
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
    AND s.publication_version_id IS NOT NULL
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

\if :has_staged_translations
SELECT count(*) AS staged_translations FROM doe_sp_rollback.translations \gset
WITH x AS (INSERT INTO norma_clara_translations SELECT * FROM doe_sp_rollback.translations RETURNING 1)
SELECT count(*) = :staged_translations AS ok_step FROM x \gset
\if :ok_step
\else
SELECT 1/0 AS abort_translations;
\endif
\else
\set staged_translations 0
\endif

-- post-conditions: other sources unchanged, no window leftovers
SELECT (
  (SELECT count(*) FROM publication_origins po WHERE po.source_id <> (SELECT id FROM rb_src)) = b.origins
  AND (SELECT count(*) FROM collection_runs cr WHERE cr.source_id <> (SELECT id FROM rb_src)) = b.runs
  AND (SELECT count(*) FROM collection_items ci JOIN collection_runs cr ON cr.id = ci.collection_run_id WHERE cr.source_id <> (SELECT id FROM rb_src)) = b.items
  AND (SELECT count(*) FROM publication_versions pv WHERE pv.publication_id NOT IN (SELECT id FROM rb_touched)) = b.versions
  AND (SELECT count(*) FROM publications p WHERE p.id NOT IN (SELECT id FROM rb_touched)) = b.publications
  AND (SELECT count(*) FROM company_publications) = b.company_publications
  AND (SELECT count(*) FROM publication_matches) = b.matches
  AND (SELECT count(*) FROM publications p JOIN rb_new_pub n ON n.id = p.id) = 0
  AND (SELECT count(*) FROM collection_runs cr JOIN rb_post_runs r ON r.id = cr.id) = 0
  AND (SELECT count(*) FROM publication_origins po WHERE po.source_id = (SELECT id FROM rb_src)) = :staged_origins
) AS ok_post
FROM rb_other_before b \gset
\if :ok_post
\else
\echo 'ABORT: rollback post-conditions failed'
SELECT 1/0 AS abort_post_conditions;
\endif

DROP SCHEMA doe_sp_rollback CASCADE;
SELECT 'DOE_SP_ROLLBACK_RESULT=' || jsonb_build_object(
  'recaptureRunsRemoved', :post_runs, 'windowPublicationsRemoved', :new_publications,
  'windowTranslationsRemoved', :window_translations_deleted,
  'publicationsRestored', :staged_publications, 'origins', :staged_origins,
  'versions', :staged_versions, 'files', :staged_files, 'runLinks', :staged_run_links,
  'checkpoints', :staged_checkpoints, 'translations', :staged_translations,
  'postConditions', 'PASS')::text;
COMMIT;
\echo 'DOE_SP_ROLLBACK_COMMITTED (source stays paused; resume with 50 only after review)'
