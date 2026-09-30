-- TAX-08 / 021
-- Global UNMAPPED occurrences and governed semantic candidates.
-- No tenant-scoped data belongs in this layer.

CREATE TABLE taxonomy_unmapped_occurrences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL
        REFERENCES publication_taxonomy_runs(id) ON DELETE RESTRICT,
    raw_term TEXT NOT NULL CHECK (btrim(raw_term) <> ''),
    normalized_term TEXT NOT NULL CHECK (btrim(normalized_term) <> ''),
    language TEXT NOT NULL DEFAULT 'pt-BR'
        CHECK (btrim(language) <> ''),
    probable_dimension_id UUID
        REFERENCES taxonomy_dimensions(id) ON DELETE RESTRICT,
    context_excerpt TEXT,
    span_start INTEGER CHECK (span_start IS NULL OR span_start >= 0),
    span_end INTEGER CHECK (span_end IS NULL OR span_end >= 0),
    jurisdiction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(jurisdiction_metadata) = 'object'),
    extractor_key TEXT NOT NULL CHECK (btrim(extractor_key) <> ''),
    extractor_version TEXT NOT NULL CHECK (btrim(extractor_version) <> ''),
    confidence NUMERIC(6,5)
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    occurrence_fingerprint CHAR(64) NOT NULL
        CHECK (occurrence_fingerprint ~ '^[a-f0-9]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_unmapped_occurrence_fingerprint
        UNIQUE (occurrence_fingerprint),
    CONSTRAINT chk_taxonomy_unmapped_occurrence_span CHECK (
        (span_start IS NULL AND span_end IS NULL)
        OR (
            span_start IS NOT NULL
            AND span_end IS NOT NULL
            AND span_end > span_start
        )
    )
);

CREATE INDEX ix_taxonomy_unmapped_occurrences_run
ON taxonomy_unmapped_occurrences(run_id, observed_at);

CREATE INDEX ix_taxonomy_unmapped_occurrences_term
ON taxonomy_unmapped_occurrences(normalized_term, observed_at DESC);

CREATE INDEX ix_taxonomy_unmapped_occurrences_dimension
ON taxonomy_unmapped_occurrences(probable_dimension_id)
WHERE probable_dimension_id IS NOT NULL;


CREATE TABLE taxonomy_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    preferred_term TEXT NOT NULL CHECK (btrim(preferred_term) <> ''),
    normalized_key TEXT NOT NULL CHECK (btrim(normalized_key) <> ''),
    probable_dimension_id UUID
        REFERENCES taxonomy_dimensions(id) ON DELETE RESTRICT,
    context_signature CHAR(64) NOT NULL
        CHECK (context_signature ~ '^[a-f0-9]{64}$'),
    jurisdiction_scope JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(jurisdiction_scope) = 'object'),
    candidate_fingerprint CHAR(64) NOT NULL
        CHECK (candidate_fingerprint ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'NEW'
        CHECK (status IN (
            'NEW',
            'NEEDS_EVIDENCE',
            'UNDER_REVIEW',
            'MAPPED_TO_EXISTING',
            'APPROVED_ALIAS',
            'APPROVED_NEW_CONCEPT',
            'REJECTED',
            'SPLIT_REQUIRED'
        )),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decision_actor_id TEXT,
    decision_at TIMESTAMPTZ,
    decision_reason TEXT,
    resolved_release_concept_id UUID
        REFERENCES taxonomy_release_concepts(id) ON DELETE RESTRICT,
    parent_candidate_id UUID
        REFERENCES taxonomy_candidates(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_candidate_fingerprint
        UNIQUE (candidate_fingerprint),
    CONSTRAINT chk_taxonomy_candidate_parent_not_self
        CHECK (parent_candidate_id IS NULL OR parent_candidate_id <> id),
    CONSTRAINT chk_taxonomy_candidate_seen_order
        CHECK (last_seen_at >= first_seen_at),
    CONSTRAINT chk_taxonomy_candidate_terminal_decision CHECK (
        status NOT IN (
            'MAPPED_TO_EXISTING',
            'APPROVED_ALIAS',
            'APPROVED_NEW_CONCEPT',
            'REJECTED'
        )
        OR (
            decision_actor_id IS NOT NULL
            AND btrim(decision_actor_id) <> ''
            AND decision_at IS NOT NULL
            AND decision_reason IS NOT NULL
            AND btrim(decision_reason) <> ''
        )
    ),
    CONSTRAINT chk_taxonomy_candidate_existing_resolution CHECK (
        status NOT IN ('MAPPED_TO_EXISTING','APPROVED_ALIAS')
        OR resolved_release_concept_id IS NOT NULL
    )
);

CREATE INDEX ix_taxonomy_candidates_normalized
ON taxonomy_candidates(normalized_key, status);

CREATE INDEX ix_taxonomy_candidates_status
ON taxonomy_candidates(status, last_seen_at DESC);

CREATE INDEX ix_taxonomy_candidates_dimension
ON taxonomy_candidates(probable_dimension_id)
WHERE probable_dimension_id IS NOT NULL;

CREATE INDEX ix_taxonomy_candidates_parent
ON taxonomy_candidates(parent_candidate_id)
WHERE parent_candidate_id IS NOT NULL;


CREATE TABLE taxonomy_candidate_occurrence_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL
        REFERENCES taxonomy_candidates(id) ON DELETE RESTRICT,
    occurrence_id UUID NOT NULL
        REFERENCES taxonomy_unmapped_occurrences(id) ON DELETE RESTRICT,
    link_status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (link_status IN ('ACTIVE','SUPERSEDED')),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at TIMESTAMPTZ,
    justification TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_taxonomy_candidate_link_superseded CHECK (
        (link_status = 'ACTIVE' AND superseded_at IS NULL)
        OR (
            link_status = 'SUPERSEDED'
            AND superseded_at IS NOT NULL
            AND justification IS NOT NULL
            AND btrim(justification) <> ''
        )
    )
);

CREATE UNIQUE INDEX uq_taxonomy_candidate_active_occurrence
ON taxonomy_candidate_occurrence_links(occurrence_id)
WHERE link_status = 'ACTIVE';

CREATE INDEX ix_taxonomy_candidate_links_candidate
ON taxonomy_candidate_occurrence_links(candidate_id, linked_at DESC);


CREATE OR REPLACE FUNCTION taxonomy_unmapped_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_taxonomy_unmapped_occurrence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_unmapped_occurrences
FOR EACH ROW
EXECUTE FUNCTION taxonomy_unmapped_append_only();


CREATE OR REPLACE FUNCTION taxonomy_candidate_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cursor_id UUID;
    terminal_status BOOLEAN;
    worker_member BOOLEAN;
BEGIN
    terminal_status := NEW.status IN (
        'MAPPED_TO_EXISTING',
        'APPROVED_ALIAS',
        'APPROVED_NEW_CONCEPT',
        'REJECTED'
    );

    worker_member := pg_has_role(
        current_user,
        'radar_worker',
        'MEMBER'
    );

    IF TG_OP = 'INSERT' THEN
        IF worker_member
           AND current_user <> 'radar_taxonomy_curator'
           AND NEW.status NOT IN ('NEW','NEEDS_EVIDENCE') THEN
            RAISE EXCEPTION
                'worker may create only NEW/NEEDS_EVIDENCE taxonomy candidates';
        END IF;
    ELSE
        IF OLD.status IN (
            'MAPPED_TO_EXISTING',
            'APPROVED_ALIAS',
            'APPROVED_NEW_CONCEPT',
            'REJECTED'
        ) THEN
            RAISE EXCEPTION
                'terminal taxonomy candidate is immutable';
        END IF;

        IF NEW.normalized_key IS DISTINCT FROM OLD.normalized_key
           OR NEW.probable_dimension_id IS DISTINCT FROM OLD.probable_dimension_id
           OR NEW.context_signature IS DISTINCT FROM OLD.context_signature
           OR NEW.jurisdiction_scope IS DISTINCT FROM OLD.jurisdiction_scope
           OR NEW.candidate_fingerprint IS DISTINCT FROM OLD.candidate_fingerprint
           OR NEW.parent_candidate_id IS DISTINCT FROM OLD.parent_candidate_id
           OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION
                'taxonomy candidate grouping identity is immutable';
        END IF;

        NEW.updated_at := now();
    END IF;

    IF terminal_status
       AND current_user <> 'radar_taxonomy_curator' THEN
        RAISE EXCEPTION
            'terminal taxonomy candidate decision requires curator role';
    END IF;

    IF NEW.parent_candidate_id IS NOT NULL THEN
        cursor_id := NEW.parent_candidate_id;

        WHILE cursor_id IS NOT NULL LOOP
            IF cursor_id = NEW.id THEN
                RAISE EXCEPTION
                    'taxonomy candidate parent cycle detected';
            END IF;

            SELECT parent_candidate_id
            INTO cursor_id
            FROM taxonomy_candidates
            WHERE id = cursor_id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_candidate_guard
BEFORE INSERT OR UPDATE
ON taxonomy_candidates
FOR EACH ROW
EXECUTE FUNCTION taxonomy_candidate_guard();


CREATE OR REPLACE FUNCTION taxonomy_candidate_link_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'taxonomy candidate links are historical and cannot be deleted';
    END IF;

    IF OLD.link_status = 'SUPERSEDED' THEN
        RAISE EXCEPTION
            'superseded taxonomy candidate link is immutable';
    END IF;

    IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.occurrence_id IS DISTINCT FROM OLD.occurrence_id
       OR NEW.linked_at IS DISTINCT FROM OLD.linked_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
            'taxonomy candidate link identity is immutable';
    END IF;

    IF OLD.link_status = 'ACTIVE'
       AND NEW.link_status <> 'SUPERSEDED' THEN
        RAISE EXCEPTION
            'active taxonomy candidate link only allows supersession';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_candidate_link_guard
BEFORE UPDATE OR DELETE
ON taxonomy_candidate_occurrence_links
FOR EACH ROW
EXECUTE FUNCTION taxonomy_candidate_link_guard();


CREATE OR REPLACE FUNCTION taxonomy_candidate_touch_seen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    observed TIMESTAMPTZ;
BEGIN
    SELECT observed_at
    INTO observed
    FROM taxonomy_unmapped_occurrences
    WHERE id = NEW.occurrence_id;

    UPDATE taxonomy_candidates
    SET
        last_seen_at = GREATEST(last_seen_at, observed),
        updated_at = now()
    WHERE id = NEW.candidate_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_candidate_touch_seen
AFTER INSERT
ON taxonomy_candidate_occurrence_links
FOR EACH ROW
WHEN (NEW.link_status = 'ACTIVE')
EXECUTE FUNCTION taxonomy_candidate_touch_seen();


REVOKE ALL ON
    taxonomy_unmapped_occurrences,
    taxonomy_candidates,
    taxonomy_candidate_occurrence_links
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON
    taxonomy_unmapped_occurrences,
    taxonomy_candidates,
    taxonomy_candidate_occurrence_links
TO radar_app;

GRANT SELECT, INSERT ON
    taxonomy_unmapped_occurrences,
    taxonomy_candidates,
    taxonomy_candidate_occurrence_links
TO radar_worker;

GRANT SELECT, INSERT ON
    taxonomy_candidates,
    taxonomy_candidate_occurrence_links
TO radar_taxonomy_curator;

GRANT SELECT ON taxonomy_unmapped_occurrences
TO radar_taxonomy_curator;

GRANT UPDATE (
    status,
    decision_actor_id,
    decision_at,
    decision_reason,
    resolved_release_concept_id,
    preferred_term
)
ON taxonomy_candidates
TO radar_taxonomy_curator;

GRANT UPDATE (
    link_status,
    superseded_at,
    justification
)
ON taxonomy_candidate_occurrence_links
TO radar_taxonomy_curator;

REVOKE ALL ON FUNCTION taxonomy_unmapped_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_candidate_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_candidate_link_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_candidate_touch_seen() FROM PUBLIC;
