-- TAX-05 / 018
-- Least-privilege access for the global taxonomy meta-model.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_roles
        WHERE rolname = 'radar_taxonomy_curator'
    ) THEN
        CREATE ROLE radar_taxonomy_curator
            NOLOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            NOBYPASSRLS;
    END IF;
END;
$$;

ALTER ROLE radar_taxonomy_curator
    NOLOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;

DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO radar_taxonomy_curator',
        current_database()
    );
END;
$$;

GRANT USAGE ON SCHEMA public
TO radar_taxonomy_curator;


-- Establish an exact baseline before granting the intended policy.
REVOKE ALL ON
    taxonomy_releases,
    taxonomy_dimensions,
    taxonomy_dimension_revisions,
    taxonomy_release_dimensions,
    taxonomy_concepts,
    taxonomy_concept_revisions,
    taxonomy_release_concepts,
    taxonomy_aliases,
    taxonomy_release_alias_bindings,
    taxonomy_relation_types,
    taxonomy_release_relation_rules,
    taxonomy_concept_relations,
    taxonomy_evidence,
    taxonomy_concept_revision_evidence,
    taxonomy_alias_binding_evidence,
    taxonomy_relation_evidence,
    official_catalogs,
    official_catalog_editions,
    official_catalog_entries,
    taxonomy_official_mappings,
    taxonomy_official_mapping_evidence
FROM radar_app, radar_worker, radar_taxonomy_curator;


-- Tenant-facing application and collection worker may read global taxonomy
-- metadata, but neither role may govern the canonical vocabulary.
GRANT SELECT ON
    taxonomy_releases,
    taxonomy_dimensions,
    taxonomy_dimension_revisions,
    taxonomy_release_dimensions,
    taxonomy_concepts,
    taxonomy_concept_revisions,
    taxonomy_release_concepts,
    taxonomy_aliases,
    taxonomy_release_alias_bindings,
    taxonomy_relation_types,
    taxonomy_release_relation_rules,
    taxonomy_concept_relations,
    taxonomy_evidence,
    taxonomy_concept_revision_evidence,
    taxonomy_alias_binding_evidence,
    taxonomy_relation_evidence,
    official_catalogs,
    official_catalog_editions,
    official_catalog_entries,
    taxonomy_official_mappings,
    taxonomy_official_mapping_evidence
TO radar_app, radar_worker;


-- Curator: identities may be created and retired, but canonical identity
-- columns are protected by triggers and no historical DELETE is granted.
GRANT SELECT, INSERT, UPDATE ON
    taxonomy_releases,
    taxonomy_dimensions,
    taxonomy_concepts
TO radar_taxonomy_curator;

-- Draft release memberships, bindings, rules, relations and mappings need
-- controlled DML before publication. Release guards freeze published history.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    taxonomy_release_dimensions,
    taxonomy_release_concepts,
    taxonomy_release_alias_bindings,
    taxonomy_release_relation_rules,
    taxonomy_concept_relations,
    taxonomy_official_mappings
TO radar_taxonomy_curator;

-- Append-only/identity reference records.
GRANT SELECT, INSERT ON
    taxonomy_dimension_revisions,
    taxonomy_concept_revisions,
    taxonomy_aliases,
    taxonomy_relation_types,
    taxonomy_evidence,
    taxonomy_concept_revision_evidence,
    taxonomy_alias_binding_evidence,
    taxonomy_relation_evidence,
    official_catalogs,
    official_catalog_editions,
    official_catalog_entries,
    taxonomy_official_mapping_evidence
TO radar_taxonomy_curator;


-- Global governance audit: reuse the existing RLS-protected audit_log.
GRANT SELECT, INSERT
ON audit_log
TO radar_taxonomy_curator;

CREATE POLICY audit_log_taxonomy_curator_select
ON audit_log
FOR SELECT
TO radar_taxonomy_curator
USING (tenant_id IS NULL);

CREATE POLICY audit_log_taxonomy_curator_insert
ON audit_log
FOR INSERT
TO radar_taxonomy_curator
WITH CHECK (
    tenant_id IS NULL
    AND actor_type IN ('ADMIN', 'SYSTEM')
);


-- The runtime logins are provisioned after db:migrate on fresh databases.
-- If they already exist, explicitly remove any curator membership.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'radar_app_runtime'
    ) THEN
        REVOKE radar_taxonomy_curator FROM radar_app_runtime;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'radar_worker_runtime'
    ) THEN
        REVOKE radar_taxonomy_curator FROM radar_worker_runtime;
    END IF;
END;
$$;
