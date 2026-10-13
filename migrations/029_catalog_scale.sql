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
-- 3. publication_source_feed: one row per (catalog source code, publication),
--    kept by triggers, so the Acervo source filter reads an index ordered by
--    date instead of probing publication_origins for every publication.
--    source_code is the semantic, lower-case code the Acervo filters by, so
--    case variants of sources.code ("dou"/"DOU") collapse into one row and
--    "confaz" exists even without a sources row. Membership keeps the
--    previous filter meaning:
--      - confaz: CONFAZ-typed acts plus any act with a confaz origin;
--      - dou: acts with a dou origin that are not CONFAZ-typed;
--      - any other code: acts with an origin from a source with that code.
--
-- Operational note: the ALTER TABLE statements rewrite publications and
-- publication_versions and lock them for the duration; with the feed
-- backfill and index builds the whole migration took ~12.5 min locally for
-- 5M publications. Pause writers and run it outside an active collection,
-- before the historical DOU load. Runbook: docs/catalog-performance.md.

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
    first_collected_at DESC,
    id
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
--
-- Security: every function below is SECURITY DEFINER, so each one pins
-- search_path = pg_catalog, public, pg_temp (pg_temp last: otherwise a
-- session's temporary tables are searched first and could shadow these
-- relations) and schema-qualifies every relation and function it uses.

CREATE TABLE public.publication_source_feed (
    -- lower(sources.code), or 'confaz' for CONFAZ-typed acts.
    source_code TEXT NOT NULL
        CHECK (source_code = lower(source_code)),

    -- No foreign key on purpose: the DOE-SP rebuild guard
    -- (ops/doe-sp/sql/20_dry_run_readonly.sql) blocks on unknown foreign keys
    -- to publications. Rows are removed by publications_source_feed_delete.
    publication_id UUID NOT NULL,

    published_on DATE,

    first_collected_at TIMESTAMPTZ NOT NULL,

    is_hidden BOOLEAN NOT NULL,

    PRIMARY KEY(source_code, publication_id)
);

CREATE INDEX ix_publication_source_feed_order
ON public.publication_source_feed(
    source_code,
    published_on DESC NULLS LAST,
    first_collected_at DESC,
    publication_id
)
WHERE NOT is_hidden;

CREATE INDEX ix_publication_source_feed_publication
ON public.publication_source_feed(publication_id);

-- Feed rows a set of publications must have, computed from publications,
-- publication_origins and sources (the authoritative state).
CREATE FUNCTION public.publication_source_feed_expected(p_publication_ids UUID[])
RETURNS TABLE (
    source_code TEXT,
    publication_id UUID,
    published_on DATE,
    first_collected_at TIMESTAMPTZ,
    is_hidden BOOLEAN
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT lower(s.code), p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM public.publications p
    JOIN public.publication_origins po
      ON po.publication_id = p.id
    JOIN public.sources s
      ON s.id = po.source_id
    WHERE p.id = ANY(p_publication_ids)
      AND NOT (lower(s.code) = 'dou' AND p.is_confaz)
    UNION
    SELECT 'confaz', p.id, p.published_on, p.first_collected_at, p.is_hidden
    FROM public.publications p
    WHERE p.id = ANY(p_publication_ids)
      AND p.is_confaz;
$$;

-- Recomputes the feed rows of the given publications. Refreshes of the same
-- publication are serialized: each refresh takes a transaction-scoped
-- advisory lock per publication (sorted, to avoid lock-order deadlocks
-- inside one refresh) and rebuilds from a snapshot taken after the lock, so
-- a concurrent writer's committed change is never overwritten by an older
-- view. Batches above 1,000 ids take one exclusive batch lock instead of
-- thousands of per-publication locks; single refreshes hold that batch lock
-- in shared mode, so both kinds still exclude each other. All triggers are
-- statement level, so one statement means one refresh call (bulk writes
-- never accumulate one lock per row).
CREATE FUNCTION public.refresh_publication_source_feed(p_publication_ids UUID[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    ids UUID[];
    publication UUID;
BEGIN
    SELECT array_agg(DISTINCT id ORDER BY id)
    INTO ids
    FROM unnest(p_publication_ids) AS id
    WHERE id IS NOT NULL;

    IF ids IS NULL THEN
        RETURN;
    END IF;

    IF cardinality(ids) > 1000 THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(28028, 0);
    ELSE
        PERFORM pg_catalog.pg_advisory_xact_lock_shared(28028, 0);
        FOREACH publication IN ARRAY ids LOOP
            PERFORM pg_catalog.pg_advisory_xact_lock(
                28029,
                pg_catalog.hashtext(publication::text)
            );
        END LOOP;
    END IF;

    DELETE FROM public.publication_source_feed
    WHERE publication_id = ANY(ids);

    INSERT INTO public.publication_source_feed (
        source_code,
        publication_id,
        published_on,
        first_collected_at,
        is_hidden
    )
    SELECT *
    FROM public.publication_source_feed_expected(ids)
    ON CONFLICT DO NOTHING;
END;
$$;

CREATE FUNCTION public.trg_publication_origins_source_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    ids UUID[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(publication_id) INTO ids FROM new_rows;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(publication_id) INTO ids FROM old_rows;
    ELSE
        -- Only publication/source changes matter (not last_seen_at).
        SELECT array_agg(changed.publication_id) INTO ids
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

    PERFORM public.refresh_publication_source_feed(ids);
    RETURN NULL;
END;
$$;

CREATE TRIGGER publication_origins_source_feed_insert
AFTER INSERT ON public.publication_origins
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publication_origins_source_feed();

CREATE TRIGGER publication_origins_source_feed_update
AFTER UPDATE ON public.publication_origins
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publication_origins_source_feed();

CREATE TRIGGER publication_origins_source_feed_delete
AFTER DELETE ON public.publication_origins
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publication_origins_source_feed();

CREATE FUNCTION public.trg_publications_source_feed_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    ids UUID[];
BEGIN
    -- Only changes that affect feed rows (not last_seen_at/updated_at).
    SELECT array_agg(n.id) INTO ids
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    WHERE o.published_on IS DISTINCT FROM n.published_on
       OR o.first_collected_at IS DISTINCT FROM n.first_collected_at
       OR o.is_hidden IS DISTINCT FROM n.is_hidden
       OR o.is_confaz IS DISTINCT FROM n.is_confaz;

    PERFORM public.refresh_publication_source_feed(ids);
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_source_feed_update
AFTER UPDATE ON public.publications
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publications_source_feed_update();

CREATE FUNCTION public.trg_publications_source_feed_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    DELETE FROM public.publication_source_feed f
    USING old_rows o
    WHERE f.publication_id = o.id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_source_feed_delete
AFTER DELETE ON public.publications
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publications_source_feed_delete();

-- A source whose code changes (case-insensitively) moves its publications to
-- another feed code. Rare administrative operation.
CREATE FUNCTION public.trg_sources_source_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public.refresh_publication_source_feed(
        ARRAY(
            SELECT DISTINCT po.publication_id
            FROM public.publication_origins po
            WHERE po.source_id = NEW.id
        )
    );
    RETURN NULL;
END;
$$;

CREATE TRIGGER sources_source_feed_update
AFTER UPDATE OF code ON public.sources
FOR EACH ROW
WHEN (lower(OLD.code) IS DISTINCT FROM lower(NEW.code))
EXECUTE FUNCTION public.trg_sources_source_feed();

-- Backfill (same rule as publication_source_feed_expected, all rows).
INSERT INTO public.publication_source_feed (
    source_code,
    publication_id,
    published_on,
    first_collected_at,
    is_hidden
)
SELECT lower(s.code), p.id, p.published_on, p.first_collected_at, p.is_hidden
FROM public.publications p
JOIN public.publication_origins po
  ON po.publication_id = p.id
JOIN public.sources s
  ON s.id = po.source_id
WHERE NOT (lower(s.code) = 'dou' AND p.is_confaz)
UNION
SELECT 'confaz', p.id, p.published_on, p.first_collected_at, p.is_hidden
FROM public.publications p
WHERE p.is_confaz
ON CONFLICT DO NOTHING;

REVOKE ALL ON public.publication_source_feed FROM PUBLIC;

GRANT SELECT
ON public.publication_source_feed
TO radar_app, radar_worker;

REVOKE ALL ON FUNCTION public.publication_source_feed_expected(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_publication_source_feed(UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publication_origins_source_feed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publications_source_feed_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publications_source_feed_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_sources_source_feed() FROM PUBLIC;
