CREATE TABLE publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    identity_hash CHAR(64) NOT NULL,

    identity_version SMALLINT NOT NULL
        DEFAULT 1,

    identity_strength TEXT NOT NULL
        CHECK(
            identity_strength IN (
                'STRONG',
                'SOURCE_SCOPED'
            )
        ),

    identity_basis JSONB NOT NULL,

    jurisdiction_level TEXT NOT NULL
        CHECK(
            jurisdiction_level IN (
                'FEDERAL',
                'STATE'
            )
        ),

    uf CHAR(2),

    agency TEXT,

    act_type TEXT,

    act_number TEXT,

    title TEXT NOT NULL,

    published_on DATE,

    effective_on DATE,

    primary_official_url TEXT,

    first_collected_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    last_seen_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_publications_identity
        UNIQUE(identity_hash),

    CONSTRAINT chk_publication_identity_basis
        CHECK(
            jsonb_typeof(identity_basis)
            = 'object'
        ),

    CONSTRAINT chk_publication_scope
        CHECK(
            (
                jurisdiction_level = 'FEDERAL'
                AND uf IS NULL
            )
            OR
            (
                jurisdiction_level = 'STATE'
                AND uf IS NOT NULL
                AND uf ~ '^[A-Z]{2}$'
            )
        )
);

CREATE INDEX ix_publications_date
ON publications(
    published_on DESC
);

CREATE INDEX ix_publications_scope_date
ON publications(
    jurisdiction_level,
    uf,
    published_on DESC
);

CREATE INDEX ix_publications_agency
ON publications(
    agency,
    published_on DESC
);

CREATE INDEX ix_publications_act
ON publications(
    act_type,
    act_number
);

CREATE TABLE publication_origins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    publication_id UUID NOT NULL
        REFERENCES publications(id)
        ON DELETE CASCADE,

    source_id UUID NOT NULL
        REFERENCES sources(id),

    external_id TEXT,

    official_url TEXT NOT NULL,

    first_seen_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    last_seen_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX uq_publication_origin_external
ON publication_origins(
    source_id,
    external_id
)
WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX uq_publication_origin_url
ON publication_origins(
    source_id,
    official_url
);

CREATE INDEX ix_publication_origins_publication
ON publication_origins(publication_id);

CREATE TABLE publication_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    publication_id UUID NOT NULL
        REFERENCES publications(id)
        ON DELETE CASCADE,

    version_no INTEGER NOT NULL,

    content_hash CHAR(64) NOT NULL,

    content_text TEXT,

    relevant_excerpt TEXT,

    source_metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    is_current BOOLEAN NOT NULL
        DEFAULT TRUE,

    captured_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_publication_version_number
        UNIQUE(
            publication_id,
            version_no
        ),

    CONSTRAINT uq_publication_content_hash
        UNIQUE(
            publication_id,
            content_hash
        )
);

CREATE UNIQUE INDEX uq_publication_current_version
ON publication_versions(publication_id)
WHERE is_current = TRUE;

ALTER TABLE publication_versions
ADD COLUMN search_vector TSVECTOR
GENERATED ALWAYS AS (
    to_tsvector(
        'portuguese'::regconfig,
        coalesce(content_text, '')
        || ' '
        || coalesce(relevant_excerpt, '')
    )
) STORED;

CREATE INDEX ix_publication_versions_search
ON publication_versions
USING GIN(search_vector);

CREATE TABLE publication_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    publication_version_id UUID NOT NULL
        REFERENCES publication_versions(id)
        ON DELETE CASCADE,

    storage_provider TEXT NOT NULL,

    bucket TEXT NOT NULL,

    object_key TEXT NOT NULL,

    original_filename TEXT,

    mime_type TEXT,

    size_bytes BIGINT
        CHECK(
            size_bytes IS NULL
            OR size_bytes >= 0
        ),

    raw_sha256 CHAR(64) NOT NULL,

    official_url TEXT,

    source_etag TEXT,

    source_last_modified TEXT,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_publication_file
        UNIQUE(
            publication_version_id,
            raw_sha256
        )
);

CREATE TABLE collection_run_publications (
    collection_run_id UUID NOT NULL
        REFERENCES collection_runs(id)
        ON DELETE CASCADE,

    publication_id UUID NOT NULL
        REFERENCES publications(id)
        ON DELETE CASCADE,

    publication_version_id UUID
        REFERENCES publication_versions(id),

    disposition TEXT NOT NULL
        CHECK(
            disposition IN (
                'NEW_PUBLICATION',
                'EXISTING_PUBLICATION',
                'NEW_VERSION'
            )
        ),

    detected_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    PRIMARY KEY(
        collection_run_id,
        publication_id
    )
);

CREATE INDEX ix_collection_run_publications_pub
ON collection_run_publications(publication_id);

ALTER TABLE collection_items
ADD CONSTRAINT fk_collection_item_publication
FOREIGN KEY(publication_id)
REFERENCES publications(id);
