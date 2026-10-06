\set ON_ERROR_STOP on
-- Deliberately minimal contract fixture, NOT a copy of production migrations.
-- This database must exist only inside the harness's networkless container.
SELECT 1 / CASE WHEN current_database() = 'fixture_template'
  AND current_setting('server_version_num')::int / 10000 = 18
  AND current_setting('listen_addresses') = '' THEN 1 ELSE 0 END;
CREATE TABLE public.fixture_identity(identity text PRIMARY KEY);
INSERT INTO public.fixture_identity VALUES ('DOU_CLEAN_02_PG18_NETWORK_NONE_FIXTURE_V1');

CREATE ROLE fixture_scope_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE fixture_material_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE fixture_escape_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_taxonomy_curator NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_worker_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE radar_taxonomy_curator_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
CREATE ROLE fixture_runtime_noinherit NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
GRANT radar_app TO radar_app_runtime;
GRANT radar_worker TO radar_worker_runtime;
GRANT radar_taxonomy_curator TO radar_taxonomy_curator_runtime;
GRANT radar_worker TO fixture_runtime_noinherit WITH INHERIT FALSE, SET TRUE;

CREATE TABLE public.publications(id uuid PRIMARY KEY, is_hidden boolean NOT NULL DEFAULT false);
CREATE TABLE public.publication_versions(publication_id uuid, is_current boolean);
CREATE TABLE public.publication_origins(publication_id uuid);
CREATE TABLE public.publication_source_feed(publication_id uuid, is_hidden boolean);
CREATE TABLE public.company_publications(id uuid, publication_id uuid);
CREATE TABLE public.publication_matches(company_publication_id uuid);
CREATE TABLE public.collection_runs(status text);
CREATE TABLE public.collection_run_publications(
  collection_run_id uuid, disposition text, publication_id uuid,
  publication_version_id uuid, detected_at timestamptz
);
GRANT SELECT(collection_run_id,disposition) ON public.collection_run_publications TO radar_app;
CREATE TABLE public.publication_taxonomy_runs(status text);
CREATE TABLE public.publication_scope_events(
  id uuid PRIMARY KEY, publication_id uuid NOT NULL, operation_id uuid UNIQUE NOT NULL,
  action text NOT NULL, policy_key text, reason_code text, rule_version text,
  evidence_sha256 text, manifest_sha256 text, actor_ref text
);
CREATE TABLE public.publication_scope_state(
  publication_id uuid PRIMARY KEY, current_event_id uuid NOT NULL, scope text NOT NULL
);
CREATE TABLE public.publication_scope_epoch_state(
  singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL
);
INSERT INTO public.publication_scope_epoch_state VALUES (true, 0);
INSERT INTO public.publications VALUES ('11111111-1111-4111-8111-111111111111', false);
INSERT INTO public.publication_versions VALUES ('11111111-1111-4111-8111-111111111111', true);
INSERT INTO public.publication_origins VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.publication_source_feed VALUES ('11111111-1111-4111-8111-111111111111', false);

ALTER TABLE public.publications OWNER TO fixture_scope_owner;
ALTER TABLE public.publication_scope_events OWNER TO fixture_scope_owner;
ALTER TABLE public.publication_scope_state OWNER TO fixture_scope_owner;
ALTER TABLE public.publication_scope_epoch_state OWNER TO fixture_scope_owner;

CREATE FUNCTION public.publication_scope_epoch() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT epoch FROM public.publication_scope_epoch_state WHERE singleton $$;
CREATE FUNCTION public.publication_scope_is_in_scope(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM public.publication_scope_state
    WHERE publication_id=candidate AND scope='OUT_OF_SCOPE')
$$;

CREATE FUNCTION public.apply_publication_scope_transition(
  candidate uuid, requested_action text, operation uuid, expected_event uuid,
  policy text, reason text, rule text, evidence text, manifest text, actor text
) RETURNS TABLE(event_id uuid, resulting_scope text, epoch bigint, replay boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE event_record public.publication_scope_events%ROWTYPE;
DECLARE current_record public.publication_scope_state%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.publications WHERE id=candidate FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fixture canonical publication missing'; END IF;
  SELECT * INTO event_record FROM public.publication_scope_events WHERE operation_id=operation;
  IF FOUND THEN
    RETURN QUERY SELECT event_record.id,
      CASE WHEN event_record.action='SUPPRESS' THEN 'OUT_OF_SCOPE' ELSE 'IN_SCOPE' END,
      public.publication_scope_epoch(), true;
    RETURN;
  END IF;
  SELECT * INTO current_record FROM public.publication_scope_state WHERE publication_id=candidate;
  IF requested_action='SUPPRESS' THEN
    IF current_record.scope='OUT_OF_SCOPE' THEN RAISE EXCEPTION 'fixture already suppressed'; END IF;
  ELSIF requested_action='RESTORE' THEN
    IF current_record.scope IS DISTINCT FROM 'OUT_OF_SCOPE'
      OR current_record.current_event_id IS DISTINCT FROM expected_event
      THEN RAISE EXCEPTION 'fixture optimistic lock mismatch'; END IF;
  ELSE
    RAISE EXCEPTION 'fixture invalid action';
  END IF;
  event_id := gen_random_uuid();
  resulting_scope := CASE WHEN requested_action='SUPPRESS' THEN 'OUT_OF_SCOPE' ELSE 'IN_SCOPE' END;
  INSERT INTO public.publication_scope_events VALUES
    (event_id,candidate,operation,requested_action,policy,reason,rule,evidence,manifest,actor);
  INSERT INTO public.publication_scope_state VALUES(candidate,event_id,resulting_scope)
    ON CONFLICT(publication_id) DO UPDATE SET
      current_event_id=EXCLUDED.current_event_id,scope=EXCLUDED.scope;
  UPDATE public.publication_scope_epoch_state AS s SET epoch=s.epoch+1 WHERE singleton;
  epoch := public.publication_scope_epoch();
  replay := false;
  RETURN NEXT;
END $$;
ALTER FUNCTION public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)
  OWNER TO fixture_scope_owner;
REVOKE ALL ON FUNCTION public.apply_publication_scope_transition(uuid,text,uuid,uuid,text,text,text,text,text,text)
  FROM PUBLIC;

CREATE FUNCTION public.restore_publication_scope_on_material_change(uuid,text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Only the ACL/ownership contract is exercised for this function.
  RETURN;
END $$;
ALTER FUNCTION public.restore_publication_scope_on_material_change(uuid,text) OWNER TO fixture_material_owner;
REVOKE ALL ON FUNCTION public.restore_publication_scope_on_material_change(uuid,text) FROM PUBLIC;
-- Inert helper bodies model only the migration ACL contract for this fixture.
CREATE FUNCTION public.publication_scope_company_publication_is_in_scope(uuid)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.publication_scope_imported_today(uuid)
RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION public.publication_scope_lock_curator_version(uuid)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
REVOKE ALL ON FUNCTION public.publication_scope_is_in_scope(uuid),
  public.publication_scope_company_publication_is_in_scope(uuid),
  public.publication_scope_epoch(), public.publication_scope_imported_today(uuid),
  public.publication_scope_lock_curator_version(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publication_scope_is_in_scope(uuid),
  public.publication_scope_company_publication_is_in_scope(uuid),
  public.publication_scope_epoch() TO radar_app,radar_worker;
GRANT EXECUTE ON FUNCTION public.publication_scope_imported_today(uuid) TO radar_app;
GRANT EXECUTE ON FUNCTION public.publication_scope_lock_curator_version(uuid) TO radar_taxonomy_curator;
-- The synthetic transition owner calls epoch(); production owner is postgres.
GRANT EXECUTE ON FUNCTION public.publication_scope_epoch() TO fixture_scope_owner;
