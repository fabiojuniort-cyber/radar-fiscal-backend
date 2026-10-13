-- CAT-01 scale guard
--
-- The Acervo exposes publications.act_type verbatim as the legal-base facet.
-- With the historical DOU load this dimension must not require a DISTINCT
-- scan over millions of publications on every aggregate-cache refresh.
--
-- This migration keeps a tiny append-only catalog of act_type values ever
-- seen and validates current visibility through an indexed probe. Stale
-- catalog entries are harmless: the API only returns a candidate when a
-- visible publication still exists for it.

CREATE TABLE public.publication_act_type_catalog (
    act_type TEXT PRIMARY KEY,
    CONSTRAINT publication_act_type_catalog_nonblank
        CHECK (btrim(act_type) <> '')
);

-- Newest-first browsing/counting by exact collected act type. This also
-- supports the LATERAL visibility probe used by /api/v2/archive/facets.
CREATE INDEX ix_publications_act_type_visible_order
ON public.publications (
    act_type,
    published_on DESC NULLS LAST,
    first_collected_at DESC,
    id
)
WHERE NOT is_hidden
  AND act_type IS NOT NULL;

-- Seed the small candidate catalog while production is still small, before
-- the historical load. The value is preserved exactly as collected.
INSERT INTO public.publication_act_type_catalog (act_type)
SELECT DISTINCT p.act_type
FROM public.publications p
WHERE p.act_type IS NOT NULL
  AND btrim(p.act_type) <> ''
ON CONFLICT DO NOTHING;

-- Bulk inserts (including historical loaders) add only the distinct values
-- from each statement, avoiding one catalog write per publication.
CREATE FUNCTION public.trg_publications_act_type_catalog_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    INSERT INTO public.publication_act_type_catalog (act_type)
    SELECT DISTINCT n.act_type
    FROM new_rows n
    WHERE n.act_type IS NOT NULL
      AND btrim(n.act_type) <> ''
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_act_type_catalog_insert
AFTER INSERT ON public.publications
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_publications_act_type_catalog_insert();

-- Act-type corrections are rare. A row-level trigger keeps the catalog aware
-- of newly introduced values without firing on ordinary last_seen/title-only
-- updates.
CREATE FUNCTION public.trg_publications_act_type_catalog_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.act_type IS NOT NULL AND btrim(NEW.act_type) <> '' THEN
        INSERT INTO public.publication_act_type_catalog (act_type)
        VALUES (NEW.act_type)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER publications_act_type_catalog_update
AFTER UPDATE OF act_type ON public.publications
FOR EACH ROW
WHEN (OLD.act_type IS DISTINCT FROM NEW.act_type)
EXECUTE FUNCTION public.trg_publications_act_type_catalog_update();

REVOKE ALL ON public.publication_act_type_catalog FROM PUBLIC;
GRANT SELECT ON public.publication_act_type_catalog TO radar_app, radar_worker;

REVOKE ALL ON FUNCTION public.trg_publications_act_type_catalog_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_publications_act_type_catalog_update() FROM PUBLIC;
