BEGIN READ ONLY;
SET LOCAL ROLE radar_app;
SELECT jsonb_build_object(
  'publications',(SELECT count(*)::text FROM public.publications WHERE id=:'publication_id'::uuid),
  'versions',(SELECT count(*)::text FROM public.publication_versions WHERE id=ANY(:'version_ids'::uuid[])),
  'origins',(SELECT count(*)::text FROM public.publication_origins WHERE publication_id=:'publication_id'::uuid),
  -- Direct foreign keys saved BEFORE suppression, not a join through hidden versions.
  'files',(SELECT count(*)::text FROM public.publication_files WHERE publication_version_id=ANY(:'version_ids'::uuid[])),
  'history_sha256',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'' ORDER BY x.collection_run_id),''),'UTF8')),'hex')
    FROM (SELECT collection_run_id,count(*) FILTER (WHERE disposition IN ('NEW_PUBLICATION','NEW_VERSION'))::text AS imported
      FROM public.collection_run_publications WHERE collection_run_id=ANY(:'run_ids'::uuid[]) GROUP BY collection_run_id) x));
ROLLBACK;
