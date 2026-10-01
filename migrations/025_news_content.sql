-- NEWS-01 / 025
-- Global official-news storage. News is collected once and later matched to
-- multiple tenants; it must not be mixed with legislative publications.

ALTER TABLE sources
ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'LEGISLATION'
    CHECK (content_kind IN ('LEGISLATION', 'NEWS'));

CREATE INDEX ix_sources_content_kind_active
ON sources(content_kind, is_active);

CREATE TABLE news_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL
        REFERENCES sources(id),
    identity_hash CHAR(64) NOT NULL
        CHECK (identity_hash ~ '^[a-f0-9]{64}$'),
    external_id TEXT,
    agency TEXT,
    official_url TEXT NOT NULL
        CHECK (btrim(official_url) <> ''),
    first_collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_news_item_identity
        UNIQUE (source_id, identity_hash)
);

CREATE UNIQUE INDEX uq_news_item_external_id
ON news_items(source_id, external_id)
WHERE external_id IS NOT NULL AND btrim(external_id) <> '';

CREATE UNIQUE INDEX uq_news_item_official_url
ON news_items(source_id, official_url);

CREATE INDEX ix_news_items_source_seen
ON news_items(source_id, last_seen_at DESC);

CREATE TRIGGER trg_news_items_updated_at
BEFORE UPDATE ON news_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE news_item_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    news_item_id UUID NOT NULL
        REFERENCES news_items(id)
        ON DELETE RESTRICT,
    version_no INTEGER NOT NULL
        CHECK (version_no >= 1),
    content_hash CHAR(64) NOT NULL
        CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    title TEXT NOT NULL
        CHECK (btrim(title) <> ''),
    summary TEXT,
    content TEXT,
    category TEXT,
    published_at TIMESTAMPTZ,
    updated_at_source TIMESTAMPTZ,
    official_url TEXT NOT NULL
        CHECK (btrim(official_url) <> ''),
    tags TEXT[] NOT NULL DEFAULT '{}',
    source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_news_item_version_no
        UNIQUE (news_item_id, version_no),
    CONSTRAINT uq_news_item_content_hash
        UNIQUE (news_item_id, content_hash),
    CONSTRAINT chk_news_item_version_metadata
        CHECK (jsonb_typeof(source_metadata) = 'object')
);

CREATE INDEX ix_news_item_versions_item_latest
ON news_item_versions(news_item_id, version_no DESC);

CREATE INDEX ix_news_item_versions_published
ON news_item_versions(published_at DESC NULLS LAST);

ALTER TABLE collection_items
ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'PUBLICATION'
    CHECK (content_kind IN ('PUBLICATION', 'NEWS')),
ADD COLUMN news_item_id UUID
    REFERENCES news_items(id);

ALTER TABLE collection_items
ADD CONSTRAINT chk_collection_item_content_target
CHECK (
    (content_kind = 'PUBLICATION' AND news_item_id IS NULL)
    OR
    (content_kind = 'NEWS' AND publication_id IS NULL)
);

CREATE INDEX ix_collection_items_news_item
ON collection_items(news_item_id)
WHERE news_item_id IS NOT NULL;

REVOKE ALL ON news_items, news_item_versions
FROM PUBLIC;

GRANT SELECT ON news_items, news_item_versions
TO radar_app;

GRANT SELECT, INSERT, UPDATE ON news_items
TO radar_worker;

GRANT SELECT, INSERT ON news_item_versions
TO radar_worker;
