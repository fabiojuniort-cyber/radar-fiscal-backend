BEGIN;
SELECT 1 FROM public.publications WHERE id=:'publication_id'::uuid FOR UPDATE;
-- Resolve committed SUPPRESS by journal operation ID: survives commit/ack loss.
-- Never restore somebody else's current event or replace an optimistic lock.
SELECT row_to_json(t)
FROM public.publication_scope_events e
JOIN public.publication_scope_state s ON s.publication_id=e.publication_id AND s.current_event_id=e.id
CROSS JOIN LATERAL public.apply_publication_scope_transition(
  e.publication_id,'RESTORE',:'restore_operation_id'::uuid,e.id,
  'DOU_CLEAN_02_PROD_SMOKE','CONTROLLED_SMOKE_RESTORE','scope-v1',
  :'evidence_sha256',:'manifest_sha256',:'actor_ref') t
WHERE e.publication_id=:'publication_id'::uuid AND e.operation_id=:'suppress_operation_id'::uuid
  AND e.action='SUPPRESS' AND e.evidence_sha256::text=:'evidence_sha256'
  AND e.manifest_sha256::text=:'manifest_sha256' AND e.actor_ref=:'actor_ref'
  AND e.policy_key='DOU_CLEAN_02_PROD_SMOKE' AND e.reason_code='CONTROLLED_SMOKE_SUPPRESS'
  AND e.rule_version='scope-v1' AND s.scope='OUT_OF_SCOPE';
COMMIT;
