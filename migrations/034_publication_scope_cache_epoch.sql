-- DOU-CLEAN-02 / tribusca-control#84
--
-- A SUPPRESS/RESTORE changes global product visibility. Public endpoints keep
-- short in-process aggregate caches, so every visibility transition advances a
-- monotonic epoch. Cache keys include this epoch and therefore cannot serve a
-- pre-transition payload after the transition commits.

CREATE TABLE public.publication_scope_epoch_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE
        CHECK (singleton),
    epoch BIGINT NOT NULL DEFAULT 0
        CHECK (epoch >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.publication_scope_epoch_state(singleton, epoch)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE FUNCTION public.publication_scope_epoch()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT epoch
    FROM public.publication_scope_epoch_state
    WHERE singleton = TRUE;
$$;

-- Replace the migration-033 trigger function. Scope state is the source of
-- truth: refresh the denormalized feed first, then advance the epoch in the
-- same transaction. A rollback rolls both back atomically.
CREATE OR REPLACE FUNCTION public.trg_publication_scope_refresh_feed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public.refresh_publication_source_feed(
        ARRAY[NEW.publication_id]
    );

    UPDATE public.publication_scope_epoch_state
    SET epoch = epoch + 1,
        updated_at = now()
    WHERE singleton = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PUBLICATION_SCOPE_EPOCH_STATE_MISSING';
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON public.publication_scope_epoch_state
FROM PUBLIC, radar_app, radar_worker;

REVOKE ALL ON FUNCTION public.publication_scope_epoch()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.publication_scope_epoch()
TO radar_app, radar_worker;
