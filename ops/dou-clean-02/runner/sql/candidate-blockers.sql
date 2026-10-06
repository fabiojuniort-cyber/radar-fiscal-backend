-- MODE=preflight only, after NO_ELIGIBLE: aggregate counts explaining why the
-- conservative selection in candidate.sql is empty. Same ranking window; each
-- filter counted independently. Counts only; no identifiers. READ ONLY.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH ranked AS (
  SELECT s.code,p.id,
    rank() OVER (PARTITION BY s.id ORDER BY p.published_on DESC NULLS LAST,p.first_collected_at DESC) AS start_rank,
    count(*) OVER (PARTITION BY s.id,p.published_on,p.first_collected_at) AS tie_size
  FROM public.sources s JOIN public.publications p ON EXISTS (
    SELECT 1 FROM public.publication_origins o WHERE o.source_id=s.id AND o.publication_id=p.id)
  WHERE public.publication_scope_is_in_scope(p.id)
), window_rows AS (
  SELECT r.code,p.* FROM ranked r JOIN public.publications p ON p.id=r.id
  WHERE r.start_rank+r.tie_size-1 <= 20
), checks AS (
  SELECT w.code,
    NOT w.is_hidden AS not_hidden,
    (SELECT count(*) FROM public.publication_versions v WHERE v.publication_id=w.id AND v.is_current)=1 AS one_current_version,
    EXISTS (SELECT 1 FROM public.publication_source_feed f WHERE f.publication_id=w.id AND NOT f.is_hidden) AS visible_feed,
    EXISTS (SELECT 1 FROM public.publication_files f JOIN public.publication_versions v ON v.id=f.publication_version_id WHERE v.publication_id=w.id) AS has_files,
    EXISTS (SELECT 1 FROM public.collection_run_publications h WHERE h.publication_id=w.id) AS has_history,
    NOT EXISTS (SELECT 1 FROM public.company_publications c WHERE c.publication_id=w.id) AS no_company_links,
    NOT EXISTS (SELECT 1 FROM public.publication_scope_events e WHERE e.publication_id=w.id)
      AND NOT EXISTS (SELECT 1 FROM public.publication_scope_state s WHERE s.publication_id=w.id) AS no_scope_ledger
  FROM window_rows w
)
SELECT jsonb_build_object(
  'open_collection_runs',(SELECT count(*) FROM public.collection_runs WHERE status IN ('PENDING','RUNNING')),
  'open_taxonomy_runs',(SELECT count(*) FROM public.publication_taxonomy_runs WHERE status IN ('PENDING','RUNNING')),
  'out_of_scope_total',(SELECT count(*) FROM public.publication_scope_state WHERE scope='OUT_OF_SCOPE'),
  'window_rows',(SELECT count(*) FROM checks),
  'window_sources',(SELECT count(DISTINCT code) FROM checks),
  'not_hidden',(SELECT count(*) FILTER (WHERE not_hidden) FROM checks),
  'one_current_version',(SELECT count(*) FILTER (WHERE one_current_version) FROM checks),
  'visible_feed',(SELECT count(*) FILTER (WHERE visible_feed) FROM checks),
  'has_files',(SELECT count(*) FILTER (WHERE has_files) FROM checks),
  'has_history',(SELECT count(*) FILTER (WHERE has_history) FROM checks),
  'no_company_links',(SELECT count(*) FILTER (WHERE no_company_links) FROM checks),
  'no_scope_ledger',(SELECT count(*) FILTER (WHERE no_scope_ledger) FROM checks),
  'all_filters',(SELECT count(*) FILTER (WHERE not_hidden AND one_current_version AND visible_feed AND has_files
    AND has_history AND no_company_links AND no_scope_ledger) FROM checks),
  'all_but_files',(SELECT count(*) FILTER (WHERE not_hidden AND one_current_version AND visible_feed
    AND has_history AND no_company_links AND no_scope_ledger) FROM checks),
  'all_but_company_links',(SELECT count(*) FILTER (WHERE not_hidden AND one_current_version AND visible_feed AND has_files
    AND has_history AND no_scope_ledger) FROM checks));
ROLLBACK;
