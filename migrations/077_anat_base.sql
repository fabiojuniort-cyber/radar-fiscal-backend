-- ANAT-ADMIN-01 integration package 1: M_ANAT_BASE (issue tribusca-control#116).
-- Persistent home of the anatomy engine's results (contract v1). Same tables and constraints as the disposable CI schema
-- (test/support/anatomy-ci-schema.sql), with the reviewed changes of docs/anatomy/ADMIN-01-M_ANAT_BASE-DESIGN.md:
-- * publication_version_id is a uuid with a FK to publication_versions(id) ON DELETE RESTRICT (COORD R3 decision: a
--   version with analyses cannot be deleted silently; a future purge must handle these rows explicitly);
-- * publication_anatomies gains effective_profile_hash and family, written by the engine with the analysis. NULL means
--   "not recorded"; nothing is backfilled or derived for existing rows (there are none: the tables are new);
-- * source and family follow the ANAT-PROFILE/1 contract (src/modules/anatomy/profile.ts): source is one of
--   PROFILE_SOURCES, family is a profile literal (1-64 UTF-16 units, NFC, no control characters, no leading/trailing or
--   repeated spaces, no whitespace other than U+0020).
-- No existing table, policy, grant or function is changed. No privileged counting function (that belongs to the
-- administrative package).

CREATE TABLE anatomy_rule_sets (
 id text PRIMARY KEY, version text NOT NULL, status text NOT NULL CHECK(status IN ('draft','reviewed','retired')),
 rule_hash text NOT NULL CHECK(rule_hash ~ '^[a-f0-9]{64}$'), contract_version text NOT NULL,
 profiles jsonb NOT NULL, author text NOT NULL, reviewer text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,rule_hash)
);

CREATE FUNCTION anatomy_profile_literal_ok(p text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT char_length(p) + char_length(regexp_replace(p, '[^\U00010000-\U0010FFFF]', '', 'g')) BETWEEN 1 AND 64
  AND p !~ '[\x01-\x1f\x7f]'
  AND p = btrim(p, ' ')
  AND p !~ '[\t\n\v\f\r   -     　﻿]'
  AND p !~ '  '
  AND p IS NFC NORMALIZED
$$;
REVOKE ALL ON FUNCTION anatomy_profile_literal_ok(text) FROM PUBLIC;
-- CHECK constraints run as the inserting role: the writer (and only the writer) needs EXECUTE on this pure function.
GRANT EXECUTE ON FUNCTION anatomy_profile_literal_ok(text) TO radar_worker;

CREATE TABLE publication_anatomies (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 publication_version_id uuid NOT NULL REFERENCES publication_versions(id) ON DELETE RESTRICT,
 representation_id text NOT NULL,
 source text NOT NULL CHECK(source IN ('CONFAZ','DOU','DOE-SP','RFB')),
 input_text_hash text NOT NULL CHECK(input_text_hash ~ '^[a-f0-9]{64}$'),
 input_presentation_hash text CHECK(input_presentation_hash ~ '^[a-f0-9]{64}$'),
 attachment_manifest_hash text NOT NULL CHECK(attachment_manifest_hash ~ '^[a-f0-9]{64}$'),
 engine_version text NOT NULL, engine_hash text NOT NULL CHECK(engine_hash ~ '^[a-f0-9]{64}$'),
 rule_set_id text NOT NULL, rule_set_hash text NOT NULL, contract_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('complete','partial','failed')), text_length integer NOT NULL CHECK(text_length>=0),
 coverage jsonb NOT NULL, output_hash text NOT NULL CHECK(output_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 effective_profile_hash text CHECK(effective_profile_hash ~ '^[a-f0-9]{64}$'),
 family text CHECK(anatomy_profile_literal_ok(family)),
 CHECK(family IS NULL OR effective_profile_hash IS NOT NULL),
 FOREIGN KEY(rule_set_id,rule_set_hash) REFERENCES anatomy_rule_sets(id,rule_hash),
 UNIQUE(id,publication_version_id,input_text_hash,engine_version,rule_set_id,rule_set_hash), UNIQUE(id,status)
);
CREATE INDEX publication_anatomies_version ON publication_anatomies(publication_version_id);
CREATE INDEX publication_anatomies_profile_scope ON publication_anatomies(source, family, effective_profile_hash);

CREATE TABLE anatomy_parts (
 anatomy_id text NOT NULL REFERENCES publication_anatomies(id), id text NOT NULL, parent_id text,
 sibling_order integer NOT NULL CHECK(sibling_order>=0), type text NOT NULL, label text NOT NULL,
 start_utf16 integer NOT NULL CHECK(start_utf16>=0), end_utf16 integer NOT NULL CHECK(end_utf16>=start_utf16),
 source_pointers jsonb NOT NULL, confidence numeric NOT NULL CHECK(confidence BETWEEN 0 AND 1), coverage text NOT NULL,
 context text NOT NULL, legal_status text NOT NULL DEFAULT 'unknown', table_geometry jsonb,
 PRIMARY KEY(anatomy_id,id), FOREIGN KEY(anatomy_id,parent_id) REFERENCES anatomy_parts(anatomy_id,id),
 CHECK(parent_id IS DISTINCT FROM id), CHECK((parent_id IS NULL)=(type='document')),
 UNIQUE NULLS NOT DISTINCT(anatomy_id,parent_id,sibling_order)
);
CREATE UNIQUE INDEX anatomy_one_root ON anatomy_parts(anatomy_id) WHERE parent_id IS NULL;
CREATE TABLE anatomy_entities (
 anatomy_id text NOT NULL, id text NOT NULL, part_id text NOT NULL, domain text NOT NULL, literal text NOT NULL,
 normalized text NOT NULL, start_utf16 integer NOT NULL CHECK(start_utf16>=0), end_utf16 integer NOT NULL CHECK(end_utf16>start_utf16),
 rule_id text NOT NULL, confidence numeric NOT NULL CHECK(confidence BETWEEN 0 AND 1), validation jsonb NOT NULL, relation jsonb,
 PRIMARY KEY(anatomy_id,id), FOREIGN KEY(anatomy_id,part_id) REFERENCES anatomy_parts(anatomy_id,id)
);
CREATE TABLE anatomy_evidence (
 anatomy_id text NOT NULL, id text NOT NULL, part_id text NOT NULL, kind text NOT NULL,
 start_utf16 integer NOT NULL CHECK(start_utf16>=0), end_utf16 integer NOT NULL CHECK(end_utf16>=start_utf16),
 basis text NOT NULL, source_snapshot jsonb NOT NULL, reference_date date NOT NULL, valid_from date NOT NULL,
 valid_through date NOT NULL CHECK(valid_through>=valid_from), conclusion text NOT NULL, reviewer text NOT NULL, reviewed_at timestamptz NOT NULL,
 PRIMARY KEY(anatomy_id,id), FOREIGN KEY(anatomy_id,part_id) REFERENCES anatomy_parts(anatomy_id,id)
);
CREATE TABLE anatomy_dependencies (
 anatomy_id text NOT NULL, id text NOT NULL, evidence_id text NOT NULL, dependent_part_id text NOT NULL,
 external_reference text NOT NULL, approved_hash text NOT NULL CHECK(approved_hash ~ '^[a-f0-9]{64}$'),
 observed_hash text NOT NULL CHECK(observed_hash ~ '^[a-f0-9]{64}$'), reported_effect text NOT NULL, review_state text NOT NULL,
 PRIMARY KEY(anatomy_id,id), FOREIGN KEY(anatomy_id,evidence_id) REFERENCES anatomy_evidence(anatomy_id,id),
 FOREIGN KEY(anatomy_id,dependent_part_id) REFERENCES anatomy_parts(anatomy_id,id)
);
CREATE TABLE anatomy_runs (
 id text PRIMARY KEY, manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'), scope jsonb NOT NULL,
 engine_version text NOT NULL, rule_set_id text NOT NULL, rule_set_hash text NOT NULL, initiator text NOT NULL,
 started_at timestamptz NOT NULL, ended_at timestamptz, cursor jsonb, counters jsonb NOT NULL, duration_ms integer CHECK(duration_ms>=0),
 FOREIGN KEY(rule_set_id,rule_set_hash) REFERENCES anatomy_rule_sets(id,rule_hash), UNIQUE(id,engine_version,rule_set_id,rule_set_hash)
);
CREATE TABLE anatomy_run_items (
 run_id text NOT NULL, id text NOT NULL,
 publication_version_id uuid NOT NULL REFERENCES publication_versions(id) ON DELETE RESTRICT,
 input_text_hash text NOT NULL,
 engine_version text NOT NULL, rule_set_id text NOT NULL, rule_set_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','complete','partial','failed')), attempt integer NOT NULL CHECK(attempt>0),
 duration_ms integer CHECK(duration_ms>=0), error jsonb, output_anatomy_id text,
 expected_analysis_id text NOT NULL CHECK(expected_analysis_id ~ '^[a-f0-9]{64}$'), PRIMARY KEY(run_id,id),
 FOREIGN KEY(run_id,engine_version,rule_set_id,rule_set_hash) REFERENCES anatomy_runs(id,engine_version,rule_set_id,rule_set_hash),
 FOREIGN KEY(output_anatomy_id,publication_version_id,input_text_hash,engine_version,rule_set_id,rule_set_hash)
 REFERENCES publication_anatomies(id,publication_version_id,input_text_hash,engine_version,rule_set_id,rule_set_hash),
 FOREIGN KEY(output_anatomy_id,status) REFERENCES publication_anatomies(id,status),
 CHECK(output_anatomy_id IS NULL OR output_anatomy_id=expected_analysis_id),
 CHECK((status IN ('complete','partial'))=(output_anatomy_id IS NOT NULL))
);
CREATE INDEX anatomy_run_items_version ON anatomy_run_items(publication_version_id);

-- Geometry and occurrence guards (as in the CI schema).
CREATE FUNCTION anatomy_guard_part() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE lim integer; parent anatomy_parts;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.anatomy_id,NEW.id,NEW.parent_id,NEW.start_utf16,NEW.end_utf16)
 IS DISTINCT FROM (OLD.anatomy_id,OLD.id,OLD.parent_id,OLD.start_utf16,OLD.end_utf16) THEN
 RAISE EXCEPTION 'Part identity and geometry are immutable'; END IF;
 SELECT text_length INTO lim FROM publication_anatomies WHERE id=NEW.anatomy_id;
 IF NEW.end_utf16>lim THEN RAISE EXCEPTION 'Part exceeds canonical text'; END IF;
 IF NEW.parent_id IS NULL THEN
 IF NEW.start_utf16<>0 OR NEW.end_utf16<>lim THEN RAISE EXCEPTION 'Root must cover canonical text'; END IF;
 ELSE
 SELECT * INTO parent FROM anatomy_parts WHERE anatomy_id=NEW.anatomy_id AND id=NEW.parent_id;
 IF NOT FOUND OR NEW.start_utf16<parent.start_utf16 OR NEW.end_utf16>parent.end_utf16 THEN
 RAISE EXCEPTION 'Parent missing, incompatible or outside span'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anatomy_part_guard BEFORE INSERT OR UPDATE ON anatomy_parts FOR EACH ROW EXECUTE FUNCTION anatomy_guard_part();
CREATE FUNCTION anatomy_guard_occurrence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parent anatomy_parts;
BEGIN
 SELECT * INTO parent FROM anatomy_parts WHERE anatomy_id=NEW.anatomy_id AND id=NEW.part_id;
 IF NOT FOUND OR NEW.start_utf16<parent.start_utf16 OR NEW.end_utf16>parent.end_utf16 THEN
 RAISE EXCEPTION 'Occurrence outside compatible part'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anatomy_entity_guard BEFORE INSERT OR UPDATE ON anatomy_entities FOR EACH ROW EXECUTE FUNCTION anatomy_guard_occurrence();
CREATE TRIGGER anatomy_evidence_guard BEFORE INSERT OR UPDATE ON anatomy_evidence FOR EACH ROW EXECUTE FUNCTION anatomy_guard_occurrence();

-- An analysis is immutable once written: its identity, hashes and attribution never change (any role, owner included).
CREATE FUNCTION anatomy_guard_analysis_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'anatomy analyses are immutable (%)', TG_TABLE_NAME; END $$;
CREATE TRIGGER anatomy_analysis_immutable BEFORE UPDATE ON publication_anatomies FOR EACH ROW EXECUTE FUNCTION anatomy_guard_analysis_immutable();
CREATE TRIGGER anatomy_analysis_immutable BEFORE UPDATE ON anatomy_entities FOR EACH ROW EXECUTE FUNCTION anatomy_guard_analysis_immutable();
CREATE TRIGGER anatomy_analysis_immutable BEFORE UPDATE ON anatomy_evidence FOR EACH ROW EXECUTE FUNCTION anatomy_guard_analysis_immutable();
CREATE TRIGGER anatomy_analysis_immutable BEFORE UPDATE ON anatomy_dependencies FOR EACH ROW EXECUTE FUNCTION anatomy_guard_analysis_immutable();
CREATE TRIGGER anatomy_analysis_immutable BEFORE UPDATE ON anatomy_parts FOR EACH ROW EXECUTE FUNCTION anatomy_guard_analysis_immutable();
REVOKE ALL ON FUNCTION anatomy_guard_part(), anatomy_guard_occurrence(), anatomy_guard_analysis_immutable() FROM PUBLIC;

-- Privileges. PUBLIC, radar_taxonomy_curator: nothing. No runtime role gets DELETE, or UPDATE on analyses.
-- radar_worker (pipeline): reads rule sets; writes analyses; writes runs and updates only their progress columns.
-- radar_app: reads analyses of in-scope publications (the publication_versions rule of 033); nothing else here.
-- anatomy_rule_sets: radar_app gets nothing here (the administrative package grants admin-only reads).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['anatomy_rule_sets','publication_anatomies','anatomy_parts','anatomy_entities','anatomy_evidence',
  'anatomy_dependencies','anatomy_runs','anatomy_run_items'] LOOP
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['publication_anatomies','anatomy_parts','anatomy_entities','anatomy_evidence','anatomy_dependencies',
  'anatomy_runs','anatomy_run_items'] LOOP
  EXECUTE format('GRANT SELECT, INSERT ON %I TO radar_worker', t);
  EXECUTE format('CREATE POLICY anatomy_worker_select ON %I FOR SELECT TO radar_worker USING (true)', t);
  EXECUTE format('CREATE POLICY anatomy_worker_insert ON %I FOR INSERT TO radar_worker WITH CHECK (true)', t);
 END LOOP;
END $$;
GRANT SELECT ON anatomy_rule_sets TO radar_worker;
CREATE POLICY anat_worker_select ON anatomy_rule_sets FOR SELECT TO radar_worker USING (true);
GRANT UPDATE (ended_at, cursor, counters, duration_ms) ON anatomy_runs TO radar_worker;
GRANT UPDATE (status, attempt, duration_ms, error, output_anatomy_id) ON anatomy_run_items TO radar_worker;
CREATE POLICY anatomy_worker_update ON anatomy_runs FOR UPDATE TO radar_worker USING (true) WITH CHECK (true);
CREATE POLICY anatomy_worker_update ON anatomy_run_items FOR UPDATE TO radar_worker USING (true) WITH CHECK (true);

GRANT SELECT ON publication_anatomies, anatomy_parts, anatomy_entities, anatomy_evidence, anatomy_dependencies TO radar_app;
CREATE POLICY anatomy_app_scope ON publication_anatomies FOR SELECT TO radar_app
 USING (EXISTS (SELECT 1 FROM publication_versions v WHERE v.id = publication_version_id AND public.publication_scope_is_in_scope(v.publication_id)));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['anatomy_parts','anatomy_entities','anatomy_evidence','anatomy_dependencies'] LOOP
  EXECUTE format('CREATE POLICY anatomy_app_scope ON %I FOR SELECT TO radar_app
   USING (EXISTS (SELECT 1 FROM publication_anatomies a WHERE a.id = anatomy_id))', t);
 END LOOP;
END $$;
