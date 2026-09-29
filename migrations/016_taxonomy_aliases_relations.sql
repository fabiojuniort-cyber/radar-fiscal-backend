-- TAX-05 / 016
-- Global taxonomy aliases and relation graph. No baseline seed.

CREATE TABLE taxonomy_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text TEXT NOT NULL CHECK (btrim(text) <> ''),
    normalized_text TEXT NOT NULL CHECK (btrim(normalized_text) <> ''),
    language TEXT NOT NULL DEFAULT 'pt-BR'
        CHECK (btrim(language) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_alias_lexeme
        UNIQUE (normalized_text, language)
);

CREATE TABLE taxonomy_release_alias_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    alias_id UUID NOT NULL
        REFERENCES taxonomy_aliases(id),
    release_concept_id UUID NOT NULL,
    alias_type TEXT NOT NULL
        CHECK (alias_type IN (
            'EXACT_LEXICAL',
            'ABBREVIATION',
            'HISTORICAL_LABEL',
            'SEARCH_RELATED',
            'AMBIGUOUS'
        )),
    decision_status TEXT NOT NULL DEFAULT 'APPROVED'
        CHECK (decision_status IN (
            'APPROVED',
            'REJECTED',
            'DEPRECATED'
        )),
    jurisdiction_level TEXT
        CHECK (
            jurisdiction_level IS NULL OR
            jurisdiction_level IN (
                'FEDERAL',
                'STATE',
                'MUNICIPAL',
                'NATIONAL',
                'OTHER'
            )
        ),
    uf TEXT
        CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
    municipality_ibge_code TEXT
        CHECK (
            municipality_ibge_code IS NULL OR
            municipality_ibge_code ~ '^[0-9]{7}$'
        ),
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    valid_from DATE,
    valid_to DATE,
    temporal_basis TEXT
        CHECK (
            temporal_basis IS NULL OR
            temporal_basis IN (
                'PUBLISHED_ON',
                'EFFECTIVE_ON',
                'EXTRACTED_NORM_DATE'
            )
        ),
    justification TEXT,
    evidence_status TEXT NOT NULL DEFAULT 'NOT_ASSESSED'
        CHECK (evidence_status IN (
            'DOCUMENTED',
            'NEEDS_EVIDENCE',
            'NOT_ASSESSED'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_taxonomy_alias_binding_release_concept
        FOREIGN KEY (release_concept_id, release_id)
        REFERENCES taxonomy_release_concepts(id, release_id),
    CONSTRAINT chk_taxonomy_alias_binding_validity
        CHECK (
            valid_to IS NULL OR
            valid_from IS NULL OR
            valid_to >= valid_from
        )
);

CREATE INDEX ix_taxonomy_alias_bindings_release_alias
ON taxonomy_release_alias_bindings(release_id, alias_id);

CREATE INDEX ix_taxonomy_alias_bindings_concept
ON taxonomy_release_alias_bindings(release_concept_id);


CREATE TABLE taxonomy_relation_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE
        CHECK (code ~ '^[a-z][a-z0-9_]*$'),
    inverse_code TEXT
        CHECK (
            inverse_code IS NULL OR
            inverse_code ~ '^[a-z][a-z0-9_]*$'
        ),
    directed BOOLEAN NOT NULL DEFAULT true,
    acyclic BOOLEAN NOT NULL DEFAULT false,
    hierarchical BOOLEAN NOT NULL DEFAULT false,
    canonical_storage_code TEXT NOT NULL
        CHECK (canonical_storage_code ~ '^[a-z][a-z0-9_]*$'),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_taxonomy_relation_types_family
ON taxonomy_relation_types(canonical_storage_code);


CREATE TABLE taxonomy_release_relation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    relation_type_id UUID NOT NULL
        REFERENCES taxonomy_relation_types(id),
    source_dimension_id UUID NOT NULL,
    target_dimension_id UUID NOT NULL,
    allowed BOOLEAN NOT NULL DEFAULT true,
    requires_evidence BOOLEAN NOT NULL DEFAULT false,
    acyclic_override BOOLEAN,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_taxonomy_relation_rule_source_dimension
        FOREIGN KEY (release_id, source_dimension_id)
        REFERENCES taxonomy_release_dimensions(release_id, dimension_id),
    CONSTRAINT fk_taxonomy_relation_rule_target_dimension
        FOREIGN KEY (release_id, target_dimension_id)
        REFERENCES taxonomy_release_dimensions(release_id, dimension_id),
    CONSTRAINT uq_taxonomy_relation_rule
        UNIQUE (
            release_id,
            relation_type_id,
            source_dimension_id,
            target_dimension_id
        )
);

CREATE INDEX ix_taxonomy_relation_rules_dimensions
ON taxonomy_release_relation_rules(
    release_id,
    source_dimension_id,
    target_dimension_id
);


CREATE TABLE taxonomy_concept_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    source_release_concept_id UUID NOT NULL,
    target_release_concept_id UUID NOT NULL,
    relation_type_id UUID NOT NULL
        REFERENCES taxonomy_relation_types(id),
    status TEXT NOT NULL DEFAULT 'APPROVED'
        CHECK (status IN ('PROPOSED', 'APPROVED', 'DEPRECATED', 'REJECTED')),
    valid_from DATE,
    valid_to DATE,
    qualifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
    justification TEXT,
    evidence_status TEXT NOT NULL DEFAULT 'NOT_ASSESSED'
        CHECK (evidence_status IN (
            'DOCUMENTED',
            'NEEDS_EVIDENCE',
            'NOT_ASSESSED'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_taxonomy_relation_source_same_release
        FOREIGN KEY (source_release_concept_id, release_id)
        REFERENCES taxonomy_release_concepts(id, release_id),
    CONSTRAINT fk_taxonomy_relation_target_same_release
        FOREIGN KEY (target_release_concept_id, release_id)
        REFERENCES taxonomy_release_concepts(id, release_id),
    CONSTRAINT chk_taxonomy_relation_no_self_loop
        CHECK (source_release_concept_id <> target_release_concept_id),
    CONSTRAINT chk_taxonomy_relation_validity
        CHECK (
            valid_to IS NULL OR
            valid_from IS NULL OR
            valid_to >= valid_from
        )
);

CREATE INDEX ix_taxonomy_relations_source
ON taxonomy_concept_relations(
    release_id,
    source_release_concept_id,
    relation_type_id
);

CREATE INDEX ix_taxonomy_relations_target
ON taxonomy_concept_relations(
    release_id,
    target_release_concept_id,
    relation_type_id
);

CREATE INDEX ix_taxonomy_relations_type
ON taxonomy_concept_relations(release_id, relation_type_id);


CREATE OR REPLACE FUNCTION taxonomy_guard_alias_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
    IF NEW.text IS DISTINCT FROM OLD.text
       OR NEW.normalized_text IS DISTINCT FROM OLD.normalized_text
       OR NEW.language IS DISTINCT FROM OLD.language THEN
        RAISE EXCEPTION 'taxonomy alias lexical identity is immutable';
    END IF;

    RETURN NEW;
END;
$;

CREATE TRIGGER trg_taxonomy_alias_identity
BEFORE UPDATE OF text, normalized_text, language
ON taxonomy_aliases
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_alias_identity();


CREATE OR REPLACE FUNCTION taxonomy_guard_relation_type_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code
       OR NEW.canonical_storage_code IS DISTINCT FROM OLD.canonical_storage_code THEN
        RAISE EXCEPTION 'taxonomy relation type identity is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_relation_type_identity
BEFORE UPDATE OF code, canonical_storage_code
ON taxonomy_relation_types
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_relation_type_identity();


CREATE OR REPLACE FUNCTION taxonomy_check_relation_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source_dimension UUID;
    target_dimension UUID;
BEGIN
    SELECT c.dimension_id
    INTO source_dimension
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c
      ON c.id = rc.concept_id
    WHERE rc.id = NEW.source_release_concept_id
      AND rc.release_id = NEW.release_id;

    SELECT c.dimension_id
    INTO target_dimension
    FROM taxonomy_release_concepts rc
    JOIN taxonomy_concepts c
      ON c.id = rc.concept_id
    WHERE rc.id = NEW.target_release_concept_id
      AND rc.release_id = NEW.release_id;

    IF source_dimension IS NULL OR target_dimension IS NULL THEN
        RAISE EXCEPTION 'taxonomy relation endpoints must belong to the release';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM taxonomy_release_relation_rules rr
        WHERE rr.release_id = NEW.release_id
          AND rr.relation_type_id = NEW.relation_type_id
          AND rr.source_dimension_id = source_dimension
          AND rr.target_dimension_id = target_dimension
          AND rr.allowed
    ) THEN
        RAISE EXCEPTION
            'taxonomy relation is not allowed for the source/target dimensions';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_relation_compatibility
BEFORE INSERT OR UPDATE OF
    release_id,
    source_release_concept_id,
    target_release_concept_id,
    relation_type_id
ON taxonomy_concept_relations
FOR EACH ROW
EXECUTE FUNCTION taxonomy_check_relation_compatibility();


CREATE OR REPLACE FUNCTION taxonomy_check_acyclic_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    relation_family TEXT;
    relation_is_acyclic BOOLEAN;
    release_override BOOLEAN;
    cycle_found BOOLEAN;
BEGIN
    SELECT
        rt.canonical_storage_code,
        rt.acyclic
    INTO
        relation_family,
        relation_is_acyclic
    FROM taxonomy_relation_types rt
    WHERE rt.id = NEW.relation_type_id;

    SELECT rr.acyclic_override
    INTO release_override
    FROM taxonomy_release_relation_rules rr
    JOIN taxonomy_release_concepts source_rc
      ON source_rc.id = NEW.source_release_concept_id
     AND source_rc.release_id = NEW.release_id
    JOIN taxonomy_concepts source_c
      ON source_c.id = source_rc.concept_id
    JOIN taxonomy_release_concepts target_rc
      ON target_rc.id = NEW.target_release_concept_id
     AND target_rc.release_id = NEW.release_id
    JOIN taxonomy_concepts target_c
      ON target_c.id = target_rc.concept_id
    WHERE rr.release_id = NEW.release_id
      AND rr.relation_type_id = NEW.relation_type_id
      AND rr.source_dimension_id = source_c.dimension_id
      AND rr.target_dimension_id = target_c.dimension_id;

    relation_is_acyclic :=
        COALESCE(release_override, relation_is_acyclic);

    IF NOT relation_is_acyclic THEN
        RETURN NEW;
    END IF;

    WITH RECURSIVE reachable(node_id) AS (
        SELECT NEW.target_release_concept_id

        UNION

        SELECT cr.target_release_concept_id
        FROM taxonomy_concept_relations cr
        JOIN taxonomy_relation_types rt
          ON rt.id = cr.relation_type_id
        JOIN reachable r
          ON cr.source_release_concept_id = r.node_id
        WHERE cr.release_id = NEW.release_id
          AND rt.canonical_storage_code = relation_family
    )
    SELECT EXISTS (
        SELECT 1
        FROM reachable
        WHERE node_id = NEW.source_release_concept_id
    )
    INTO cycle_found;

    IF cycle_found THEN
        RAISE EXCEPTION
            'taxonomy acyclic relation family % would form a cycle',
            relation_family;
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_taxonomy_relation_acyclic
AFTER INSERT OR UPDATE OF
    release_id,
    source_release_concept_id,
    target_release_concept_id,
    relation_type_id
ON taxonomy_concept_relations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION taxonomy_check_acyclic_relation();


CREATE TRIGGER trg_taxonomy_alias_binding_release_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_alias_bindings
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();

CREATE TRIGGER trg_taxonomy_relation_rule_release_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_relation_rules
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();

CREATE TRIGGER trg_taxonomy_concept_relation_release_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_concept_relations
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();


REVOKE ALL ON
    taxonomy_aliases,
    taxonomy_release_alias_bindings,
    taxonomy_relation_types,
    taxonomy_release_relation_rules,
    taxonomy_concept_relations
FROM PUBLIC;

REVOKE ALL ON FUNCTION taxonomy_guard_alias_identity()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_relation_type_identity()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_check_relation_compatibility()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_check_acyclic_relation()
FROM PUBLIC;
