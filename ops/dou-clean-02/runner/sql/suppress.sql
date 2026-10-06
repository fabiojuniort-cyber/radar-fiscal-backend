BEGIN;
-- Serializes with scope/material/enrichment commit guards. Never a global freeze.
SELECT 1 FROM public.publications WHERE id=:'publication_id'::uuid FOR UPDATE;
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM public.publications p WHERE p.id=:'publication_id'::uuid AND NOT p.is_hidden
    AND public.publication_scope_is_in_scope(p.id)
    AND (SELECT count(*) FROM public.publication_versions v WHERE v.publication_id=p.id AND v.is_current)=1
    AND EXISTS (SELECT 1 FROM public.publication_origins o WHERE o.publication_id=p.id)
    AND EXISTS (SELECT 1 FROM public.publication_source_feed f WHERE f.publication_id=p.id AND NOT f.is_hidden)
    AND NOT EXISTS (SELECT 1 FROM public.company_publications c WHERE c.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_matches m JOIN public.company_publications c ON c.id=m.company_publication_id WHERE c.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_scope_events e WHERE e.publication_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.publication_scope_state s WHERE s.publication_id=p.id))
  AND NOT EXISTS (SELECT 1 FROM public.collection_runs WHERE status IN ('PENDING','RUNNING'))
  AND NOT EXISTS (SELECT 1 FROM public.publication_taxonomy_runs WHERE status IN ('PENDING','RUNNING'))
  AND NOT EXISTS (SELECT 1 FROM public.publication_scope_state WHERE scope='OUT_OF_SCOPE')
  AND public.publication_scope_epoch()::text=:'baseline_epoch'
  THEN 1 ELSE 0 END;
SELECT row_to_json(t) FROM public.apply_publication_scope_transition(
  :'publication_id'::uuid,'SUPPRESS',:'suppress_operation_id'::uuid,NULL,
  'DOU_CLEAN_02_PROD_SMOKE','CONTROLLED_SMOKE_SUPPRESS','scope-v1',
  :'evidence_sha256',:'manifest_sha256',:'actor_ref') t;
COMMIT;
