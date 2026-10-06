-- MODE=preflight only, after NO_ELIGIBLE: aggregate counts of the global
-- quiescence gates in candidate.sql. Counts only; no identifiers. READ ONLY.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'open_collection_runs',(SELECT count(*) FROM public.collection_runs WHERE status IN ('PENDING','RUNNING')),
  'open_taxonomy_runs',(SELECT count(*) FROM public.publication_taxonomy_runs WHERE status IN ('PENDING','RUNNING')),
  'out_of_scope_total',(SELECT count(*) FROM public.publication_scope_state WHERE scope='OUT_OF_SCOPE'));
ROLLBACK;
