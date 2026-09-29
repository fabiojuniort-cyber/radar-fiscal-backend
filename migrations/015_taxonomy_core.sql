-- TAX-05 / 015
-- Core global taxonomy meta-model. No tenant-scoped data and no baseline seed.

CREATE TABLE taxonomy_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_major INTEGER NOT NULL CHECK (version_major >= 0),
    version_minor INTEGER NOT NULL CHECK (version_minor >= 0),
    version_patch INTEGER NOT NULL CHECK (version_patch >= 0),
    version TEXT GENERATED ALWAYS AS (
        'v' || version_major::text || '.' ||
        version_minor::text || '.' ||
        version_patch::text
    ) STORED,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN (
            'DRAFT',
            'IN_REVIEW',
            'APPROVED',
            'PUBLISHED',
            'WITHDRAWN'
        )),
    previous_release_id UUID
        REFERENCES taxonomy_releases(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    withdrawn_by_actor TEXT,
    withdrawal_reason TEXT,
    artifact_repository TEXT,
    artifact_path TEXT,
    artifact_git_sha TEXT
        CHECK (
            artifact_git_sha IS NULL OR
            artifact_git_sha ~ '^[a-f0-9]{40}$'
        ),
    artifact_sha256 TEXT
        CHECK (
            artifact_sha256 IS NULL OR
            artifact_sha256 ~ '^[a-f0-9]{64}$'
        ),
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    change_notes TEXT,
    created_by_actor TEXT NOT NULL,
    CONSTRAINT uq_taxonomy_release_semver
        UNIQUE (version_major, version_minor, version_patch),
    CONSTRAINT uq_taxonomy_release_version
        UNIQUE (version),
    CONSTRAINT chk_taxonomy_release_not_self_previous
        CHECK (previous_release_id IS NULL OR previous_release_id <> id),
    CONSTRAINT chk_taxonomy_release_approved_at
        CHECK (
            status NOT IN ('APPROVED', 'PUBLISHED', 'WITHDRAWN')
            OR approved_at IS NOT NULL
        ),
    CONSTRAINT chk_taxonomy_release_published_fields
        CHECK (
            status NOT IN ('PUBLISHED', 'WITHDRAWN')
            OR (
                approved_at IS NOT NULL
                AND published_at IS NOT NULL
                AND artifact_repository IS NOT NULL
                AND btrim(artifact_repository) <> ''
                AND artifact_path IS NOT NULL
                AND btrim(artifact_path) <> ''
                AND artifact_git_sha IS NOT NULL
                AND artifact_sha256 IS NOT NULL
            )
        ),
    CONSTRAINT chk_taxonomy_release_withdrawn_fields
        CHECK (
            status <> 'WITHDRAWN'
            OR (
                withdrawn_at IS NOT NULL
                AND withdrawn_by_actor IS NOT NULL
                AND btrim(withdrawn_by_actor) <> ''
                AND withdrawal_reason IS NOT NULL
                AND btrim(withdrawal_reason) <> ''
            )
        )
);

CREATE INDEX ix_taxonomy_releases_status_version
ON taxonomy_releases(status, version_major DESC, version_minor DESC, version_patch DESC);

CREATE INDEX ix_taxonomy_releases_previous
ON taxonomy_releases(previous_release_id);


CREATE TABLE taxonomy_dimensions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE
        CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    identity_status TEXT NOT NULL DEFAULT 'CURRENT'
        CHECK (identity_status IN ('CURRENT', 'DEPRECATED', 'RETIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at TIMESTAMPTZ,
    CONSTRAINT chk_taxonomy_dimension_retirement
        CHECK (
            (identity_status = 'RETIRED' AND retired_at IS NOT NULL)
            OR identity_status <> 'RETIRED'
        )
);


CREATE TABLE taxonomy_dimension_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dimension_id UUID NOT NULL
        REFERENCES taxonomy_dimensions(id),
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    description TEXT,
    governance_status TEXT NOT NULL DEFAULT 'PROPOSED'
        CHECK (governance_status IN (
            'PROPOSED',
            'UNDER_REVIEW',
            'APPROVED',
            'DEPRECATED',
            'REJECTED'
        )),
    constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_dimension_revision_no
        UNIQUE (dimension_id, revision_no),
    CONSTRAINT uq_taxonomy_dimension_revision_identity
        UNIQUE (id, dimension_id)
);

CREATE INDEX ix_taxonomy_dimension_revisions_dimension
ON taxonomy_dimension_revisions(dimension_id, revision_no DESC);


CREATE TABLE taxonomy_release_dimensions (
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    dimension_id UUID NOT NULL
        REFERENCES taxonomy_dimensions(id),
    dimension_revision_id UUID NOT NULL,
    membership_status TEXT NOT NULL DEFAULT 'INCLUDED'
        CHECK (membership_status IN ('INCLUDED', 'DEPRECATED', 'RETIRED')),
    PRIMARY KEY (release_id, dimension_id),
    CONSTRAINT fk_taxonomy_release_dimension_revision
        FOREIGN KEY (dimension_revision_id, dimension_id)
        REFERENCES taxonomy_dimension_revisions(id, dimension_id)
);

CREATE INDEX ix_taxonomy_release_dimensions_revision
ON taxonomy_release_dimensions(dimension_revision_id);


CREATE TABLE taxonomy_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE
        CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
    dimension_id UUID NOT NULL
        REFERENCES taxonomy_dimensions(id),
    identity_status TEXT NOT NULL DEFAULT 'CURRENT'
        CHECK (identity_status IN ('CURRENT', 'DEPRECATED', 'RETIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at TIMESTAMPTZ,
    CONSTRAINT chk_taxonomy_concept_retirement
        CHECK (
            (identity_status = 'RETIRED' AND retired_at IS NOT NULL)
            OR identity_status <> 'RETIRED'
        )
);

CREATE INDEX ix_taxonomy_concepts_dimension
ON taxonomy_concepts(dimension_id);


CREATE TABLE taxonomy_concept_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id UUID NOT NULL
        REFERENCES taxonomy_concepts(id),
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    label TEXT NOT NULL CHECK (btrim(label) <> ''),
    definition TEXT NOT NULL CHECK (btrim(definition) <> ''),
    positive_example TEXT,
    negative_example TEXT,
    governance_status TEXT NOT NULL DEFAULT 'PROPOSED'
        CHECK (governance_status IN (
            'PROPOSED',
            'UNDER_REVIEW',
            'APPROVED',
            'DEPRECATED',
            'REJECTED'
        )),
    evidence_status TEXT NOT NULL DEFAULT 'NOT_ASSESSED'
        CHECK (evidence_status IN (
            'DOCUMENTED',
            'NEEDS_EVIDENCE',
            'NOT_ASSESSED'
        )),
    notes TEXT,
    source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_concept_revision_no
        UNIQUE (concept_id, revision_no),
    CONSTRAINT uq_taxonomy_concept_revision_identity
        UNIQUE (id, concept_id)
);

CREATE INDEX ix_taxonomy_concept_revisions_concept
ON taxonomy_concept_revisions(concept_id, revision_no DESC);


CREATE TABLE taxonomy_release_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    concept_id UUID NOT NULL
        REFERENCES taxonomy_concepts(id),
    concept_revision_id UUID NOT NULL,
    membership_status TEXT NOT NULL DEFAULT 'INCLUDED'
        CHECK (membership_status IN ('INCLUDED', 'DEPRECATED', 'RETIRED')),
    release_notes TEXT,
    CONSTRAINT uq_taxonomy_release_concept
        UNIQUE (release_id, concept_id),
    CONSTRAINT uq_taxonomy_release_concept_identity
        UNIQUE (id, release_id),
    CONSTRAINT fk_taxonomy_release_concept_revision
        FOREIGN KEY (concept_revision_id, concept_id)
        REFERENCES taxonomy_concept_revisions(id, concept_id)
);

CREATE INDEX ix_taxonomy_release_concepts_release_status
ON taxonomy_release_concepts(release_id, membership_status);

CREATE INDEX ix_taxonomy_release_concepts_concept
ON taxonomy_release_concepts(concept_id);


CREATE OR REPLACE FUNCTION taxonomy_check_release_ancestry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cycle_found BOOLEAN;
BEGIN
    IF NEW.previous_release_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.previous_release_id = NEW.id THEN
        RAISE EXCEPTION 'taxonomy release cannot reference itself as previous release';
    END IF;

    WITH RECURSIVE ancestors(id, previous_release_id) AS (
        SELECT r.id, r.previous_release_id
        FROM taxonomy_releases r
        WHERE r.id = NEW.previous_release_id

        UNION ALL

        SELECT r.id, r.previous_release_id
        FROM taxonomy_releases r
        JOIN ancestors a
          ON r.id = a.previous_release_id
    )
    SELECT EXISTS (
        SELECT 1
        FROM ancestors
        WHERE id = NEW.id
    )
    INTO cycle_found;

    IF cycle_found THEN
        RAISE EXCEPTION 'taxonomy release ancestry cycle detected';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_release_ancestry
BEFORE INSERT OR UPDATE OF previous_release_id
ON taxonomy_releases
FOR EACH ROW
EXECUTE FUNCTION taxonomy_check_release_ancestry();


CREATE OR REPLACE FUNCTION taxonomy_guard_release_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'taxonomy releases are historical and cannot be deleted';
    END IF;

    IF OLD.status = 'WITHDRAWN' THEN
        RAISE EXCEPTION 'withdrawn taxonomy release is immutable';
    END IF;

    IF NEW.status = 'WITHDRAWN'
       AND OLD.status <> 'PUBLISHED' THEN
        RAISE EXCEPTION 'only a published taxonomy release may be withdrawn';
    END IF;

    IF OLD.status = 'PUBLISHED' THEN
        IF NEW.status <> 'WITHDRAWN' THEN
            RAISE EXCEPTION 'published taxonomy release only allows PUBLISHED -> WITHDRAWN';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.version_major IS DISTINCT FROM OLD.version_major
           OR NEW.version_minor IS DISTINCT FROM OLD.version_minor
           OR NEW.version_patch IS DISTINCT FROM OLD.version_patch
           OR NEW.previous_release_id IS DISTINCT FROM OLD.previous_release_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.artifact_repository IS DISTINCT FROM OLD.artifact_repository
           OR NEW.artifact_path IS DISTINCT FROM OLD.artifact_path
           OR NEW.artifact_git_sha IS DISTINCT FROM OLD.artifact_git_sha
           OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
           OR NEW.manifest IS DISTINCT FROM OLD.manifest
           OR NEW.change_notes IS DISTINCT FROM OLD.change_notes
           OR NEW.created_by_actor IS DISTINCT FROM OLD.created_by_actor THEN
            RAISE EXCEPTION 'published taxonomy release semantic snapshot is immutable';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_release_lifecycle
BEFORE UPDATE OR DELETE
ON taxonomy_releases
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_lifecycle();


CREATE OR REPLACE FUNCTION taxonomy_guard_dimension_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'taxonomy dimension code is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_dimension_identity
BEFORE UPDATE OF code
ON taxonomy_dimensions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_dimension_identity();


CREATE OR REPLACE FUNCTION taxonomy_guard_concept_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'taxonomy concept code is immutable';
    END IF;

    IF NEW.dimension_id IS DISTINCT FROM OLD.dimension_id THEN
        RAISE EXCEPTION 'taxonomy concept dimension is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_concept_identity
BEFORE UPDATE OF code, dimension_id
ON taxonomy_concepts
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_concept_identity();


CREATE OR REPLACE FUNCTION taxonomy_revision_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_taxonomy_dimension_revision_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_dimension_revisions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_revision_append_only();

CREATE TRIGGER trg_taxonomy_concept_revision_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_concept_revisions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_revision_append_only();


CREATE OR REPLACE FUNCTION taxonomy_guard_release_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_status TEXT;
    new_status TEXT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT status
        INTO old_status
        FROM taxonomy_releases
        WHERE id = OLD.release_id;

        IF old_status IN ('PUBLISHED', 'WITHDRAWN') THEN
            RAISE EXCEPTION 'published/withdrawn taxonomy release snapshot is immutable';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT status
        INTO new_status
        FROM taxonomy_releases
        WHERE id = NEW.release_id;

        IF new_status IN ('PUBLISHED', 'WITHDRAWN') THEN
            RAISE EXCEPTION 'published/withdrawn taxonomy release snapshot is immutable';
        END IF;
    END IF;

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_taxonomy_release_dimensions_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_dimensions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();

CREATE TRIGGER trg_taxonomy_release_concepts_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_concepts
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();


CREATE OR REPLACE FUNCTION taxonomy_check_concept_dimension_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    concept_dimension_id UUID;
BEGIN
    SELECT dimension_id
    INTO concept_dimension_id
    FROM taxonomy_concepts
    WHERE id = NEW.concept_id;

    IF concept_dimension_id IS NULL THEN
        RAISE EXCEPTION 'taxonomy concept % does not exist', NEW.concept_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM taxonomy_release_dimensions rd
        WHERE rd.release_id = NEW.release_id
          AND rd.dimension_id = concept_dimension_id
    ) THEN
        RAISE EXCEPTION
            'taxonomy concept dimension must belong to the same release';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_release_concept_dimension
BEFORE INSERT OR UPDATE OF release_id, concept_id
ON taxonomy_release_concepts
FOR EACH ROW
EXECUTE FUNCTION taxonomy_check_concept_dimension_membership();


REVOKE ALL ON
    taxonomy_releases,
    taxonomy_dimensions,
    taxonomy_dimension_revisions,
    taxonomy_release_dimensions,
    taxonomy_concepts,
    taxonomy_concept_revisions,
    taxonomy_release_concepts
FROM PUBLIC;

REVOKE ALL ON FUNCTION taxonomy_check_release_ancestry()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_release_lifecycle()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_dimension_identity()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_concept_identity()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_revision_append_only()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_release_membership()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_check_concept_dimension_membership()
FROM PUBLIC;
