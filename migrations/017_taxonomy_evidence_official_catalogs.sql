-- TAX-05 / 017
-- Normalized evidence and versioned official catalogs. No canonical taxonomy seed.

CREATE TABLE taxonomy_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    basis_type TEXT NOT NULL
        CHECK (basis_type IN ('OFFICIAL', 'TRIBUSCA', 'HYBRID')),
    maintainer TEXT,
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
    document_title TEXT,
    act_type TEXT,
    act_number TEXT,
    edition TEXT,
    published_on DATE,
    consulted_at TIMESTAMPTZ,
    valid_from DATE,
    valid_to DATE,
    official_url TEXT,
    locator TEXT,
    excerpt TEXT,
    artifact_sha256 TEXT
        CHECK (
            artifact_sha256 IS NULL OR
            artifact_sha256 ~ '^[a-f0-9]{64}$'
        ),
    interpretation_note TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_taxonomy_evidence_validity
        CHECK (
            valid_to IS NULL OR
            valid_from IS NULL OR
            valid_to >= valid_from
        )
);

CREATE INDEX ix_taxonomy_evidence_maintainer
ON taxonomy_evidence(maintainer);

CREATE INDEX ix_taxonomy_evidence_act
ON taxonomy_evidence(act_type, act_number);

CREATE INDEX ix_taxonomy_evidence_official_url
ON taxonomy_evidence(official_url)
WHERE official_url IS NOT NULL;

CREATE INDEX ix_taxonomy_evidence_artifact_sha256
ON taxonomy_evidence(artifact_sha256)
WHERE artifact_sha256 IS NOT NULL;


CREATE TABLE taxonomy_concept_revision_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_revision_id UUID NOT NULL
        REFERENCES taxonomy_concept_revisions(id),
    evidence_id UUID NOT NULL
        REFERENCES taxonomy_evidence(id),
    role TEXT NOT NULL
        CHECK (role IN (
            'PRIMARY',
            'SUPPORTING',
            'LIMITATION',
            'COUNTEREXAMPLE'
        )),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_concept_revision_evidence
        UNIQUE (concept_revision_id, evidence_id, role)
);

CREATE INDEX ix_taxonomy_concept_revision_evidence_evidence
ON taxonomy_concept_revision_evidence(evidence_id);


CREATE TABLE taxonomy_alias_binding_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_binding_id UUID NOT NULL
        REFERENCES taxonomy_release_alias_bindings(id),
    evidence_id UUID NOT NULL
        REFERENCES taxonomy_evidence(id),
    role TEXT NOT NULL
        CHECK (role IN (
            'PRIMARY',
            'SUPPORTING',
            'LIMITATION',
            'COUNTEREXAMPLE'
        )),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_alias_binding_evidence
        UNIQUE (alias_binding_id, evidence_id, role)
);

CREATE INDEX ix_taxonomy_alias_binding_evidence_evidence
ON taxonomy_alias_binding_evidence(evidence_id);


CREATE TABLE taxonomy_relation_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relation_id UUID NOT NULL
        REFERENCES taxonomy_concept_relations(id),
    evidence_id UUID NOT NULL
        REFERENCES taxonomy_evidence(id),
    role TEXT NOT NULL
        CHECK (role IN (
            'PRIMARY',
            'SUPPORTING',
            'LIMITATION',
            'COUNTEREXAMPLE'
        )),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_relation_evidence
        UNIQUE (relation_id, evidence_id, role)
);

CREATE INDEX ix_taxonomy_relation_evidence_evidence
ON taxonomy_relation_evidence(evidence_id);


CREATE TABLE official_catalogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE
        CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    maintainer TEXT NOT NULL CHECK (btrim(maintainer) <> ''),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE official_catalog_editions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_id UUID NOT NULL
        REFERENCES official_catalogs(id),
    edition_code TEXT NOT NULL CHECK (btrim(edition_code) <> ''),
    published_on DATE,
    valid_from DATE,
    valid_to DATE,
    source_url TEXT,
    source_sha256 TEXT
        CHECK (
            source_sha256 IS NULL OR
            source_sha256 ~ '^[a-f0-9]{64}$'
        ),
    status TEXT NOT NULL DEFAULT 'CURRENT'
        CHECK (status IN ('CURRENT', 'SUPERSEDED', 'WITHDRAWN')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_official_catalog_edition
        UNIQUE (catalog_id, edition_code),
    CONSTRAINT chk_official_catalog_edition_validity
        CHECK (
            valid_to IS NULL OR
            valid_from IS NULL OR
            valid_to >= valid_from
        )
);

CREATE INDEX ix_official_catalog_editions_catalog
ON official_catalog_editions(catalog_id, valid_from DESC NULLS LAST);


CREATE TABLE official_catalog_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog_edition_id UUID NOT NULL
        REFERENCES official_catalog_editions(id),
    official_code TEXT NOT NULL CHECK (btrim(official_code) <> ''),
    description TEXT NOT NULL CHECK (btrim(description) <> ''),
    parent_entry_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_official_catalog_entry_code
        UNIQUE (catalog_edition_id, official_code),
    CONSTRAINT uq_official_catalog_entry_identity
        UNIQUE (id, catalog_edition_id),
    CONSTRAINT fk_official_catalog_entry_parent_same_edition
        FOREIGN KEY (parent_entry_id, catalog_edition_id)
        REFERENCES official_catalog_entries(id, catalog_edition_id),
    CONSTRAINT chk_official_catalog_entry_not_self_parent
        CHECK (parent_entry_id IS NULL OR parent_entry_id <> id)
);

CREATE INDEX ix_official_catalog_entries_parent
ON official_catalog_entries(catalog_edition_id, parent_entry_id)
WHERE parent_entry_id IS NOT NULL;


CREATE TABLE taxonomy_official_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    release_concept_id UUID NOT NULL,
    official_catalog_entry_id UUID NOT NULL
        REFERENCES official_catalog_entries(id),
    mapping_type TEXT NOT NULL
        CHECK (mapping_type IN (
            'EXACT',
            'CONCEPT_BROADER_THAN_ENTRY',
            'CONCEPT_NARROWER_THAN_ENTRY',
            'OVERLAP'
        )),
    valid_from DATE,
    valid_to DATE,
    justification TEXT,
    evidence_status TEXT NOT NULL DEFAULT 'NOT_ASSESSED'
        CHECK (evidence_status IN (
            'DOCUMENTED',
            'NEEDS_EVIDENCE',
            'NOT_ASSESSED'
        )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_taxonomy_official_mapping_same_release
        FOREIGN KEY (release_concept_id, release_id)
        REFERENCES taxonomy_release_concepts(id, release_id),
    CONSTRAINT uq_taxonomy_official_mapping
        UNIQUE (
            release_id,
            release_concept_id,
            official_catalog_entry_id,
            mapping_type
        ),
    CONSTRAINT chk_taxonomy_official_mapping_validity
        CHECK (
            valid_to IS NULL OR
            valid_from IS NULL OR
            valid_to >= valid_from
        )
);

CREATE INDEX ix_taxonomy_official_mappings_concept
ON taxonomy_official_mappings(release_id, release_concept_id);

CREATE INDEX ix_taxonomy_official_mappings_entry
ON taxonomy_official_mappings(official_catalog_entry_id);


CREATE TABLE taxonomy_official_mapping_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    official_mapping_id UUID NOT NULL
        REFERENCES taxonomy_official_mappings(id),
    evidence_id UUID NOT NULL
        REFERENCES taxonomy_evidence(id),
    role TEXT NOT NULL
        CHECK (role IN (
            'PRIMARY',
            'SUPPORTING',
            'LIMITATION',
            'COUNTEREXAMPLE'
        )),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_official_mapping_evidence
        UNIQUE (official_mapping_id, evidence_id, role)
);

CREATE INDEX ix_taxonomy_official_mapping_evidence_evidence
ON taxonomy_official_mapping_evidence(evidence_id);


CREATE OR REPLACE FUNCTION taxonomy_append_only_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_taxonomy_evidence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();

CREATE TRIGGER trg_taxonomy_concept_revision_evidence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_concept_revision_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();

CREATE TRIGGER trg_taxonomy_alias_binding_evidence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_alias_binding_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();

CREATE TRIGGER trg_taxonomy_relation_evidence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_relation_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();

CREATE TRIGGER trg_taxonomy_official_mapping_evidence_append_only
BEFORE UPDATE OR DELETE
ON taxonomy_official_mapping_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();


CREATE OR REPLACE FUNCTION taxonomy_guard_concept_revision_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM taxonomy_release_concepts rc
        JOIN taxonomy_releases r
          ON r.id = rc.release_id
        WHERE rc.concept_revision_id = NEW.concept_revision_id
          AND r.status IN ('PUBLISHED', 'WITHDRAWN')
    ) THEN
        RAISE EXCEPTION
            'cannot add evidence to a concept revision used by a published/withdrawn release';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_concept_revision_evidence_release_guard
BEFORE INSERT
ON taxonomy_concept_revision_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_concept_revision_evidence_insert();


CREATE OR REPLACE FUNCTION taxonomy_guard_alias_binding_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM taxonomy_release_alias_bindings b
        JOIN taxonomy_releases r
          ON r.id = b.release_id
        WHERE b.id = NEW.alias_binding_id
          AND r.status IN ('PUBLISHED', 'WITHDRAWN')
    ) THEN
        RAISE EXCEPTION
            'cannot add evidence to binding in a published/withdrawn release';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_alias_binding_evidence_release_guard
BEFORE INSERT
ON taxonomy_alias_binding_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_alias_binding_evidence_insert();


CREATE OR REPLACE FUNCTION taxonomy_guard_relation_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM taxonomy_concept_relations cr
        JOIN taxonomy_releases r
          ON r.id = cr.release_id
        WHERE cr.id = NEW.relation_id
          AND r.status IN ('PUBLISHED', 'WITHDRAWN')
    ) THEN
        RAISE EXCEPTION
            'cannot add evidence to relation in a published/withdrawn release';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_relation_evidence_release_guard
BEFORE INSERT
ON taxonomy_relation_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_relation_evidence_insert();


CREATE OR REPLACE FUNCTION taxonomy_guard_mapping_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM taxonomy_official_mappings m
        JOIN taxonomy_releases r
          ON r.id = m.release_id
        WHERE m.id = NEW.official_mapping_id
          AND r.status IN ('PUBLISHED', 'WITHDRAWN')
    ) THEN
        RAISE EXCEPTION
            'cannot add evidence to mapping in a published/withdrawn release';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_taxonomy_mapping_evidence_release_guard
BEFORE INSERT
ON taxonomy_official_mapping_evidence
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_mapping_evidence_insert();


CREATE TRIGGER trg_taxonomy_official_mapping_release_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_official_mappings
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();


CREATE OR REPLACE FUNCTION taxonomy_guard_catalog_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'official catalog code is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_official_catalog_code
BEFORE UPDATE OF code
ON official_catalogs
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_catalog_code();

CREATE TRIGGER trg_official_catalog_edition_append_only
BEFORE UPDATE OR DELETE
ON official_catalog_editions
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();

CREATE TRIGGER trg_official_catalog_entry_append_only
BEFORE UPDATE OR DELETE
ON official_catalog_entries
FOR EACH ROW
EXECUTE FUNCTION taxonomy_append_only_record();


REVOKE ALL ON
    taxonomy_evidence,
    taxonomy_concept_revision_evidence,
    taxonomy_alias_binding_evidence,
    taxonomy_relation_evidence,
    official_catalogs,
    official_catalog_editions,
    official_catalog_entries,
    taxonomy_official_mappings,
    taxonomy_official_mapping_evidence
FROM PUBLIC;

REVOKE ALL ON FUNCTION taxonomy_append_only_record()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_concept_revision_evidence_insert()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_alias_binding_evidence_insert()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_relation_evidence_insert()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_mapping_evidence_insert()
FROM PUBLIC;
REVOKE ALL ON FUNCTION taxonomy_guard_catalog_code()
FROM PUBLIC;
