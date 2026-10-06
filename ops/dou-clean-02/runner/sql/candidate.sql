-- Rank the ACTUAL v1 population, before applying stricter smoke eligibility.
-- Entire tie groups must fit in the public endpoint's maximum 20-row window.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH ranked AS (
  SELECT s.code,p.id,
    rank() OVER (PARTITION BY s.id ORDER BY p.published_on DESC NULLS LAST,p.first_collected_at DESC) AS start_rank,
    count(*) OVER (PARTITION BY s.id,p.published_on,p.first_collected_at) AS tie_size
  FROM public.sources s JOIN public.publications p ON EXISTS (
    SELECT 1 FROM public.publication_origins o WHERE o.source_id=s.id AND o.publication_id=p.id)
  WHERE public.publication_scope_is_in_scope(p.id)
), eligible AS (
  SELECT p.id,r.code
  FROM ranked r JOIN public.publications p ON p.id=r.id
  WHERE r.start_rank+r.tie_size-1 <= 20 AND NOT p.is_hidden
    AND (:'controlled_publication_sha256'='' OR
      encode(sha256(convert_to(p.id::text,'UTF8')),'hex')=:'controlled_publication_sha256')
    AND (SELECT count(*) FROM public.publication_versions v WHERE v.publication_id=p.id AND v.is_current)=1
    AND EXISTS (SELECT 1 FROM public.publication_source_feed f WHERE f.publication_id=p.id AND NOT f.is_hidden)
    -- Require non-vacuous file-RLS and historical-import preservation proofs.
    AND EXISTS (SELECT 1 FROM public.publication_files f JOIN public.publication_versions v ON v.id=f.publication_version_id WHERE v.publication_id=p.id)
    AND EXISTS (SELECT 1 FROM public.collection_run_publications h WHERE h.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.company_publications c WHERE c.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_matches m JOIN public.company_publications c
      ON c.id=m.company_publication_id WHERE c.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_scope_events e WHERE e.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_scope_state s WHERE s.publication_id=p.id)
    -- Conservative global quiescence, not merely absence of one source's run.
    AND NOT EXISTS (SELECT 1 FROM public.collection_runs WHERE status IN ('PENDING','RUNNING'))
    AND NOT EXISTS (SELECT 1 FROM public.publication_taxonomy_runs WHERE status IN ('PENDING','RUNNING'))
    AND NOT EXISTS (SELECT 1 FROM public.publication_scope_state WHERE scope='OUT_OF_SCOPE')
  ORDER BY (lower(r.code)='dou') DESC,p.id,r.code LIMIT 1
)
SELECT jsonb_build_object('publication_id',id,'source_code',code,
  'version_ids',(SELECT array_agg(v.id ORDER BY v.id) FROM public.publication_versions v WHERE v.publication_id=e.id),
  'run_ids',coalesce((SELECT array_agg(DISTINCT h.collection_run_id ORDER BY h.collection_run_id)
    FROM public.collection_run_publications h WHERE h.publication_id=e.id),'{}'::uuid[]))
FROM eligible e;
ROLLBACK;
