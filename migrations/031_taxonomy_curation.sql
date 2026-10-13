-- TAX-11 / 031
-- Curadoria configurável da Taxonomia TriBusca.
--
-- Everything editable by the curator is release-scoped: a curator edits a
-- DRAFT release and publishes it explicitly. Published/withdrawn snapshots
-- stay immutable through the existing taxonomy_guard_release_membership()
-- trigger. Columns added here are NULL on releases created before TAX-11;
-- application code applies the legacy presentation defaults for them.

-- ---------------------------------------------------------------------------
-- 1. Platform-level roles (global, never tenant-scoped).
-- ---------------------------------------------------------------------------

CREATE TABLE platform_user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL
        REFERENCES app_users(id),
    role TEXT NOT NULL
        CHECK (role IN ('TAXONOMY_CURATOR')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by TEXT NOT NULL
        CHECK (btrim(granted_by) <> ''),
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    CONSTRAINT chk_platform_user_role_revocation
        CHECK (
            (revoked_at IS NULL AND revoked_by IS NULL)
            OR (
                revoked_at IS NOT NULL
                AND revoked_by IS NOT NULL
                AND btrim(revoked_by) <> ''
            )
        )
);

CREATE UNIQUE INDEX uq_platform_user_role_active
ON platform_user_roles(user_id, role)
WHERE revoked_at IS NULL;

ALTER TABLE platform_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_user_roles FORCE ROW LEVEL SECURITY;

REVOKE ALL ON platform_user_roles
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

-- The API only needs to know whether the authenticated user holds a role.
-- Grants and revocations are operational (admin connection) only.
GRANT SELECT ON platform_user_roles TO radar_app;

CREATE POLICY platform_user_roles_app_select_own
ON platform_user_roles
FOR SELECT
TO radar_app
USING (user_id = app_current_user_id());


-- ---------------------------------------------------------------------------
-- 2. Release-scoped groups (Segmento -> Grupo -> Item and similar).
-- ---------------------------------------------------------------------------

CREATE TABLE taxonomy_release_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    dimension_id UUID NOT NULL
        REFERENCES taxonomy_dimensions(id),
    code TEXT NOT NULL
        CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
    label TEXT NOT NULL
        CHECK (btrim(label) <> ''),
    display_order INTEGER NOT NULL DEFAULT 0
        CHECK (display_order >= 0),
    help_text TEXT,
    detail_section TEXT
        CHECK (detail_section IS NULL OR btrim(detail_section) <> ''),
    official_codes TEXT[] NOT NULL DEFAULT '{}'::text[]
        CHECK (array_position(official_codes, NULL) IS NULL),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_taxonomy_release_group_code
        UNIQUE (release_id, dimension_id, code),
    CONSTRAINT uq_taxonomy_release_group_identity
        UNIQUE (id, release_id),
    CONSTRAINT fk_taxonomy_release_group_dimension
        FOREIGN KEY (release_id, dimension_id)
        REFERENCES taxonomy_release_dimensions(release_id, dimension_id)
);

CREATE INDEX ix_taxonomy_release_groups_release_dimension
ON taxonomy_release_groups(release_id, dimension_id, display_order);

CREATE TRIGGER trg_taxonomy_release_groups_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_groups
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();


-- ---------------------------------------------------------------------------
-- 3. Release-scoped presentation/configuration columns.
-- ---------------------------------------------------------------------------

ALTER TABLE taxonomy_release_dimensions
    ADD COLUMN profile_visible BOOLEAN,
    ADD COLUMN profile_order INTEGER
        CHECK (profile_order IS NULL OR profile_order >= 0),
    ADD COLUMN help_text TEXT,
    ADD COLUMN detail_section TEXT
        CHECK (detail_section IS NULL OR btrim(detail_section) <> ''),
    ADD COLUMN detail_order INTEGER
        CHECK (detail_order IS NULL OR detail_order >= 0),
    ADD COLUMN uses_groups BOOLEAN,
    ADD COLUMN official_code_type TEXT
        CHECK (
            official_code_type IS NULL
            OR official_code_type IN (
                'NCM',
                'CNAE',
                'CFOP',
                'NBS',
                'LC116',
                'DOCUMENT_MODEL',
                'CCLASSTRIB'
            )
        );

ALTER TABLE taxonomy_release_concepts
    ADD COLUMN group_id UUID,
    ADD COLUMN profile_visible BOOLEAN,
    ADD COLUMN display_order INTEGER
        CHECK (display_order IS NULL OR display_order >= 0),
    ADD COLUMN help_text TEXT,
    ADD COLUMN classify_by_label BOOLEAN,
    ADD COLUMN official_codes TEXT[] NOT NULL DEFAULT '{}'::text[]
        CHECK (array_position(official_codes, NULL) IS NULL),
    ADD CONSTRAINT fk_taxonomy_release_concept_group
        FOREIGN KEY (group_id, release_id)
        REFERENCES taxonomy_release_groups(id, release_id);

CREATE INDEX ix_taxonomy_release_concepts_group
ON taxonomy_release_concepts(group_id)
WHERE group_id IS NOT NULL;

-- Product groups may belong to one or more segments (sector concepts).
CREATE TABLE taxonomy_release_group_segments (
    release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    group_id UUID NOT NULL,
    segment_release_concept_id UUID NOT NULL,
    PRIMARY KEY (group_id, segment_release_concept_id),
    CONSTRAINT fk_taxonomy_group_segment_group
        FOREIGN KEY (group_id, release_id)
        REFERENCES taxonomy_release_groups(id, release_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_taxonomy_group_segment_concept
        FOREIGN KEY (segment_release_concept_id, release_id)
        REFERENCES taxonomy_release_concepts(id, release_id)
        ON DELETE CASCADE
);

CREATE INDEX ix_taxonomy_release_group_segments_segment
ON taxonomy_release_group_segments(segment_release_concept_id);

CREATE TRIGGER trg_taxonomy_release_group_segments_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_group_segments
FOR EACH ROW
EXECUTE FUNCTION taxonomy_guard_release_membership();


-- ---------------------------------------------------------------------------
-- 4. Runtime switches governed by the curator.
-- ---------------------------------------------------------------------------

CREATE TABLE taxonomy_runtime_settings (
    key TEXT PRIMARY KEY
        CHECK (key IN (
            'classification_enabled',
            'classification_excluded_sources'
        )),
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT NOT NULL
        CHECK (btrim(updated_by) <> '')
);

-- Classification starts disabled: the curator reviews the tables first.
-- DOE-SP stays excluded until its formal closure, because the DOE-SP rebuild
-- guard refuses classification history attached to its publications.
INSERT INTO taxonomy_runtime_settings (key, value, updated_by)
VALUES
    ('classification_enabled', 'false'::jsonb, 'migration-031'),
    ('classification_excluded_sources', '["doe-sp"]'::jsonb, 'migration-031');

REVOKE ALL ON taxonomy_runtime_settings
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON taxonomy_runtime_settings
TO radar_app, radar_worker, radar_taxonomy_curator;

GRANT UPDATE (value, updated_at, updated_by)
ON taxonomy_runtime_settings
TO radar_taxonomy_curator;


-- ---------------------------------------------------------------------------
-- 5. Classification seal per publication version x release x engine.
-- ---------------------------------------------------------------------------
-- Derived/rebuildable data. Intentionally no foreign key to
-- publication_versions: the DOE-SP rebuild guard allowlists every FK that
-- references publications/versions, and this table must not change that
-- reviewed R3 artifact. Orphan seals are harmless and ignored by readers.

CREATE TABLE publication_taxonomy_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL,
    taxonomy_release_id UUID NOT NULL
        REFERENCES taxonomy_releases(id),
    engine_key TEXT NOT NULL
        CHECK (btrim(engine_key) <> ''),
    engine_version TEXT NOT NULL
        CHECK (btrim(engine_version) <> ''),
    status TEXT NOT NULL
        CHECK (status IN ('SUCCESS', 'FAILED')),
    run_id UUID
        REFERENCES publication_taxonomy_runs(id),
    assertion_count INTEGER NOT NULL DEFAULT 0
        CHECK (assertion_count >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 1
        CHECK (attempt_count >= 1),
    error_message TEXT,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_taxonomy_scan
        UNIQUE (
            publication_version_id,
            taxonomy_release_id,
            engine_key,
            engine_version
        ),
    CONSTRAINT chk_publication_taxonomy_scan_state
        CHECK (
            (status = 'SUCCESS' AND run_id IS NOT NULL AND error_message IS NULL)
            OR (status = 'FAILED' AND error_message IS NOT NULL)
        )
);

CREATE INDEX ix_publication_taxonomy_scans_release_status
ON publication_taxonomy_scans(
    taxonomy_release_id,
    engine_key,
    engine_version,
    status
);

CREATE INDEX ix_publication_taxonomy_scans_run
ON publication_taxonomy_scans(run_id)
WHERE run_id IS NOT NULL;

CREATE TRIGGER trg_publication_taxonomy_scans_updated_at
BEFORE UPDATE ON publication_taxonomy_scans
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

REVOKE ALL ON publication_taxonomy_scans
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON publication_taxonomy_scans
TO radar_app, radar_taxonomy_curator;

GRANT SELECT, INSERT, UPDATE ON publication_taxonomy_scans
TO radar_worker;

-- Supports "latest classification of this concept" lookups for the Acervo.
CREATE INDEX ix_publication_taxonomy_runs_release_version_status
ON publication_taxonomy_runs(taxonomy_release_id, publication_version_id, status);


-- ---------------------------------------------------------------------------
-- 6. Grants for the new release-scoped tables.
-- ---------------------------------------------------------------------------

REVOKE ALL ON
    taxonomy_release_groups,
    taxonomy_release_group_segments
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON
    taxonomy_release_groups,
    taxonomy_release_group_segments
TO radar_app, radar_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    taxonomy_release_groups,
    taxonomy_release_group_segments
TO radar_taxonomy_curator;

-- ---------------------------------------------------------------------------
-- 7. Curator manual tags on a publication version.
-- ---------------------------------------------------------------------------
-- Classification runs stay a Worker responsibility (TAX-07 privilege policy).
-- A curator adds a tag through this append-only event log; removing an
-- automatic tag keeps using publication_taxonomy_reviews (REJECT). The latest
-- event per (version, release, concept) decides whether a manual tag is
-- active. No FK to publication_versions for the same DOE-SP reason above.

CREATE TABLE publication_taxonomy_curator_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL,
    taxonomy_release_id UUID NOT NULL,
    release_concept_id UUID NOT NULL,
    action TEXT NOT NULL
        CHECK (action IN ('ADD', 'REMOVE')),
    actor_id TEXT NOT NULL
        CHECK (btrim(actor_id) <> ''),
    rationale TEXT NOT NULL
        CHECK (btrim(rationale) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_publication_taxonomy_curator_tag_concept
        FOREIGN KEY (release_concept_id, taxonomy_release_id)
        REFERENCES taxonomy_release_concepts(id, release_id)
);

CREATE INDEX ix_publication_taxonomy_curator_tags_version
ON publication_taxonomy_curator_tags(
    publication_version_id,
    taxonomy_release_id,
    release_concept_id,
    created_at DESC,
    id DESC
);

CREATE INDEX ix_publication_taxonomy_curator_tags_concept
ON publication_taxonomy_curator_tags(release_concept_id, taxonomy_release_id);

CREATE TRIGGER trg_publication_taxonomy_curator_tags_append_only
BEFORE UPDATE OR DELETE
ON publication_taxonomy_curator_tags
FOR EACH ROW
EXECUTE FUNCTION taxonomy_classification_append_only_record();

REVOKE ALL ON publication_taxonomy_curator_tags
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON publication_taxonomy_curator_tags
TO radar_app, radar_worker;

GRANT SELECT, INSERT ON publication_taxonomy_curator_tags
TO radar_taxonomy_curator;
