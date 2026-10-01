-- PERF-01 / 028
-- Partial index for the catalog (Acervo v2) and the global aggregates.
--
-- Every /api/v2/archive, /api/v2/archive/facets, /public/v2/stats and
-- /public/v2/sources query filters out hidden publication families with
-- ten upper(...) LIKE predicates. Without an index each request evaluated
-- them on every publication and then sorted the whole table for
-- ORDER BY published_on DESC NULLS LAST (ix_publications_date is
-- published_on DESC, i.e. NULLS FIRST, so it cannot serve that order).
--
-- The predicate below MUST stay textually equivalent to
-- `visiblePublicationSql` in src/api/routes/catalog-monitoring.route.ts;
-- PostgreSQL only uses a partial index when the query predicate implies it.
-- If the hidden families change, replace this index in a new migration.
--
-- Operational note: CREATE INDEX (non-concurrent, inside the migration
-- transaction) blocks writes to publications while it builds. Measured
-- locally at < 1 s per 300k publications; run outside an active collection.

CREATE INDEX ix_publications_visible_order
ON publications(
    published_on DESC NULLS LAST,
    first_collected_at DESC
)
WHERE NOT (
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
);
