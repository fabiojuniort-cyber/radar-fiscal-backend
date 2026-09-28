-- DOE-SP rebuild — 25 pause (WRITE, production only in the authorized gate).
-- Scheduler and Worker only schedule/claim runs of sources with is_active=true.
-- A run already RUNNING finishes normally; wait for 20's blocker_active_runs=0.
\set ON_ERROR_STOP 1
BEGIN;
SELECT 'DOE_SP_PAUSE_BEFORE=' || jsonb_build_object('isActive', is_active)::text
FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp' FOR UPDATE;
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
