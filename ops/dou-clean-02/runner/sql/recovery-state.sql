-- Emergency recovery must not depend on aggregates, feed rebuild validation,
-- API availability, migrations/grant checks, or the fingerprint graph.
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'database_fingerprint',encode(sha256(convert_to(
    (SELECT system_identifier::text FROM pg_control_system())||':'||current_database(),'UTF8')),'hex'),
  'canonical_exists',EXISTS(SELECT 1 FROM public.publications WHERE id=:'publication_id'::uuid),
  'in_scope',public.publication_scope_is_in_scope(:'publication_id'::uuid),
  'current_event',(SELECT current_event_id FROM public.publication_scope_state WHERE publication_id=:'publication_id'::uuid),
  'suppress_event',(SELECT jsonb_build_object('id',e.id) FROM public.publication_scope_events e
    WHERE publication_id=:'publication_id'::uuid AND operation_id=:'suppress_operation_id'::uuid),
  'restore_event',(SELECT jsonb_build_object('id',e.id) FROM public.publication_scope_events e
    WHERE publication_id=:'publication_id'::uuid AND operation_id=:'restore_operation_id'::uuid));
ROLLBACK;
