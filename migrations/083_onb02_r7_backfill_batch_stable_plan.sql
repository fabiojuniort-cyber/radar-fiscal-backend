-- ONB-02 R7 (tribusca-control#124; diagnosis of the PG18 timeout on radar-fiscal-backend#317):
-- audit_backfill_batch selected the batch in a MATERIALIZED CTE and joined it to audit_log in the UPDATE.
-- With stale audit_log statistics (reltuples=1 over thousands of pages, e.g. an autovacuum that ran while the
-- table was almost empty, right before a bulk legacy load) the planner estimated 1 picked row and chose a
-- nested loop with a join FILTER over the whole primary-key index: ~150k x 5,000 comparisons, > 45 s.
-- This replaces only the UPDATE target selection by primary-key lookups on an explicit id array (index
-- condition id = ANY(...)), whose cost does not depend on the row estimate. Same rows, same order, same locks
-- (FOR UPDATE on the picked rows), same projections, checkpoint, unknown-event preflight and return contract.
-- 074 stays byte-identical. CREATE OR REPLACE keeps the owner, SECURITY DEFINER and the existing ACL.
CREATE OR REPLACE FUNCTION public.audit_backfill_batch(p_limit INTEGER DEFAULT 5000)
RETURNS TABLE(processed INTEGER,remaining BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $batch$
DECLARE v_count INTEGER; v_ids UUID[]; v_remaining BIGINT; v_unknown JSONB;
BEGIN
 IF p_limit<1 OR p_limit>10000 THEN RAISE EXCEPTION 'invalid_batch_limit'; END IF;
 -- R7.1: no unknown type may be projected to empty JSON. Check every stored
 -- action/type before any UPDATE or checkpoint write. The ordinary write lock
 -- prevents trigger-disabling DDL during this check/write. Concurrent normal
 -- INSERTs remain possible, but the guard rejects every unregistered type.
 LOCK TABLE public.audit_log IN ROW EXCLUSIVE MODE;
 WITH event_types AS MATERIALIZED (
   SELECT action,entity_type,count(*) AS count FROM public.audit_log
   GROUP BY action,entity_type
 )
 SELECT jsonb_agg(jsonb_build_object('action',action,'entityType',entity_type,
   'count',count,'ruleExists',false) ORDER BY action,entity_type)
 INTO v_unknown FROM event_types
 WHERE public.audit_event_policy(action,entity_type) IS NULL;
 IF v_unknown IS NOT NULL THEN
   RAISE EXCEPTION 'audit_backfill_unknown_events'
     USING ERRCODE='55000',DETAIL=v_unknown::text;
 END IF;
 INSERT INTO public.audit_backfill_checkpoint(job_key) VALUES('onb02-r7-v1') ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.audit_backfill_checkpoint WHERE job_key='onb02-r7-v1' FOR UPDATE;
 SELECT pg_catalog.array_agg(p.id ORDER BY p.id) INTO v_ids FROM (
   SELECT id FROM public.audit_log WHERE public.audit_backfill_pending(audit_policy_version,actor_id) ORDER BY id
   LIMIT p_limit FOR UPDATE
 ) p;
 -- Primary-key lookups on an explicit id array: no join, so a stale row estimate
 -- cannot turn this into a nested loop over the whole table.
 UPDATE public.audit_log a SET
   actor_id=public.audit_historical_actor_reference(a.actor_id),
   entity_id=public.audit_entity_reference(a.entity_id),
   request_id=public.audit_entity_reference(a.request_id),
   before_data=public.audit_project(a.action,a.entity_type,a.before_data),
   after_data=public.audit_backfill_after(a.action,a.entity_type,a.after_data,a.actor_id),
   audit_policy_version=1
 WHERE a.id=ANY(coalesce(v_ids,'{}'::uuid[]));
 GET DIAGNOSTICS v_count=ROW_COUNT;
 SELECT count(*) INTO v_remaining FROM public.audit_log WHERE public.audit_backfill_pending(audit_policy_version,actor_id);
 UPDATE public.audit_backfill_checkpoint SET processed=audit_backfill_checkpoint.processed+v_count,
   last_batch_at=clock_timestamp(),
   completed_at=CASE WHEN v_remaining=0 THEN clock_timestamp() ELSE NULL END
 WHERE job_key='onb02-r7-v1';
 RETURN QUERY SELECT v_count,v_remaining;
END;
$batch$;
REVOKE ALL ON FUNCTION public.audit_backfill_batch(INTEGER) FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator;
