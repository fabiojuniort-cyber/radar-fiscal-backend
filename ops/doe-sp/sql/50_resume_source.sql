-- DOE-SP rebuild — 50 resume (WRITE). Only after 40 PASS and after the Worker
-- env is verified: DOE_SP_BOOTSTRAP_START_DATE=2025-01-01 and
-- DOE_SP_FORCE_REPROCESS_UNTIL unset or in the past (see RUNBOOK §6).
\set ON_ERROR_STOP 1
BEGIN;
WITH x AS (
  UPDATE sources SET is_active = true, updated_at = now()
  WHERE code = 'doe-sp' AND connector_key = 'doe-sp' AND is_active = false
  RETURNING 1)
SELECT count(*) = 1 AS ok_resume FROM x \gset
\if :ok_resume
COMMIT;
\echo 'DOE_SP_RESUMED'
\else
SELECT 1/0 AS abort_resume;
\endif
