-- PERF-02 experiment: proposed stored flags, primary source and
-- pre-aggregated counts. Run after seed-catalog-scale.sql. Scratch DB only.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF current_database() NOT LIKE '%perf%' THEN
    RAISE EXCEPTION 'refusing to run on %: database name must contain "perf"', current_database();
  END IF;
END
$$;

\timing on
-- E1: stored flags (generated columns) = table rewrite; measures migration cost
ALTER TABLE publications
  ADD COLUMN is_hidden boolean GENERATED ALWAYS AS (upper(coalesce(act_type, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(title, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(act_type, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(title, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%' OR upper(coalesce(title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%') STORED,
  ADD COLUMN is_confaz boolean GENERATED ALWAYS AS (upper(coalesce(act_type, '')) LIKE '%CONVÊNIO ICMS%' OR upper(coalesce(act_type, '')) LIKE '%CONVENIO ICMS%' OR upper(coalesce(act_type, '')) LIKE '%AJUSTE SINIEF%' OR upper(coalesce(act_type, '')) LIKE '%PROTOCOLO ICMS%' OR upper(coalesce(act_type, '')) LIKE '%ATO COTEPE%' OR upper(coalesce(act_type, '')) LIKE '%CONFAZ%') STORED,
  ADD COLUMN primary_source_id uuid;
-- E2: backfill primary (first) source
UPDATE publications p SET primary_source_id = fo.source_id
FROM (SELECT DISTINCT ON (publication_id) publication_id, source_id FROM publication_origins ORDER BY publication_id, first_seen_at) fo
WHERE fo.publication_id = p.id;
VACUUM ANALYZE publications;
-- E3: per-source browsing index
CREATE INDEX ix_pub_source_visible ON publications (primary_source_id, published_on DESC NULLS LAST, first_collected_at DESC) WHERE NOT is_hidden;
-- E4: pre-aggregated counts (full rebuild cost; incremental upkeep would be per run)
CREATE TABLE catalog_source_counts AS
SELECT po.source_id, count(DISTINCT po.publication_id) AS all_visible,
       count(DISTINCT po.publication_id) FILTER (WHERE NOT p.is_confaz) AS non_confaz_visible
FROM publication_origins po JOIN publications p ON p.id = po.publication_id
WHERE NOT p.is_hidden GROUP BY po.source_id;
ANALYZE publications;

-- P7: per-source feed keeping today's filter meaning (one row per origin)
CREATE TABLE publication_source_feed AS
SELECT po.source_id, p.id AS publication_id, p.published_on, p.first_collected_at, p.is_confaz
FROM publication_origins po JOIN publications p ON p.id = po.publication_id
WHERE NOT p.is_hidden;
CREATE INDEX ix_feed_source_order ON publication_source_feed (source_id, published_on DESC NULLS LAST, first_collected_at DESC);
