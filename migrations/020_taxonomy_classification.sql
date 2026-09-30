-- TAX-07 / 020
-- Global, versioned publication taxonomy classification. No tenant-scoped data.

CREATE TABLE publication_taxonomy_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL
        REFERENCES publication_versions(id) ON DELETE RESTRICT,
    taxonomy_release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id) ON DELETE RESTRICT,
    method_type TEXT NOT NULL
        CHECK (method_type IN ('RULE', 'EXTRACTOR', 'MODEL', 'HUMAN', 'HYBRID')),
    engine_key TEXT NOT NULL CHECK (btrim(engine_key) <> ''),
    engine_version TEXT NOT NULL CHECK (btrim(engine_version) <> ''),
    model_key TEXT,
    model_version TEXT,
    code_git_sha TEXT,
    config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    config_sha256 CHAR(64) NOT NULL
        CHECK (config_sha256 ~ '^[a-f0-9]{64}$'),
    input_sha256 CHAR(64) NOT NULL
        CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
    run_fingerprint CHAR(64) NOT NULL
        CHECK (run_fingerprint ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN (
            'PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL',
            'FAILED', 'CANCELLED'
        )),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_code TEXT,
    error_message TEXT,
    supersedes_run_id UUID
        REFERENCES publication_taxonomy_runs(id) ON DELETE RESTRICT,
    lifecycle_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_taxonomy_run_fingerprint UNIQUE (run_fingerprint),
    CONSTRAINT uq_publication_taxonomy_run_release_identity UNIQUE (id, taxonomy_release_id),
    CONSTRAINT chk_publication_taxonomy_run_config_object
        CHECK (jsonb_typeof(config_snapshot) = 'object'),
    CONSTRAINT chk_publication_taxonomy_run_lifecycle_object
        CHECK (jsonb_typeof(lifecycle_metadata) = 'object'),
    CONSTRAINT chk_publication_taxonomy_run_model_pair
        CHECK (
            (model_key IS NULL AND model_version IS NULL)
            OR (
                model_key IS NOT NULL AND btrim(model_key) <> ''
                AND model_version IS NOT NULL AND btrim(model_version) <> ''
            )
        ),
    CONSTRAINT chk_publication_taxonomy_run_model_required
        CHECK (
            method_type <> 'MODEL'
            OR (model_key IS NOT NULL AND model_version IS NOT NULL)
        ),
    CONSTRAINT chk_publication_taxonomy_run_not_self_supersedes
        CHECK (supersedes_run_id IS NULL OR supersedes_run_id <> id),
    CONSTRAINT chk_publication_taxonomy_run_times
        CHECK (
            finished_at IS NULL
            OR started_at IS NULL
            OR finished_at >= started_at
        ),
    CONSTRAINT chk_publication_taxonomy_run_terminal_finished
        CHECK (
            status NOT IN ('SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED')
            OR finished_at IS NOT NULL
        )
);

CREATE INDEX ix_publication_taxonomy_runs_version_release
ON publication_taxonomy_runs(publication_version_id, taxonomy_release_id);

CREATE INDEX ix_publication_taxonomy_runs_release_status
ON publication_taxonomy_runs(taxonomy_release_id, status);

CREATE INDEX ix_publication_taxonomy_runs_supersedes
ON publication_taxonomy_runs(supersedes_run_id)
WHERE supersedes_run_id IS NOT NULL;


CREATE OR REPLACE FUNCTION taxonomy_classification_guard_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    release_status TEXT;
    target_version UUID;
    target_release UUID;
    cursor_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT status INTO release_status
        FROM taxonomy_releases
        WHERE id = NEW.taxonomy_release_id;

        IF release_status IS DISTINCT FROM 'PUBLISHED' THEN
            RAISE EXCEPTION
                'classification run requires a PUBLISHED taxonomy release';
        END IF;
    ELSE
        IF NEW.publication_version_id IS DISTINCT FROM OLD.publication_version_id
           OR NEW.taxonomy_release_id IS DISTINCT FROM OLD.taxonomy_release_id
           OR NEW.method_type IS DISTINCT FROM OLD.method_type
           OR NEW.engine_key IS DISTINCT FROM OLD.engine_key
           OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
           OR NEW.model_key IS DISTINCT FROM OLD.model_key
           OR NEW.model_version IS DISTINCT FROM OLD.model_version
           OR NEW.code_git_sha IS DISTINCT FROM OLD.code_git_sha
           OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
           OR NEW.config_sha256 IS DISTINCT FROM OLD.config_sha256
           OR NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256
           OR NEW.run_fingerprint IS DISTINCT FROM OLD.run_fingerprint
           OR NEW.supersedes_run_id IS DISTINCT FROM OLD.supersedes_run_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION
                'classification run material identity is immutable';
        END IF;

        IF OLD.status IN ('SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED')
           AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'terminal classification run is immutable';
        END IF;

        IF OLD.status = 'PENDING'
           AND NEW.status NOT IN ('PENDING', 'RUNNING', 'FAILED', 'CANCELLED') THEN
            RAISE EXCEPTION 'invalid classification run lifecycle transition';
        END IF;

        IF OLD.status = 'RUNNING'
           AND NEW.status NOT IN (
               'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED'
           ) THEN
            RAISE EXCEPTION 'invalid classification run lifecycle transition';
        END IF;
    END IF;

    IF NEW.supersedes_run_id IS NOT NULL THEN
        SELECT publication_version_id, taxonomy_release_id
        INTO target_version, target_release
        FROM publication_taxonomy_runs
        WHERE id = NEW.supersedes_run_id;

        IF target_version IS NULL THEN
            RAISE EXCEPTION 'superseded classification run does not exist';
        END IF;

        IF target_version IS DISTINCT FROM NEW.publication_version_id
           OR target_release IS DISTINCT FROM NEW.taxonomy_release_id THEN
            RAISE EXCEPTION
                'superseded run must use the same publication version and taxonomy release';
        END IF;

        cursor_id := NEW.supersedes_run_id;
        WHILE cursor_id IS NOT NULL LOOP
            IF cursor_id = NEW.id THEN
                RAISE EXCEPTION 'classification run supersession cycle detected';
            END IF;
            SELECT supersedes_run_id INTO cursor_id
            FROM publication_taxonomy_runs
            WHERE id = cursor_id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_publication_taxonomy_run_guard
BEFORE INSERT OR UPDATE
ON publication_taxonomy_runs
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_guard_run();


CREATE TABLE publication_taxonomy_assertions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL,
    taxonomy_release_id UUID NOT NULL,
    release_concept_id UUID NOT NULL,
    supersedes_assertion_id UUID
        REFERENCES publication_taxonomy_assertions(id) ON DELETE RESTRICT,
    assertion_status TEXT NOT NULL DEFAULT 'PROPOSED'
        CHECK (assertion_status IN (
            'PROPOSED', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'
        )),
    confidence NUMERIC(6,5)
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    decision_origin TEXT NOT NULL CHECK (btrim(decision_origin) <> ''),
    reason_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_taxonomy_assertion_run_concept
        UNIQUE (run_id, release_concept_id),
    CONSTRAINT uq_publication_taxonomy_assertion_release_identity
        UNIQUE (id, taxonomy_release_id),
    CONSTRAINT fk_publication_taxonomy_assertion_run_release
        FOREIGN KEY (run_id, taxonomy_release_id)
        REFERENCES publication_taxonomy_runs(id, taxonomy_release_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_publication_taxonomy_assertion_concept_release
        FOREIGN KEY (release_concept_id, taxonomy_release_id)
        REFERENCES taxonomy_release_concepts(id, release_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_publication_taxonomy_assertion_not_self_supersedes
        CHECK (
            supersedes_assertion_id IS NULL
            OR supersedes_assertion_id <> id
        )
);

CREATE INDEX ix_publication_taxonomy_assertions_run
ON publication_taxonomy_assertions(run_id);

CREATE INDEX ix_publication_taxonomy_assertions_release_concept
ON publication_taxonomy_assertions(release_concept_id, taxonomy_release_id);

CREATE INDEX ix_publication_taxonomy_assertions_supersedes
ON publication_taxonomy_assertions(supersedes_assertion_id)
WHERE supersedes_assertion_id IS NOT NULL;


CREATE OR REPLACE FUNCTION taxonomy_classification_assertion_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'publication taxonomy assertions are append-only';
END;
$$;

CREATE TRIGGER trg_publication_taxonomy_assertion_append_only
BEFORE UPDATE OR DELETE
ON publication_taxonomy_assertions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_assertion_append_only();


CREATE OR REPLACE FUNCTION taxonomy_classification_guard_assertion_supersession()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    new_version UUID;
    old_version UUID;
    old_release UUID;
    cursor_id UUID;
BEGIN
    IF NEW.supersedes_assertion_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT r.publication_version_id
    INTO new_version
    FROM publication_taxonomy_runs r
    WHERE r.id = NEW.run_id
      AND r.taxonomy_release_id = NEW.taxonomy_release_id;

    SELECT r.publication_version_id, a.taxonomy_release_id
    INTO old_version, old_release
    FROM publication_taxonomy_assertions a
    JOIN publication_taxonomy_runs r ON r.id = a.run_id
    WHERE a.id = NEW.supersedes_assertion_id;

    IF old_version IS NULL THEN
        RAISE EXCEPTION 'superseded assertion does not exist';
    END IF;

    IF old_version IS DISTINCT FROM new_version
       OR old_release IS DISTINCT FROM NEW.taxonomy_release_id THEN
        RAISE EXCEPTION
            'superseded assertion must use the same publication version and taxonomy release';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM publication_taxonomy_assertions successor
        WHERE successor.supersedes_assertion_id = NEW.supersedes_assertion_id
          AND successor.assertion_status IN ('PROPOSED', 'CONFIRMED')
    ) THEN
        RAISE EXCEPTION
            'assertion already has an active successor';
    END IF;

    cursor_id := NEW.supersedes_assertion_id;
    WHILE cursor_id IS NOT NULL LOOP
        IF cursor_id = NEW.id THEN
            RAISE EXCEPTION 'classification assertion supersession cycle detected';
        END IF;
        SELECT supersedes_assertion_id INTO cursor_id
        FROM publication_taxonomy_assertions
        WHERE id = cursor_id;
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_publication_taxonomy_assertion_supersession
BEFORE INSERT
ON publication_taxonomy_assertions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_guard_assertion_supersession();


CREATE TABLE publication_taxonomy_spans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assertion_id UUID NOT NULL
        REFERENCES publication_taxonomy_assertions(id) ON DELETE RESTRICT,
    span_start INTEGER CHECK (span_start IS NULL OR span_start >= 0),
    span_end INTEGER CHECK (span_end IS NULL OR span_end >= 0),
    excerpt TEXT,
    selector JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_fragment_hash CHAR(64)
        CHECK (
            source_fragment_hash IS NULL
            OR source_fragment_hash ~ '^[a-f0-9]{64}$'
        ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_publication_taxonomy_span_range
        CHECK (
            (span_start IS NULL AND span_end IS NULL)
            OR (
                span_start IS NOT NULL
                AND span_end IS NOT NULL
                AND span_end > span_start
            )
        ),
    CONSTRAINT chk_publication_taxonomy_span_selector
        CHECK (jsonb_typeof(selector) = 'object'),
    CONSTRAINT chk_publication_taxonomy_span_evidence
        CHECK (
            (excerpt IS NOT NULL AND btrim(excerpt) <> '')
            OR selector <> '{}'::jsonb
        )
);

CREATE INDEX ix_publication_taxonomy_spans_assertion
ON publication_taxonomy_spans(assertion_id);


CREATE TABLE publication_taxonomy_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assertion_id UUID NOT NULL
        REFERENCES publication_taxonomy_assertions(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('CONFIRM', 'REJECT')),
    reviewer_actor_id TEXT NOT NULL CHECK (btrim(reviewer_actor_id) <> ''),
    rationale TEXT NOT NULL CHECK (btrim(rationale) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_publication_taxonomy_reviews_assertion_created
ON publication_taxonomy_reviews(assertion_id, created_at DESC, id DESC);


CREATE OR REPLACE FUNCTION taxonomy_classification_append_only_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_publication_taxonomy_span_append_only
BEFORE UPDATE OR DELETE
ON publication_taxonomy_spans
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_append_only_record();

CREATE TRIGGER trg_publication_taxonomy_review_append_only
BEFORE UPDATE OR DELETE
ON publication_taxonomy_reviews
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_append_only_record();


CREATE VIEW v_publication_taxonomy_effective_assertions AS
WITH assertion_state AS (
    SELECT
        a.id,
        a.run_id,
        a.taxonomy_release_id,
        a.release_concept_id,
        a.supersedes_assertion_id,
        a.assertion_status,
        a.confidence,
        a.decision_origin,
        a.reason_code,
        a.created_at,
        r.publication_version_id,
        (
            SELECT review.decision
            FROM publication_taxonomy_reviews review
            WHERE review.assertion_id = a.id
            ORDER BY review.created_at DESC, review.id DESC
            LIMIT 1
        ) AS latest_review_decision
    FROM publication_taxonomy_assertions a
    JOIN publication_taxonomy_runs r ON r.id = a.run_id
    WHERE r.status IN ('SUCCESS', 'PARTIAL')
),
eligible AS (
    SELECT *
    FROM assertion_state
    WHERE latest_review_decision IS DISTINCT FROM 'REJECT'
      AND (
          assertion_status = 'CONFIRMED'
          OR latest_review_decision = 'CONFIRM'
      )
),
superseded AS (
    SELECT DISTINCT supersedes_assertion_id AS id
    FROM eligible
    WHERE supersedes_assertion_id IS NOT NULL
)
SELECT
    e.id AS assertion_id,
    e.run_id,
    e.publication_version_id,
    e.taxonomy_release_id,
    e.release_concept_id,
    e.assertion_status,
    e.confidence,
    e.decision_origin,
    e.reason_code,
    e.created_at
FROM eligible e
WHERE NOT EXISTS (
    SELECT 1 FROM superseded s WHERE s.id = e.id
);


REVOKE ALL ON
    publication_taxonomy_runs,
    publication_taxonomy_assertions,
    publication_taxonomy_spans,
    publication_taxonomy_reviews
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

REVOKE ALL ON v_publication_taxonomy_effective_assertions
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON
    publication_taxonomy_runs,
    publication_taxonomy_assertions,
    publication_taxonomy_spans,
    publication_taxonomy_reviews,
    v_publication_taxonomy_effective_assertions
TO radar_app;

GRANT SELECT ON
    publication_taxonomy_runs,
    publication_taxonomy_assertions,
    publication_taxonomy_spans,
    v_publication_taxonomy_effective_assertions
TO radar_worker;

GRANT INSERT ON
    publication_taxonomy_runs,
    publication_taxonomy_assertions,
    publication_taxonomy_spans
TO radar_worker;

GRANT UPDATE (
    status,
    started_at,
    finished_at,
    error_code,
    error_message,
    lifecycle_metadata
)
ON publication_taxonomy_runs
TO radar_worker;

GRANT SELECT ON
    publication_taxonomy_runs,
    publication_taxonomy_assertions,
    publication_taxonomy_spans,
    publication_taxonomy_reviews,
    v_publication_taxonomy_effective_assertions
TO radar_taxonomy_curator;

GRANT INSERT ON publication_taxonomy_reviews
TO radar_taxonomy_curator;

REVOKE ALL ON FUNCTION taxonomy_classification_guard_run()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_classification_assertion_append_only()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_classification_guard_assertion_supersession()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_classification_append_only_record()
FROM PUBLIC;
