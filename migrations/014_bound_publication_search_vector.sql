-- Preserve full publication text while keeping PostgreSQL full-text indexing
-- below the 1 MiB input limit of to_tsvector().
--
-- Worst-case UTF-8 budget:
--   160,000 head chars + 40,000 tail chars + 20,000 excerpt chars
--   * 4 bytes/char + separators < 1,048,575 bytes.
-- The complete content_text remains stored unchanged.

DROP INDEX IF EXISTS ix_publication_versions_search;

ALTER TABLE publication_versions
DROP COLUMN search_vector;

ALTER TABLE publication_versions
ADD COLUMN search_vector TSVECTOR
GENERATED ALWAYS AS (
    to_tsvector(
        'portuguese'::regconfig,
        left(coalesce(content_text, ''), 160000)
        || ' '
        || right(coalesce(content_text, ''), 40000)
        || ' '
        || left(coalesce(relevant_excerpt, ''), 20000)
    )
) STORED;

CREATE INDEX ix_publication_versions_search
ON publication_versions
USING GIN(search_vector);
