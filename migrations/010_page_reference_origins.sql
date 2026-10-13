-- INLABS XML evidence: different idMateria values share the same certified PDF page.
-- Retain URL uniqueness for document URLs. Page references require an external ID
-- and remain uniquely identified by the existing (source_id, external_id) index.
ALTER TABLE publication_origins
ADD CONSTRAINT chk_page_origin_external_id CHECK (
    metadata->>'officialUrlGranularity' IS DISTINCT FROM 'PAGE'
    OR (external_id IS NOT NULL AND btrim(external_id) <> '')
);

DROP INDEX uq_publication_origin_url;
CREATE UNIQUE INDEX uq_publication_origin_url
ON publication_origins(source_id, official_url)
WHERE metadata->>'officialUrlGranularity' IS DISTINCT FROM 'PAGE';

CREATE INDEX ix_publication_origin_page_url
ON publication_origins(source_id, official_url)
WHERE metadata->>'officialUrlGranularity' = 'PAGE';
