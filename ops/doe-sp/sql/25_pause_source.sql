-- DOE-SP rebuild — 25 pause (WRITE, production only in the authorized gate).
-- Scheduler and Worker only schedule/claim runs of sources with is_active=true.
-- A run already RUNNING finishes normally; wait for 20's blocker_active_runs=0.
--
-- Pause × Scheduler race: the Scheduler (radar_worker_runtime, SELECT-only on
-- sources) inserts a run with `INSERT … SELECT … WHERE is_active` and takes no
-- row lock. The race is closed here, in one transaction:
--   * FOR NO KEY UPDATE on the source row serializes with other pause/resume
--     and with the manual trigger's FOR UPDATE, but not with the FOR KEY SHARE
--     of the collection_runs FK check (no deadlock with an in-flight insert);
--   * LOCK collection_runs IN SHARE MODE waits for every insert already in
--     flight (it commits first and is counted below) and blocks new ones until
--     COMMIT; they then run with a fresh snapshot that reads is_active=false.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT 'DOE_SP_PAUSE_BEFORE=' || jsonb_build_object('isActive', is_active)::text
FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp' FOR NO KEY UPDATE;
LOCK TABLE collection_runs IN SHARE MODE;
WITH x AS (
  UPDATE sources SET is_active = false, updated_at = now()
  WHERE code = 'doe-sp' AND connector_key = 'doe-sp'
  RETURNING 1)
SELECT count(*) = 1 AS ok_pause FROM x \gset
\if :ok_pause
COMMIT;
\echo 'DOE_SP_PAUSED'
\else
SELECT 1/0 AS abort_pause;
\endif
SELECT 'DOE_SP_ACTIVE_RUNS=' || count(*) FROM collection_runs cr JOIN sources s ON s.id = cr.source_id
WHERE s.code = 'doe-sp' AND cr.status IN ('PENDING', 'RUNNING');
