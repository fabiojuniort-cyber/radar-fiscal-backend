-- DOU-CLEAN-02 / tribusca-control#84
--
-- collection_run_publications is collection audit/history, not a normal
-- publication-content surface. SUPPRESS must hide canonical/product content
-- without rewriting the historical fact that a run imported a document.
--
-- Migration 033 enabled RLS here and made the radar_app SELECT policy scope-
-- aware. That caused /api/v1/monitoring/runs historical importedDocuments to
-- shrink after a later SUPPRESS. Restore the pre-033 read semantics for this
-- audit table only; canonical publication/version/origin/file tables remain
-- scope-restricted and therefore content is still not exposed.

DROP POLICY IF EXISTS collection_run_publications_app_scope
ON public.collection_run_publications;

CREATE POLICY collection_run_publications_app_history
ON public.collection_run_publications
FOR SELECT TO radar_app
USING (true);
