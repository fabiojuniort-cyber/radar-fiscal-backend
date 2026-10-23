-- Disposable CI only (ANAT-ADMIN-01 / P3-B1): rehearsal of M_ANAT_ADMIN. NOT a migration, no number, never run by
-- src/infrastructure/database/migrate.ts. Applied by test/anatomy.admin-schema.integration.test.ts after the base
-- disposable schema (anatomy-ci-schema.sql), the vendored audit chain and anatomy-admin-audit-policy.sql.
-- Design: docs/anatomy/ADMIN-01-P3.md (R2). Errors are raised as 'anat:<CODE>' (P3 §2.4 codes where one applies).
DO $$ BEGIN
 IF current_database()<>'anat04_ci' OR current_user<>'postgres'
 OR current_setting('anatomy.ci_disposable',true) IS DISTINCT FROM 'true'
 OR inet_server_port() IS DISTINCT FROM 5432 THEN RAISE EXCEPTION 'ANAT04_DISPOSABLE_CI_ONLY'; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Canonical JSON: reproduces canonicalJson (src/modules/anatomy/contract.ts) and FAILS CLOSED where it cannot.
-- * object keys sorted by UTF-16 code units (JS sort); byte order of UTF-8 ("C") is the same for keys made of
--   code points below U+E000, so a key with a code point >= U+E000 is refused;
-- * strings via to_json(text): escapes ", \, \b \f \n \r \t and other C0 as \u00xx (lowercase), like JSON.stringify;
-- * numbers: integers with |n| <= 2^53-1; decimals only in [1e-6, 1e21) with <= 15 significant digits and no
--   trailing zero (then the decimal text IS the JS shortest form); anything else is refused.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION anat_canonical_json(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public AS $$
DECLARE t text := jsonb_typeof(p); r text; n numeric; s text;
BEGIN
 IF t = 'object' THEN
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k ~ '[\uE000-\uFFFF]|[\U00010000-\U0010FFFF]') THEN
   RAISE EXCEPTION 'anat:CANONICAL_KEY_UNSUPPORTED' USING ERRCODE = '22023';
  END IF;
  SELECT '{' || coalesce(string_agg(to_json(key)::text || ':' || anat_canonical_json(value), ',' ORDER BY key COLLATE "C"), '') || '}'
   INTO r FROM jsonb_each(p);
  RETURN r;
 ELSIF t = 'array' THEN
  SELECT '[' || coalesce(string_agg(anat_canonical_json(e), ',' ORDER BY i), '') || ']'
   INTO r FROM jsonb_array_elements(p) WITH ORDINALITY a(e, i);
  RETURN r;
 ELSIF t = 'string' THEN
  RETURN to_json(p #>> '{}')::text;
 ELSIF t = 'number' THEN
  n := (p #>> '{}')::numeric;
  IF n = trunc(n) THEN
   IF abs(n) > 9007199254740991 THEN RAISE EXCEPTION 'anat:CANONICAL_NUMBER_UNSUPPORTED' USING ERRCODE = '22023'; END IF;
   RETURN trunc(n)::text;
  END IF;
  s := n::text;
  IF abs(n) < 0.000001 OR abs(n) >= 1e21 OR s ~ '0$'
     OR length(ltrim(regexp_replace(s, '[^0-9]', '', 'g'), '0')) > 15 THEN
   RAISE EXCEPTION 'anat:CANONICAL_NUMBER_UNSUPPORTED' USING ERRCODE = '22023';
  END IF;
  RETURN s;
 END IF;
 RETURN p::text; -- true, false, null
END $$;

CREATE FUNCTION anat_sha256(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT encode(sha256(convert_to(anat_canonical_json(p), 'UTF8')), 'hex') $$;

CREATE FUNCTION anat_fail(p_code text, p_errcode text DEFAULT 'P0001') RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '%', 'anat:' || p_code USING ERRCODE = p_errcode; END $$;

CREATE FUNCTION anat_actor() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE v uuid := app_current_user_id();
BEGIN IF v IS NULL THEN PERFORM anat_fail('ACTOR_REQUIRED', '42501'); END IF; RETURN v; END $$;

-- Example list validation (P2 schema subset relevant to persistence): 1..20 objects, id ^[A-Za-z0-9._-]{1,64}$,
-- unique, never a reserved (holdout) corpus ID.
CREATE FUNCTION anat_assert_examples(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
 IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 20 THEN PERFORM anat_fail('LIMIT_EXCEEDED', '22023'); END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'id') IS DISTINCT FROM 'string'
            OR NOT (e ->> 'id') ~ '^[A-Za-z0-9._-]{1,64}$') THEN PERFORM anat_fail('INVALID_EXAMPLE', '22023'); END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p) e WHERE (e ->> 'id') IN ('04','06','08','09','12','14','16','18','24','28'))
  THEN PERFORM anat_fail('RESERVED_EXAMPLE_ID', '22023'); END IF;
 IF (SELECT count(DISTINCT e ->> 'id') FROM jsonb_array_elements(p) e) <> jsonb_array_length(p) THEN PERFORM anat_fail('DUPLICATE_EXAMPLE_ID', '22023'); END IF;
END $$;

CREATE FUNCTION anat_deny_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'anat:IMMUTABLE % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501'; END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE anatomy_rule_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author uuid NOT NULL,
 base_rule_set_id text, base_rule_hash text, profiles jsonb NOT NULL, examples jsonb NOT NULL,
 revision integer NOT NULL CHECK (revision >= 1), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (base_rule_set_id, base_rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash),
 CHECK (jsonb_typeof(profiles) = 'array')
);

-- anatomy_rule_sets is reused as the immutable snapshot catalogue (P3 §0.1). Admin snapshots carry snapshot_id.
ALTER TABLE anatomy_rule_sets ADD COLUMN snapshot_id uuid UNIQUE, ADD COLUMN frozen_from_draft uuid, ADD COLUMN frozen_at timestamptz;
ALTER TABLE anatomy_rule_sets ADD CONSTRAINT anatomy_rule_sets_admin_snapshot CHECK (snapshot_id IS NULL
 OR (id = snapshot_id::text AND status = 'reviewed' AND frozen_from_draft IS NOT NULL AND frozen_at IS NOT NULL
     AND author ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND reviewer IS NULL));
CREATE UNIQUE INDEX anatomy_rule_sets_admin_hash ON anatomy_rule_sets(rule_hash) WHERE snapshot_id IS NOT NULL;

CREATE TABLE anatomy_rule_example_sets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), example_set_hash char(64) NOT NULL UNIQUE CHECK (example_set_hash ~ '^[a-f0-9]{64}$'),
 examples jsonb NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

-- Frozen provenance (R2 criterion 4): draft id, revision and author are copied at freeze; nothing re-reads the draft.
CREATE TABLE anatomy_rule_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_set_id text NOT NULL, rule_hash text NOT NULL,
 example_set_id uuid NOT NULL REFERENCES anatomy_rule_example_sets(id),
 engine_hash char(64) NOT NULL CHECK (engine_hash ~ '^[a-f0-9]{64}$'), created_by uuid NOT NULL,
 draft_id uuid NOT NULL, draft_revision integer NOT NULL, draft_author uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (rule_set_id, rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash),
 UNIQUE (rule_hash, example_set_id, engine_hash)
);

CREATE TABLE anatomy_rule_simulations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL REFERENCES anatomy_rule_candidates(id),
 report jsonb NOT NULL, report_hash char(64) NOT NULL CHECK (report_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK (status IN ('complete','partial','cancelled','failed')),
 pass_count integer NOT NULL CHECK (pass_count >= 0), fail_count integer NOT NULL CHECK (fail_count >= 0),
 partial_count integer NOT NULL CHECK (partial_count >= 0), cancelled_count integer NOT NULL CHECK (cancelled_count >= 0),
 inconclusive_count integer NOT NULL CHECK (inconclusive_count >= 0),
 requested_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, candidate_id)
);
-- What each example execution actually produced (R2 criterion 1): compared against the comparison envelopes.
CREATE TABLE anatomy_rule_simulation_examples (
 simulation_id uuid NOT NULL REFERENCES anatomy_rule_simulations(id), example_id text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('pass','fail','partial','cancelled','failed','inconclusive')),
 input_text_hash char(64) CHECK (input_text_hash ~ '^[a-f0-9]{64}$'), output_hash char(64) CHECK (output_hash ~ '^[a-f0-9]{64}$'),
 analysis_id char(64) CHECK (analysis_id ~ '^[a-f0-9]{64}$'), rule_set_hash char(64) CHECK (rule_set_hash ~ '^[a-f0-9]{64}$'),
 engine_hash char(64) NOT NULL CHECK (engine_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY (simulation_id, example_id),
 CHECK (outcome IN ('cancelled','failed') OR (input_text_hash IS NOT NULL AND output_hash IS NOT NULL AND analysis_id IS NOT NULL AND rule_set_hash IS NOT NULL))
);

-- Deduplicated envelopes (one row per P2 envelope id) and per-candidate associations (R2 criterion 2): two candidates
-- may share an identical envelope; each keeps its own association row.
CREATE TABLE anatomy_rule_comparison_envelopes (
 comparison_hash char(64) PRIMARY KEY CHECK (comparison_hash ~ '^[a-f0-9]{64}$'), envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE anatomy_rule_comparisons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comparison_hash char(64) NOT NULL REFERENCES anatomy_rule_comparison_envelopes(comparison_hash),
 candidate_id uuid NOT NULL REFERENCES anatomy_rule_candidates(id), example_id text NOT NULL,
 baseline_rule_set_id text NOT NULL, baseline_rule_hash text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (baseline_rule_set_id, baseline_rule_hash) REFERENCES anatomy_rule_sets(id, rule_hash),
 UNIQUE (candidate_id, example_id, comparison_hash), UNIQUE (id, candidate_id)
);

CREATE TABLE anatomy_rule_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL, simulation_id uuid NOT NULL,
 reviewer uuid NOT NULL, outcome text NOT NULL CHECK (outcome IN ('approved','rejected')),
 rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 10 AND 4000), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (simulation_id, candidate_id) REFERENCES anatomy_rule_simulations(id, candidate_id), UNIQUE (id, candidate_id)
);
CREATE TABLE anatomy_rule_review_comparisons (
 review_id uuid NOT NULL, comparison_id uuid NOT NULL, candidate_id uuid NOT NULL, PRIMARY KEY (review_id, comparison_id),
 FOREIGN KEY (review_id, candidate_id) REFERENCES anatomy_rule_reviews(id, candidate_id),
 FOREIGN KEY (comparison_id, candidate_id) REFERENCES anatomy_rule_comparisons(id, candidate_id)
);
CREATE TABLE anatomy_rule_review_decisions (
 review_id uuid NOT NULL, comparison_id uuid NOT NULL, difference_id text NOT NULL,
 decision text NOT NULL CHECK (decision IN ('expected','regression','not_evaluated')), note text CHECK (char_length(note) <= 2000),
 PRIMARY KEY (review_id, comparison_id, difference_id),
 FOREIGN KEY (review_id, comparison_id) REFERENCES anatomy_rule_review_comparisons(review_id, comparison_id)
);

CREATE TABLE anatomy_rule_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text NOT NULL CHECK (scope ~ '^[a-z0-9:_-]{1,64}$'),
 candidate_id uuid NOT NULL, review_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('activate','rollback')),
 previous_activation_id uuid REFERENCES anatomy_rule_activations(id), preview_id uuid NOT NULL UNIQUE,
 affected_scope jsonb NOT NULL, actor uuid NOT NULL, justification text NOT NULL CHECK (char_length(justification) BETWEEN 10 AND 4000),
 activated_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
 FOREIGN KEY (review_id, candidate_id) REFERENCES anatomy_rule_reviews(id, candidate_id)
);
CREATE UNIQUE INDEX anatomy_rule_activations_current ON anatomy_rule_activations(scope) WHERE superseded_at IS NULL;

-- The raw token never reaches the database: the API generates it and sends only its SHA-256.
CREATE TABLE anatomy_rule_activation_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK (action IN ('activate','rollback')), actor uuid NOT NULL, scope text NOT NULL,
 candidate_id uuid NOT NULL, review_id uuid NOT NULL, observed_activation_id uuid REFERENCES anatomy_rule_activations(id),
 intent_hash char(64) NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'), affected_scope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz, consumed_activation_id uuid REFERENCES anatomy_rule_activations(id),
 FOREIGN KEY (review_id, candidate_id) REFERENCES anatomy_rule_reviews(id, candidate_id),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
 CHECK ((consumed_at IS NULL) = (consumed_activation_id IS NULL))
);
ALTER TABLE anatomy_rule_activations ADD FOREIGN KEY (preview_id) REFERENCES anatomy_rule_activation_previews(id) DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------------------------------------------
-- Integrity triggers (independent of the calling path)
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION anat_guard_draft() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 PERFORM anat_assert_examples(NEW.examples);
 IF TG_OP = 'UPDATE' AND (NEW.id, NEW.author, NEW.base_rule_set_id, NEW.base_rule_hash) IS DISTINCT FROM (OLD.id, OLD.author, OLD.base_rule_set_id, OLD.base_rule_hash)
  THEN PERFORM anat_fail('IMMUTABLE', '42501'); END IF;
 IF TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1 THEN PERFORM anat_fail('STALE_REVISION'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_draft BEFORE INSERT OR UPDATE ON anatomy_rule_drafts FOR EACH ROW EXECUTE FUNCTION anat_guard_draft();

CREATE FUNCTION anat_guard_rule_set() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.snapshot_id IS NOT NULL AND (jsonb_typeof(NEW.profiles) <> 'array' OR NEW.rule_hash <> anat_sha256(NEW.profiles))
  THEN PERFORM anat_fail('HASH_MISMATCH', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_rule_set BEFORE INSERT ON anatomy_rule_sets FOR EACH ROW EXECUTE FUNCTION anat_guard_rule_set();

CREATE FUNCTION anat_guard_example_set() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 PERFORM anat_assert_examples(NEW.examples);
 IF NEW.example_set_hash <> anat_sha256(NEW.examples) THEN PERFORM anat_fail('HASH_MISMATCH', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_example_set BEFORE INSERT ON anatomy_rule_example_sets FOR EACH ROW EXECUTE FUNCTION anat_guard_example_set();

CREATE FUNCTION anat_guard_candidate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_sets WHERE id = NEW.rule_set_id AND rule_hash = NEW.rule_hash AND snapshot_id IS NOT NULL)
  THEN PERFORM anat_fail('SNAPSHOT_REQUIRED', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_candidate BEFORE INSERT ON anatomy_rule_candidates FOR EACH ROW EXECUTE FUNCTION anat_guard_candidate();

CREATE FUNCTION anat_guard_envelope() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF jsonb_typeof(NEW.envelope) <> 'object' OR NEW.envelope ->> 'id' IS DISTINCT FROM NEW.comparison_hash::text
    OR NEW.comparison_hash <> anat_sha256(NEW.envelope - 'id')
    OR jsonb_typeof(NEW.envelope -> 'differences') IS DISTINCT FROM 'array'
    OR (SELECT count(DISTINCT d ->> 'id') FROM jsonb_array_elements(NEW.envelope -> 'differences') d) <> jsonb_array_length(NEW.envelope -> 'differences')
  THEN PERFORM anat_fail('COMPARISON_MISMATCH', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_envelope BEFORE INSERT ON anatomy_rule_comparison_envelopes FOR EACH ROW EXECUTE FUNCTION anat_guard_envelope();

-- Author != reviewer, from frozen provenance only (candidate creator, draft author copied at freeze, snapshot author).
CREATE FUNCTION anat_guard_review() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM anatomy_rule_candidates c JOIN anatomy_rule_sets s ON s.id = c.rule_set_id AND s.rule_hash = c.rule_hash
            WHERE c.id = NEW.candidate_id AND NEW.reviewer IN (c.created_by, c.draft_author, s.author::uuid))
  THEN PERFORM anat_fail('AUTHOR_CANNOT_REVIEW', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_review BEFORE INSERT ON anatomy_rule_reviews FOR EACH ROW EXECUTE FUNCTION anat_guard_review();

CREATE FUNCTION anat_guard_decision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_comparisons c JOIN anatomy_rule_comparison_envelopes e USING (comparison_hash),
                jsonb_array_elements(e.envelope -> 'differences') d WHERE c.id = NEW.comparison_id AND d ->> 'id' = NEW.difference_id)
  THEN PERFORM anat_fail('REVIEW_INCOMPLETE', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_decision BEFORE INSERT ON anatomy_rule_review_decisions FOR EACH ROW EXECUTE FUNCTION anat_guard_decision();

-- §2.5 approval rules. Called by anat_record_review and again at COMMIT by a deferred constraint trigger, so links
-- added later in the same transaction are seen and a direct INSERT path cannot skip the rules.
CREATE FUNCTION anat_assert_approval(p_review uuid) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE r anatomy_rule_reviews; c anatomy_rule_candidates; s anatomy_rule_simulations; ex jsonb; n int;
BEGIN
 SELECT * INTO r FROM anatomy_rule_reviews WHERE id = p_review;
 IF r.outcome <> 'approved' THEN RETURN; END IF;
 SELECT * INTO c FROM anatomy_rule_candidates WHERE id = r.candidate_id;
 SELECT * INTO s FROM anatomy_rule_simulations WHERE id = r.simulation_id;
 SELECT examples INTO ex FROM anatomy_rule_example_sets WHERE id = c.example_set_id;
 n := jsonb_array_length(ex);
 -- (1)(2) same candidate (composite FK), complete, every required example executed and pass, nothing else.
 IF s.status <> 'complete' OR s.fail_count + s.partial_count + s.cancelled_count + s.inconclusive_count > 0
    OR (SELECT count(*) FROM anatomy_rule_simulation_examples se WHERE se.simulation_id = s.id) <> n
    OR (SELECT count(*) FROM anatomy_rule_simulation_examples se JOIN jsonb_array_elements(ex) e ON e ->> 'id' = se.example_id
        WHERE se.simulation_id = s.id AND se.outcome = 'pass' AND se.engine_hash = c.engine_hash) <> n
  THEN PERFORM anat_fail('SIMULATION_NOT_PASSING', '23514'); END IF;
 -- (3) exactly one linked comparison per required example, bound to this candidate, its profiles, its engine, the
 -- declared baseline AND to what this simulation actually executed (input, output, analysis, rule set; criterion 1).
 IF (SELECT count(*) FROM anatomy_rule_review_comparisons WHERE review_id = r.id) <> n
    OR (SELECT count(DISTINCT cmp.example_id) FROM anatomy_rule_review_comparisons rc JOIN anatomy_rule_comparisons cmp ON cmp.id = rc.comparison_id
        WHERE rc.review_id = r.id) <> n
  THEN PERFORM anat_fail('REVIEW_INCOMPLETE', '23514'); END IF;
 IF EXISTS (SELECT 1 FROM anatomy_rule_review_comparisons rc
            JOIN anatomy_rule_comparisons cmp ON cmp.id = rc.comparison_id
            JOIN anatomy_rule_comparison_envelopes env ON env.comparison_hash = cmp.comparison_hash
            LEFT JOIN anatomy_rule_simulation_examples se ON se.simulation_id = s.id AND se.example_id = cmp.example_id
            WHERE rc.review_id = r.id AND (
              se.example_id IS NULL OR cmp.candidate_id <> c.id
              OR env.envelope #>> '{provenance,afterProfileSetHash}' IS DISTINCT FROM c.rule_hash
              OR env.envelope #>> '{provenance,beforeProfileSetHash}' IS DISTINCT FROM cmp.baseline_rule_hash
              OR env.envelope #>> '{after,engineHash}' IS DISTINCT FROM c.engine_hash::text
              OR env.envelope #>> '{before,engineHash}' IS DISTINCT FROM c.engine_hash::text
              OR env.envelope #>> '{snapshot,inputTextHash}' IS DISTINCT FROM se.input_text_hash::text
              OR env.envelope #>> '{after,outputHash}' IS DISTINCT FROM se.output_hash::text
              OR env.envelope #>> '{after,analysisId}' IS DISTINCT FROM se.analysis_id::text
              OR env.envelope #>> '{after,ruleSetHash}' IS DISTINCT FROM se.rule_set_hash::text))
  THEN PERFORM anat_fail('COMPARISON_MISMATCH', '23514'); END IF;
 -- (4) every difference has exactly one decision (PK) and it is 'expected'; no unknown ids (decision trigger).
 IF EXISTS (SELECT 1 FROM anatomy_rule_review_decisions WHERE review_id = r.id AND decision <> 'expected')
    OR (SELECT count(*) FROM anatomy_rule_review_decisions WHERE review_id = r.id)
       <> (SELECT coalesce(sum(jsonb_array_length(env.envelope -> 'differences')), 0) FROM anatomy_rule_review_comparisons rc
           JOIN anatomy_rule_comparisons cmp ON cmp.id = rc.comparison_id
           JOIN anatomy_rule_comparison_envelopes env ON env.comparison_hash = cmp.comparison_hash WHERE rc.review_id = r.id)
  THEN PERFORM anat_fail('REVIEW_INCOMPLETE', '23514'); END IF;
END $$;
CREATE FUNCTION anat_check_approval_at_commit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN PERFORM anat_assert_approval(NEW.review_id); RETURN NULL; END $$;
CREATE FUNCTION anat_check_review_at_commit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN PERFORM anat_assert_approval(NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER anat_approval_rules AFTER INSERT ON anatomy_rule_reviews DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION anat_check_review_at_commit();
CREATE CONSTRAINT TRIGGER anat_approval_links AFTER INSERT ON anatomy_rule_review_comparisons DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION anat_check_approval_at_commit();
CREATE CONSTRAINT TRIGGER anat_approval_decisions AFTER INSERT ON anatomy_rule_review_decisions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION anat_check_approval_at_commit();

-- Activations: only superseded_at NULL -> value. Previews: only consumed_at/consumed_activation_id NULL -> value.
CREATE FUNCTION anat_guard_activation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
    OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN PERFORM anat_fail('IMMUTABLE', '42501'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_activation_update BEFORE UPDATE ON anatomy_rule_activations FOR EACH ROW EXECUTE FUNCTION anat_guard_activation_update();
CREATE FUNCTION anat_guard_activation_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_reviews WHERE id = NEW.review_id AND candidate_id = NEW.candidate_id AND outcome = 'approved')
    OR NEW.superseded_at IS NOT NULL THEN PERFORM anat_fail('REVIEW_INCOMPLETE', '23514'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_activation_insert BEFORE INSERT ON anatomy_rule_activations FOR EACH ROW EXECUTE FUNCTION anat_guard_activation_insert();
CREATE FUNCTION anat_guard_preview_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR (to_jsonb(NEW) - 'consumed_at' - 'consumed_activation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at' - 'consumed_activation_id')
  THEN PERFORM anat_fail('IMMUTABLE', '42501'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anat_guard_preview_update BEFORE UPDATE ON anatomy_rule_activation_previews FOR EACH ROW EXECUTE FUNCTION anat_guard_preview_update();

-- Append-only: no UPDATE (except the two transitions above), no DELETE, no TRUNCATE, for every role (owner included).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['anatomy_rule_sets','anatomy_rule_example_sets','anatomy_rule_candidates','anatomy_rule_simulations',
  'anatomy_rule_simulation_examples','anatomy_rule_comparison_envelopes','anatomy_rule_comparisons','anatomy_rule_reviews',
  'anatomy_rule_review_comparisons','anatomy_rule_review_decisions'] LOOP
  EXECUTE format('CREATE TRIGGER anat_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION anat_deny_change()', t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anatomy_rule_drafts','anatomy_rule_sets','anatomy_rule_example_sets','anatomy_rule_candidates',
  'anatomy_rule_simulations','anatomy_rule_simulation_examples','anatomy_rule_comparison_envelopes','anatomy_rule_comparisons',
  'anatomy_rule_reviews','anatomy_rule_review_comparisons','anatomy_rule_review_decisions','anatomy_rule_activations',
  'anatomy_rule_activation_previews'] LOOP
  EXECUTE format('CREATE TRIGGER anat_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION anat_deny_change()', t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['anatomy_rule_drafts','anatomy_rule_activations','anatomy_rule_activation_previews'] LOOP
  EXECUTE format('CREATE TRIGGER anat_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION anat_deny_change()', t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Transactional functions (SECURITY INVOKER: they run with radar_app's own grants; audit in the same transaction)
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION anat_audit(p_action text, p_entity uuid, p_payload jsonb, p_correlation uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public AS $$
 INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, after_data, correlation_id)
 VALUES (NULL, 'ADMIN', anat_actor()::text, p_action, 'anatomy_rules', p_entity::text, jsonb_strip_nulls(p_payload), p_correlation) $$;

CREATE FUNCTION anat_save_draft(p_draft uuid, p_expected_revision integer, p_profiles jsonb, p_examples jsonb, p_correlation uuid,
 OUT draft_id uuid, OUT revision integer) LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor();
BEGIN
 IF p_draft IS NULL THEN
  INSERT INTO anatomy_rule_drafts (author, profiles, examples, revision) VALUES (v_actor, p_profiles, p_examples, 1)
  RETURNING id, anatomy_rule_drafts.revision INTO draft_id, revision;
 ELSE
  IF NOT EXISTS (SELECT 1 FROM anatomy_rule_drafts d WHERE d.id = p_draft AND d.author = v_actor) THEN PERFORM anat_fail('DRAFT_NOT_FOUND', '42501'); END IF;
  UPDATE anatomy_rule_drafts d SET profiles = p_profiles, examples = p_examples, revision = d.revision + 1, updated_at = now()
   WHERE d.id = p_draft AND d.author = v_actor AND d.revision = p_expected_revision
  RETURNING d.id, d.revision INTO draft_id, revision;
  IF draft_id IS NULL THEN PERFORM anat_fail('STALE_REVISION'); END IF;
 END IF;
 PERFORM anat_audit('ANAT_RULES_DRAFT_SAVED', draft_id, jsonb_build_object('draftId', draft_id, 'revision', revision,
  'profileSetHash', anat_sha256(p_profiles), 'exampleSetHash', anat_sha256(p_examples)), p_correlation);
END $$;

-- Idempotent freeze (R2 criterion 5): snapshot and example set are upserted by hash and NEVER updated (content and
-- authorship of an existing row are kept); the same (rule_hash, example_set, engine) triple returns the existing
-- candidate with created = false and no new audit row; any changed hash creates a new candidate.
CREATE FUNCTION anat_freeze(p_draft uuid, p_expected_revision integer, p_engine_hash text, p_correlation uuid,
 OUT candidate_id uuid, OUT created boolean) LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); d anatomy_rule_drafts; v_rule_hash text; v_set_id text; v_ex_hash text; v_ex_id uuid; v_snap uuid := gen_random_uuid();
BEGIN
 SELECT * INTO d FROM anatomy_rule_drafts WHERE id = p_draft AND author = v_actor;
 IF NOT FOUND THEN PERFORM anat_fail('DRAFT_NOT_FOUND', '42501'); END IF;
 IF d.revision <> p_expected_revision THEN PERFORM anat_fail('STALE_REVISION'); END IF;
 v_rule_hash := anat_sha256(d.profiles); v_ex_hash := anat_sha256(d.examples);
 INSERT INTO anatomy_rule_sets (id, version, status, rule_hash, contract_version, profiles, author, snapshot_id, frozen_from_draft, frozen_at)
 VALUES (v_snap::text, '1', 'reviewed', v_rule_hash, 'ANAT-TAX/1.0.0', d.profiles, v_actor::text, v_snap, d.id, now())
 ON CONFLICT (rule_hash) WHERE snapshot_id IS NOT NULL DO NOTHING;
 SELECT id INTO v_set_id FROM anatomy_rule_sets WHERE rule_hash = v_rule_hash AND snapshot_id IS NOT NULL;
 INSERT INTO anatomy_rule_example_sets (example_set_hash, examples, created_by) VALUES (v_ex_hash, d.examples, v_actor)
 ON CONFLICT (example_set_hash) DO NOTHING;
 SELECT id INTO v_ex_id FROM anatomy_rule_example_sets WHERE example_set_hash = v_ex_hash;
 INSERT INTO anatomy_rule_candidates (rule_set_id, rule_hash, example_set_id, engine_hash, created_by, draft_id, draft_revision, draft_author)
 VALUES (v_set_id, v_rule_hash, v_ex_id, p_engine_hash, v_actor, d.id, d.revision, d.author)
 ON CONFLICT (rule_hash, example_set_id, engine_hash) DO NOTHING RETURNING id INTO candidate_id;
 created := candidate_id IS NOT NULL;
 IF NOT created THEN
  SELECT id INTO candidate_id FROM anatomy_rule_candidates c WHERE c.rule_hash = v_rule_hash AND c.example_set_id = v_ex_id AND c.engine_hash = p_engine_hash;
  RETURN;
 END IF;
 PERFORM anat_audit('ANAT_RULES_CANDIDATE_FROZEN', candidate_id, jsonb_build_object('candidateId', candidate_id, 'draftId', d.id,
  'profileSetHash', v_rule_hash, 'exampleSetHash', v_ex_hash, 'engineHash', p_engine_hash), p_correlation);
END $$;

-- p_examples: [{exampleId, outcome, inputTextHash, outputHash, analysisId, ruleSetHash, engineHash}] as produced by the
-- executor (package c). Counts are derived here, never trusted from the caller.
CREATE FUNCTION anat_record_simulation(p_candidate uuid, p_status text, p_report jsonb, p_examples jsonb, p_correlation uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); c anatomy_rule_candidates; v_id uuid; v_counts record;
BEGIN
 SELECT * INTO c FROM anatomy_rule_candidates WHERE id = p_candidate;
 IF NOT FOUND THEN PERFORM anat_fail('CANDIDATE_NOT_FOUND', '22023'); END IF;
 IF jsonb_typeof(p_examples) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_examples) e
     WHERE NOT EXISTS (SELECT 1 FROM anatomy_rule_example_sets s, jsonb_array_elements(s.examples) x WHERE s.id = c.example_set_id AND x ->> 'id' = e ->> 'exampleId'))
  THEN PERFORM anat_fail('INVALID_EXAMPLE', '22023'); END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_examples) e WHERE e ->> 'engineHash' IS DISTINCT FROM c.engine_hash::text)
  THEN PERFORM anat_fail('ENGINE_MISMATCH'); END IF;
 SELECT count(*) FILTER (WHERE e ->> 'outcome' = 'pass') AS pass, count(*) FILTER (WHERE e ->> 'outcome' IN ('fail','failed')) AS fail,
  count(*) FILTER (WHERE e ->> 'outcome' = 'partial') AS partial, count(*) FILTER (WHERE e ->> 'outcome' = 'cancelled') AS cancelled,
  count(*) FILTER (WHERE e ->> 'outcome' = 'inconclusive') AS inconclusive INTO v_counts FROM jsonb_array_elements(p_examples) e;
 INSERT INTO anatomy_rule_simulations (candidate_id, report, report_hash, status, pass_count, fail_count, partial_count, cancelled_count, inconclusive_count, requested_by)
 VALUES (c.id, p_report, anat_sha256(p_report), p_status, v_counts.pass, v_counts.fail, v_counts.partial, v_counts.cancelled, v_counts.inconclusive, v_actor)
 RETURNING id INTO v_id;
 INSERT INTO anatomy_rule_simulation_examples (simulation_id, example_id, outcome, input_text_hash, output_hash, analysis_id, rule_set_hash, engine_hash)
 SELECT v_id, e ->> 'exampleId', e ->> 'outcome', e ->> 'inputTextHash', e ->> 'outputHash', e ->> 'analysisId', e ->> 'ruleSetHash', e ->> 'engineHash'
 FROM jsonb_array_elements(p_examples) e;
 PERFORM anat_audit('ANAT_RULES_SIMULATED', v_id, jsonb_build_object('simulationId', v_id, 'candidateId', c.id, 'reportHash', anat_sha256(p_report),
  'status', upper(p_status), 'passCount', v_counts.pass, 'failCount', v_counts.fail, 'partialCount', v_counts.partial,
  'cancelledCount', v_counts.cancelled, 'inconclusiveCount', v_counts.inconclusive), p_correlation);
 RETURN v_id;
END $$;

-- The envelope row is shared by hash; the association (candidate, example) is per candidate. Re-recording the same
-- association returns the existing id with no new audit row.
CREATE FUNCTION anat_record_comparison(p_candidate uuid, p_example_id text, p_baseline_rule_set_id text, p_baseline_rule_hash text,
 p_envelope jsonb, p_correlation uuid, OUT comparison_id uuid, OUT created boolean) LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); c anatomy_rule_candidates; v_hash text := p_envelope ->> 'id';
BEGIN
 SELECT * INTO c FROM anatomy_rule_candidates WHERE id = p_candidate;
 IF NOT FOUND THEN PERFORM anat_fail('CANDIDATE_NOT_FOUND', '22023'); END IF;
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_example_sets s, jsonb_array_elements(s.examples) x WHERE s.id = c.example_set_id AND x ->> 'id' = p_example_id)
    OR p_envelope #>> '{provenance,afterProfileSetHash}' IS DISTINCT FROM c.rule_hash
    OR p_envelope #>> '{provenance,beforeProfileSetHash}' IS DISTINCT FROM p_baseline_rule_hash
    OR p_envelope #>> '{after,engineHash}' IS DISTINCT FROM c.engine_hash::text
    OR p_envelope #>> '{before,engineHash}' IS DISTINCT FROM c.engine_hash::text
  THEN PERFORM anat_fail('COMPARISON_MISMATCH'); END IF;
 INSERT INTO anatomy_rule_comparison_envelopes (comparison_hash, envelope) VALUES (v_hash, p_envelope) ON CONFLICT (comparison_hash) DO NOTHING;
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_comparison_envelopes WHERE comparison_hash = v_hash AND envelope = p_envelope)
  THEN PERFORM anat_fail('COMPARISON_MISMATCH'); END IF;
 INSERT INTO anatomy_rule_comparisons (comparison_hash, candidate_id, example_id, baseline_rule_set_id, baseline_rule_hash, created_by)
 VALUES (v_hash, c.id, p_example_id, p_baseline_rule_set_id, p_baseline_rule_hash, v_actor)
 ON CONFLICT (candidate_id, example_id, comparison_hash) DO NOTHING RETURNING id INTO comparison_id;
 created := comparison_id IS NOT NULL;
 IF NOT created THEN
  SELECT id INTO comparison_id FROM anatomy_rule_comparisons x WHERE x.candidate_id = c.id AND x.example_id = p_example_id AND x.comparison_hash = v_hash;
  RETURN;
 END IF;
 PERFORM anat_audit('ANAT_RULES_COMPARED', comparison_id, jsonb_build_object('comparisonId', comparison_id, 'candidateId', c.id,
  'comparisonHash', v_hash, 'baselineProfileSetHash', p_baseline_rule_hash, 'differenceCount', jsonb_array_length(p_envelope -> 'differences')), p_correlation);
END $$;

-- p_decisions: [{comparisonId, differenceId, decision, note}]. Rationale and notes stay in domain tables only.
CREATE FUNCTION anat_record_review(p_candidate uuid, p_simulation uuid, p_outcome text, p_rationale text, p_comparisons uuid[],
 p_decisions jsonb, p_correlation uuid) RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); v_id uuid;
BEGIN
 INSERT INTO anatomy_rule_reviews (candidate_id, simulation_id, reviewer, outcome, rationale)
 VALUES (p_candidate, p_simulation, v_actor, p_outcome, p_rationale) RETURNING id INTO v_id;
 INSERT INTO anatomy_rule_review_comparisons (review_id, comparison_id, candidate_id) SELECT v_id, x, p_candidate FROM unnest(p_comparisons) x;
 INSERT INTO anatomy_rule_review_decisions (review_id, comparison_id, difference_id, decision, note)
 SELECT v_id, (d ->> 'comparisonId')::uuid, d ->> 'differenceId', d ->> 'decision', d ->> 'note' FROM jsonb_array_elements(coalesce(p_decisions, '[]')) d;
 PERFORM anat_assert_approval(v_id);
 PERFORM anat_audit('ANAT_RULES_REVIEWED', v_id, jsonb_build_object('reviewId', v_id, 'candidateId', p_candidate, 'simulationId', p_simulation,
  'outcome', upper(p_outcome), 'comparisonCount', cardinality(p_comparisons), 'decisionCount', jsonb_array_length(coalesce(p_decisions, '[]'))), p_correlation);
 RETURN v_id;
END $$;

CREATE FUNCTION anat_intent_hash(p_action text, p_candidate uuid, p_review uuid, p_observed uuid, p_scope text, p_expires timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
 SELECT anat_sha256(jsonb_build_object('action', p_action, 'candidateId', p_candidate, 'reviewId', p_review, 'observedActivationId', p_observed,
  'scope', p_scope, 'expiresAt', to_char(p_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) $$;

CREATE FUNCTION anat_preview(p_action text, p_candidate uuid, p_review uuid, p_scope text, p_engine_hash text, p_token_hash text,
 p_affected_scope jsonb, p_correlation uuid, OUT preview_id uuid, OUT intent_hash text, OUT expires_at timestamptz)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); c anatomy_rule_candidates; v_observed uuid;
BEGIN
 SELECT * INTO c FROM anatomy_rule_candidates WHERE id = p_candidate;
 IF NOT FOUND THEN PERFORM anat_fail('CANDIDATE_NOT_FOUND', '22023'); END IF;
 IF c.engine_hash::text IS DISTINCT FROM p_engine_hash THEN PERFORM anat_fail('ENGINE_MISMATCH'); END IF;
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_reviews WHERE id = p_review AND candidate_id = p_candidate AND outcome = 'approved')
  THEN PERFORM anat_fail('REVIEW_INCOMPLETE'); END IF;
 IF p_action = 'rollback' AND NOT EXISTS (SELECT 1 FROM anatomy_rule_activations WHERE scope = p_scope AND candidate_id = p_candidate AND superseded_at IS NOT NULL)
  THEN PERFORM anat_fail('PREVIEW_STALE'); END IF;
 SELECT id INTO v_observed FROM anatomy_rule_activations WHERE scope = p_scope AND superseded_at IS NULL;
 expires_at := date_trunc('milliseconds', now()) + interval '10 minutes';
 intent_hash := anat_intent_hash(p_action, p_candidate, p_review, v_observed, p_scope, expires_at);
 INSERT INTO anatomy_rule_activation_previews (token_hash, action, actor, scope, candidate_id, review_id, observed_activation_id, intent_hash, affected_scope, created_at, expires_at)
 VALUES (p_token_hash, p_action, v_actor, p_scope, p_candidate, p_review, v_observed, intent_hash, p_affected_scope, date_trunc('milliseconds', now()), expires_at)
 RETURNING id INTO preview_id;
 PERFORM anat_audit('ANAT_RULES_ACTIVATION_PREVIEWED', preview_id, jsonb_build_object('previewId', preview_id, 'candidateId', p_candidate,
  'reviewId', p_review, 'action', upper(p_action), 'intentHash', intent_hash, 'expiresMinutes', 10), p_correlation);
END $$;

-- Confirm (run in SERIALIZABLE; the caller retries 40001 up to 3 times). Token/actor/intent mapping (R2 criterion 3):
--   unknown token or another actor's token -> PREVIEW_EXPIRED (no information about other actors' previews);
--   same token+actor, different intent      -> PREVIEW_STALE;
--   consumed, same token+actor+intent       -> the existing activation, replayed = true, no new row and no audit;
--   expired and unconsumed                  -> PREVIEW_EXPIRED;  current activation != observed -> PREVIEW_STALE.
CREATE FUNCTION anat_confirm(p_token_hash text, p_intent_hash text, p_engine_hash text, p_justification text, p_correlation uuid,
 OUT activation_id uuid, OUT replayed boolean) LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_actor uuid := anat_actor(); p anatomy_rule_activation_previews; v_current uuid;
BEGIN
 SELECT * INTO p FROM anatomy_rule_activation_previews WHERE token_hash = p_token_hash AND actor = v_actor FOR UPDATE;
 IF NOT FOUND THEN PERFORM anat_fail('PREVIEW_EXPIRED'); END IF;
 IF p.intent_hash::text IS DISTINCT FROM p_intent_hash THEN PERFORM anat_fail('PREVIEW_STALE'); END IF;
 IF p.consumed_at IS NOT NULL THEN activation_id := p.consumed_activation_id; replayed := true; RETURN; END IF;
 IF p.expires_at <= now() THEN PERFORM anat_fail('PREVIEW_EXPIRED'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('anat-activation:' || p.scope, 0));
 SELECT id INTO v_current FROM anatomy_rule_activations WHERE scope = p.scope AND superseded_at IS NULL FOR UPDATE;
 IF v_current IS DISTINCT FROM p.observed_activation_id THEN PERFORM anat_fail('PREVIEW_STALE'); END IF;
 IF NOT EXISTS (SELECT 1 FROM anatomy_rule_candidates WHERE id = p.candidate_id AND engine_hash::text = p_engine_hash)
  THEN PERFORM anat_fail('ENGINE_MISMATCH'); END IF;
 IF v_current IS NOT NULL THEN UPDATE anatomy_rule_activations SET superseded_at = now() WHERE id = v_current; END IF;
 INSERT INTO anatomy_rule_activations (scope, candidate_id, review_id, kind, previous_activation_id, preview_id, affected_scope, actor, justification)
 VALUES (p.scope, p.candidate_id, p.review_id, p.action, v_current, p.id, p.affected_scope, v_actor, p_justification) RETURNING id INTO activation_id;
 UPDATE anatomy_rule_activation_previews SET consumed_at = now(), consumed_activation_id = activation_id WHERE id = p.id;
 replayed := false;
 PERFORM anat_audit('ANAT_RULES_ACTIVATED', activation_id, jsonb_build_object('activationId', activation_id, 'previousActivationId', v_current,
  'candidateId', p.candidate_id, 'reviewId', p.review_id, 'previewId', p.id, 'action', upper(p.action)), p_correlation);
END $$;

-- Failure after validation/authorisation: called by the API in a SEPARATE transaction after the rollback.
CREATE FUNCTION anat_audit_attempt(p_operation text, p_code text, p_target uuid, p_correlation uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public AS $$
 SELECT anat_audit('ANAT_RULES_ATTEMPT_REJECTED', coalesce(p_target, p_correlation),
  jsonb_build_object('operation', p_operation, 'code', p_code, 'targetId', p_target), p_correlation) $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges (P3 §2.3). PUBLIC has nothing; radar_taxonomy_curator has nothing.
-- ---------------------------------------------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['anatomy_rule_drafts','anatomy_rule_sets','anatomy_rule_example_sets','anatomy_rule_candidates',
  'anatomy_rule_simulations','anatomy_rule_simulation_examples','anatomy_rule_comparison_envelopes','anatomy_rule_comparisons',
  'anatomy_rule_reviews','anatomy_rule_review_comparisons','anatomy_rule_review_decisions','anatomy_rule_activations',
  'anatomy_rule_activation_previews'] LOOP
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator', t);
  EXECUTE format('GRANT SELECT, INSERT ON %I TO radar_app', t);
 END LOOP;
END $$;
GRANT UPDATE (profiles, examples, revision, updated_at) ON anatomy_rule_drafts TO radar_app;
GRANT UPDATE (consumed_at, consumed_activation_id) ON anatomy_rule_activation_previews TO radar_app;
GRANT UPDATE (superseded_at) ON anatomy_rule_activations TO radar_app;
GRANT SELECT ON anatomy_rule_sets, anatomy_rule_activations TO radar_worker;
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'anat\_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO radar_app', f);
 END LOOP;
END $$;
