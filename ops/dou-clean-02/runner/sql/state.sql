BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'database_fingerprint',encode(sha256(convert_to(
    (SELECT system_identifier::text FROM pg_control_system())||':'||current_database(),'UTF8')),'hex'),
  'epoch',public.publication_scope_epoch()::text,
  'in_scope',public.publication_scope_is_in_scope(:'publication_id'::uuid),
  'canonical_exists',EXISTS(SELECT 1 FROM public.publications WHERE id=:'publication_id'::uuid),
  'current_event',(SELECT current_event_id FROM public.publication_scope_state WHERE publication_id=:'publication_id'::uuid),
  'out_of_scope_total',(SELECT count(*)::text FROM public.publication_scope_state WHERE scope='OUT_OF_SCOPE'),
  'candidate_events',(SELECT count(*)::text FROM public.publication_scope_events WHERE publication_id=:'publication_id'::uuid),
  'feed_count',(SELECT count(*)::text FROM public.publication_source_feed WHERE publication_id=:'publication_id'::uuid),
  'feed_matches_expected',NOT EXISTS (
    (SELECT source_code,publication_id,published_on,first_collected_at,is_hidden FROM public.publication_source_feed WHERE publication_id=:'publication_id'::uuid
      EXCEPT SELECT * FROM public.publication_source_feed_expected(ARRAY[:'publication_id'::uuid]))
    UNION ALL
    (SELECT * FROM public.publication_source_feed_expected(ARRAY[:'publication_id'::uuid])
      EXCEPT SELECT source_code,publication_id,published_on,first_collected_at,is_hidden FROM public.publication_source_feed WHERE publication_id=:'publication_id'::uuid)),
  'feed_sha256',(SELECT encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'' ORDER BY x.source_code),''),'UTF8')),'hex')
    FROM (SELECT source_code,publication_id,published_on,first_collected_at,is_hidden FROM public.publication_source_feed
      WHERE publication_id=:'publication_id'::uuid) x),
  'suppress_event',(SELECT jsonb_build_object('id',e.id,'sha256',encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex'))
    FROM public.publication_scope_events e WHERE publication_id=:'publication_id'::uuid AND operation_id=:'suppress_operation_id'::uuid),
  'restore_event',(SELECT jsonb_build_object('id',e.id,'sha256',encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex'))
    FROM public.publication_scope_events e WHERE publication_id=:'publication_id'::uuid AND operation_id=:'restore_operation_id'::uuid),
  'v1',jsonb_build_object(
    'totalPublications',(SELECT count(*) FROM public.publications p WHERE public.publication_scope_is_in_scope(p.id)),
    'totalSources',(SELECT count(*) FROM public.sources),'activeSources',(SELECT count(*) FROM public.sources WHERE is_active),
    'importedToday',(SELECT coalesce(sum(public.publication_scope_imported_today(id)),0) FROM public.sources)),
  'v2',jsonb_build_object(
    'totalPublications',(SELECT count(*) FROM public.publications p WHERE NOT p.is_hidden AND public.publication_scope_is_in_scope(p.id)),
    'totalSources',(SELECT count(*) FROM public.sources),'activeSources',(SELECT count(*) FROM public.sources WHERE is_active),
    'importedToday',(SELECT count(*) FROM public.publications p WHERE NOT p.is_hidden AND public.publication_scope_is_in_scope(p.id)
      AND p.first_collected_at >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND p.first_collected_at < (((now() AT TIME ZONE 'America/Sao_Paulo')::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))));
ROLLBACK;
