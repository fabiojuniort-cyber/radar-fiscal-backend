-- PERF-01/PERF-02 / 028
-- Catalog (Acervo) structures that keep request cost independent of the
-- number of publications. Measurements: docs/catalog-scale-plan.md.
--
-- 1. Stored classification flags on publications. The hidden-family and
--    CONFAZ rules used to be ten/six upper(...) LIKE predicates evaluated on
--    every row of every catalog request. This migration is now their single
--    source of truth; changing a family means a new migration.
-- 2. Accent-insensitive, prefix-friendly search over act type, number,
--    agency and title (title_vector) and over the full content
--    (search_vector), both with the pt_unaccent configuration ("convenio"
--    finds "Convênio").
-- 3. publication_source_feed: one row per (catalog source, publication),
--    kept by triggers, so the Acervo source filter reads an index ordered by
--    date instead of probing publication_origins for every publication.
--    Membership keeps the previous filter meaning:
--      - confaz: CONFAZ-typed acts plus any act with a confaz origin;
--      - dou: acts with a dou origin that are not CONFAZ-typed;
--      - any other source: acts with an origin from that source.
--
-- Operational note: the ALTER TABLE statements rewrite publications and
-- publication_versions and lock them for the duration (measured locally:
-- ~2 min for 5M publications; seconds at the current production volume).
-- Run outside an active collection, before the historical DOU load.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION public.pt_unaccent (
    COPY = pg_catalog.portuguese
);

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
ALTER MAPPING FOR hword, hword_part, word
WITH unaccent, portuguese_stem;

-- 1 + 2a. Flags and title search vector -------------------------------------

ALTER TABLE publications
ADD COLUMN is_hidden BOOLEAN NOT NULL
GENERATED ALWAYS AS (
    upper(coalesce(act_type, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(title, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(act_type, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(title, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
    OR upper(coalesce(title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
) STORED,
ADD COLUMN is_confaz BOOLEAN NOT NULL
GENERATED ALWAYS AS (
    upper(coalesce(act_type, '')) LIKE '%CONVÊNIO ICMS%'
    OR upper(coalesce(act_type, '')) LIKE '%CONVENIO ICMS%'
    OR upper(coalesce(act_type, '')) LIKE '%AJUSTE SINIEF%'
    OR upper(coalesce(act_type, '')) LIKE '%PROTOCOLO ICMS%'
    OR upper(coalesce(act_type, '')) LIKE '%ATO COTEPE%'
    OR upper(coalesce(act_type, '')) LIKE '%CONFAZ%'
) STORED,
ADD COLUMN title_vector TSVECTOR
GENERATED ALWAYS AS (
    to_tsvector(
        'public.pt_unaccent'::regconfig,
        coalesce(act_type, '')
        || ' '
        || coalesce(act_number, '')
        || ' '
        || coalesce(agency, '')
        || ' '
        || left(coalesce(title, ''), 20000)
    )
) STORED;

-- Newest-first browsing of visible publications. ix_publications_date
-- (published_on DESC = NULLS FIRST) cannot serve DESC NULLS LAST.
CREATE INDEX ix_publications_visible_order
ON publications(
    published_on DESC NULLS LAST,
    first_collected_at DESC
)
WHERE NOT is_hidden;

CREATE INDEX ix_publications_title_vector
ON publications
USING GIN(title_vector)
WHERE NOT is_hidden;

-- 2b. Full-content search vector with the same bounds as migration 014 -------

DROP INDEX IF EXISTS ix_publication_versions_search;

ALTER TABLE publication_versions
DROP COLUMN search_vector;

ALTER TABLE publication_versions
ADD COLUMN search_vector TSVECTOR
GENERATED ALWAYS AS (
    to_tsvector(
        'public.pt_unaccent'::regconfig,
        left(coalesce(content_text, ''), 160000)
        || ' '
        || right(coalesce(content_text, ''), 40000)
        || ' '
        || left(coalesce(relevant_excerpt, ''), 20000)
    )
) STORED;

CREATE INDEX ix_publication_versions_search
ON publication_versions
USING GIN(search_vector)
WHERE is_current;

-- 3. Source feed ---------------------------------------------------------------

CREATE TABLE publication_source_feed (
    source_id UUID NOT NULL
        REFERENCES sources(id)
        ON DELETE CASCADE,

    -- No foreign key on purpose: the DOE-SP rebuild guard
    -- (ops/doe-sp/sql/20_dry_run_readonly.sql) blocks on unknown foreign keys
    -- to publications. Rows are removed by publications_source_feed_delete.
    publication_id UUID NOT NULL,

    published_on DATE,

    first_collected_at TIMESTAMPTZ NOT NULL,

    is_hidden BOOLEAN NOT NULL,

    PRIMARY KEY(source_id, publication_id)
);

CREATE INDEX ix_publication_source_feed_order
ON publication_source_feed(
    source_id,
    published_on DESC NULLS LAST,
    first_collected_at DESC
)
WHERE NOT is_hidden;

CREATE INDEX ix_publication_source_feed_publication
ON publication_source_feed(publication_id);

-- Recomputes the feed rows of the given publications from publications,
-- publication_origins and sources. Set-based so bulk loads stay cheap.
CREATE FUNCTION refresh_publication_source_feed(p_publication_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_publication_ids IS NULL
       OR cardinality(p_publication_ids) = 0 THEN
        RETURN;
    END IF;

    DELETE FROM publication_source_feed
    WHERE publication_id = ANY(p_publication_ids);

    INSERT INTO publication_source_feed (
        source_id,
        publication_id,
        published_on,
        first_collected_at,
        is_hidden
    )
    SELECT s.id, p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM publications p
    JOIN publication_origins po
      ON po.publication_id = p.id
    JOIN sources s
      ON s.id = po.source_id
    WHERE p.id = ANY(p_publication_ids)
      AND NOT (lower(s.code) = 'dou' AND p.is_confaz)
    UNION
    SELECT s.id, p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM publications p
    JOIN sources s
      ON lower(s.code) = 'confaz'
    WHERE p.id = ANY(p_publication_ids)
      AND p.is_confaz
    ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION trg_publication_origins_source_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    ids UUID[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(DISTINCT publication_id) INTO ids FROM new_rows;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(DISTINCT publication_id) INTO ids FROM old_rows;
    ELSE
        SELECT array_agg(DISTINCT changed.publication_id) INTO ids
        FROM (
            SELECT o.publication_id
            FROM old_rows o
            JOIN new_rows n ON n.id = o.id
            WHERE o.publication_id IS DISTINCT FROM n.publication_id
               OR o.source_id IS DISTINCT FROM n.source_id
            UNION ALL
            SELECT n.publication_id
            FROM old_rows o
            JOIN new_rows n ON n.id = o.id
            WHERE o.publication_id IS DISTINCT FROM n.publication_id
               OR o.source_id IS DISTINCT FROM n.source_id
        ) changed;
    END IF;

    PERFORM refresh_publication_source_feed(ids);
    RETURN NULL;
END;
$$;

CREATE TRIGGER publication_origins_source_feed_insert
AFTER INSERT ON publication_origins
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_publication_origins_source_feed();

CREATE TRIGGER publication_origins_source_feed_update
AFTER UPDATE ON publication_origins
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_publication_origins_source_feed();

CREATE TRIGGER publication_origins_source_feed_delete
AFTER DELETE ON publication_origins
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_publication_origins_source_feed();

CREATE FUNCTION trg_publications_source_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    ids UUID[];
BEGIN
    SELECT array_agg(n.id) INTO ids
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    WHERE o.published_on IS DISTINCT FROM n.published_on
       OR o.first_collected_at IS DISTINCT FROM n.first_collected_at
       OR o.is_hidden IS DISTINCT FROM n.is_hidden
       OR o.is_confaz IS DISTINCT FROM n.is_confaz;

    PERFORM refresh_publication_source_feed(ids);
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_source_feed_update
AFTER UPDATE ON publications
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_publications_source_feed();

CREATE FUNCTION trg_publications_source_feed_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM publication_source_feed f
    USING old_rows o
    WHERE f.publication_id = o.id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_source_feed_delete
AFTER DELETE ON publications
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_publications_source_feed_delete();

-- Backfill (same membership rule as refresh_publication_source_feed).
INSERT INTO publication_source_feed (
    source_id,
    publication_id,
    published_on,
    first_collected_at,
    is_hidden
)
SELECT s.id, p.id, p.published_on, p.first_collected_at, p.is_hidden
FROM publications p
JOIN publication_origins po
  ON po.publication_id = p.id
JOIN sources s
  ON s.id = po.source_id
WHERE NOT (lower(s.code) = 'dou' AND p.is_confaz)
UNION
SELECT s.id, p.id, p.published_on, p.first_collected_at, p.is_hidden
FROM publications p
JOIN sources s
  ON lower(s.code) = 'confaz'
WHERE p.is_confaz
ON CONFLICT DO NOTHING;

REVOKE ALL ON publication_source_feed FROM PUBLIC;

GRANT SELECT
ON publication_source_feed
TO radar_app, radar_worker;

REVOKE ALL ON FUNCTION refresh_publication_source_feed(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION trg_publication_origins_source_feed() FROM PUBLIC;
REVOKE ALL ON FUNCTION trg_publications_source_feed() FROM PUBLIC;
REVOKE ALL ON FUNCTION trg_publications_source_feed_delete() FROM PUBLIC;
