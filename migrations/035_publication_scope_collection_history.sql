-- DOU-CLEAN-02 / tribusca-control#84
--
-- collection_run_publications is collection audit/history, not a normal
-- publication-content surface. SUPPRESS must hide canonical/product content
-- without rewriting the historical fact that a run imported a document.
--
-- Migration 033 enabled RLS here and made the radar_app SELECT policy scope-
-- aware. That caused /api/v1/monitoring/runs historical importedDocuments to
-- shrink after a later SUPPRESS. The monitor needs only collection_run_id and
-- disposition to aggregate that immutable history; it does not need the
-- publication_id or publication_version_id carried by the audit row.
--
-- Preserve the historical count while keeping least privilege: radar_app may
-- read all audit rows through RLS, but only the two non-content columns needed
-- by the monitoring aggregate. The publication identifiers remain inaccessible
-- to the application role, and canonical publication/version/origin/file rows
-- remain scope-restricted by migration 033.

DROP POLICY IF EXISTS collection_run_publications_app_scope
ON public.collection_run_publications;

CREATE POLICY collection_run_publications_app_history
ON public.collection_run_publications
FOR SELECT TO radar_app
USING (true);

REVOKE SELECT ON public.collection_run_publications FROM radar_app;
GRANT SELECT (collection_run_id, disposition)
ON public.collection_run_publications
TO radar_app;

-- Public coverage needs today's visible import count, not identifiers or raw
-- audit rows. Keep those columns private and expose only this narrow aggregate.
CREATE FUNCTION public.publication_scope_imported_today(p_source_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT count(*)::int
    FROM public.collection_runs cr
    JOIN public.collection_run_publications crp
      ON crp.collection_run_id = cr.id
    WHERE cr.source_id = p_source_id
      AND public.publication_scope_is_in_scope(crp.publication_id)
      AND crp.disposition IN ('NEW_PUBLICATION', 'NEW_VERSION')
      AND (crp.detected_at AT TIME ZONE 'America/Sao_Paulo')::date =
          (now() AT TIME ZONE 'America/Sao_Paulo')::date;
$$;

REVOKE ALL ON FUNCTION public.publication_scope_imported_today(UUID)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.publication_scope_imported_today(UUID)
TO radar_app;
