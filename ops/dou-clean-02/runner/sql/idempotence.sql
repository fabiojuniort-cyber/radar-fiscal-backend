BEGIN;
SELECT row_to_json(t) FROM public.apply_publication_scope_transition(
  :'publication_id'::uuid,'SUPPRESS',:'suppress_operation_id'::uuid,NULL,
  'DOU_CLEAN_02_PROD_SMOKE','CONTROLLED_SMOKE_SUPPRESS','scope-v1',
  :'evidence_sha256',:'manifest_sha256',:'actor_ref') t;
COMMIT;
