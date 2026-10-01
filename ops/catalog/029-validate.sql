-- PERF-02 / migration 029 — read-only post-migration validation.
-- Usage: psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f ops/catalog/029-validate.sql
-- Every *_mismatch / missing / stale value must be 0. Runs in a READ ONLY
-- transaction that is rolled back.

BEGIN READ ONLY;

\echo == 1. objects
SELECT
  (SELECT count(*) FROM pg_extension WHERE extname = 'unaccent') AS unaccent_extension,
  (SELECT count(*) FROM pg_ts_config WHERE cfgname = 'pt_unaccent') AS pt_unaccent_config,
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%source_feed%') AS feed_triggers,
  (SELECT count(*) FROM schema_migrations WHERE filename = '029_catalog_scale.sql') AS migration_recorded;

\echo == 2. stored flags equal the previous LIKE rules
SELECT
  count(*) FILTER (WHERE p.is_hidden IS DISTINCT FROM (
    upper(coalesce(p.act_type, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(p.title, '')) LIKE '%AVISO DE LICITAÇÃO%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(p.title, '')) LIKE '%COMUNICADO DGFIN%'
    OR upper(coalesce(p.act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(p.title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(p.title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
    OR upper(coalesce(p.title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%'
  )) AS hidden_mismatch,
  count(*) FILTER (WHERE p.is_confaz IS DISTINCT FROM (
    upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%'
    OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%'
    OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%'
    OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%'
  )) AS confaz_mismatch
FROM publications p;

\echo == 3. feed equals the authoritative membership
WITH expected AS (
  SELECT lower(s.code) AS source_code, p.id AS publication_id,
         p.published_on, p.first_collected_at, p.is_hidden
  FROM publications p
  JOIN publication_origins po ON po.publication_id = p.id
  JOIN sources s ON s.id = po.source_id
  WHERE NOT (lower(s.code) = 'dou' AND p.is_confaz)
  UNION
  SELECT 'confaz', p.id, p.published_on, p.first_collected_at, p.is_hidden
  FROM publications p
  WHERE p.is_confaz
),
actual AS (
  SELECT source_code, publication_id, published_on, first_collected_at, is_hidden
  FROM publication_source_feed
)
SELECT
  (SELECT count(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) x) AS missing,
  (SELECT count(*) FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) y) AS stale;

\echo == 4. per source: feed (visible) equals the previous filter rule
SELECT
  c.code,
  (SELECT count(*) FROM (
     SELECT p.id
     FROM publications p
     WHERE NOT (upper(coalesce(p.act_type, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(p.title, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(p.act_type, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(p.title, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(p.act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(p.title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(p.act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(p.title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(p.act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%' OR upper(coalesce(p.title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%')
       AND (
         (c.code = 'confaz' AND ((upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%' OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%' OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%') OR EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = 'confaz')))
         OR (c.code = 'dou' AND NOT (upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%' OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%' OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%') AND EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = 'dou'))
         OR (c.code NOT IN ('confaz', 'dou') AND EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = c.code))
       )
     EXCEPT
     SELECT f.publication_id FROM publication_source_feed f
     WHERE f.source_code = c.code AND NOT f.is_hidden
  ) only_previous_rule) AS only_previous_rule,
  (SELECT count(*) FROM (
     SELECT f.publication_id FROM publication_source_feed f
     WHERE f.source_code = c.code AND NOT f.is_hidden
     EXCEPT
     SELECT p.id
     FROM publications p
     WHERE NOT (upper(coalesce(p.act_type, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(p.title, '')) LIKE '%AVISO DE LICITAÇÃO%' OR upper(coalesce(p.act_type, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(p.title, '')) LIKE '%COMUNICADO DGFIN%' OR upper(coalesce(p.act_type, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(p.title, '')) LIKE '%PORTARIA DO COORDENADOR GERAL%' OR upper(coalesce(p.act_type, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(p.title, '')) LIKE '%COMISSÃO DE ANÁLISE DE PROJETOS%' OR upper(coalesce(p.act_type, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%' OR upper(coalesce(p.title, '')) LIKE '%COMISSAO DE ANALISE DE PROJETOS%')
       AND (
         (c.code = 'confaz' AND ((upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%' OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%' OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%') OR EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = 'confaz')))
         OR (c.code = 'dou' AND NOT (upper(coalesce(p.act_type, '')) LIKE '%CONVÊNIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%CONVENIO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%AJUSTE SINIEF%' OR upper(coalesce(p.act_type, '')) LIKE '%PROTOCOLO ICMS%' OR upper(coalesce(p.act_type, '')) LIKE '%ATO COTEPE%' OR upper(coalesce(p.act_type, '')) LIKE '%CONFAZ%') AND EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = 'dou'))
         OR (c.code NOT IN ('confaz', 'dou') AND EXISTS (
            SELECT 1 FROM publication_origins po JOIN sources s ON s.id = po.source_id
            WHERE po.publication_id = p.id AND lower(s.code) = c.code))
       )
  ) only_feed) AS only_feed
FROM (SELECT DISTINCT lower(code) AS code FROM sources UNION SELECT 'confaz') c
ORDER BY c.code;

\echo == 5. plans use the new indexes
EXPLAIN (COSTS OFF)
SELECT p.id FROM publications p WHERE NOT p.is_hidden
ORDER BY p.published_on DESC NULLS LAST, p.first_collected_at DESC, p.id LIMIT 25;
EXPLAIN (COSTS OFF)
SELECT f.publication_id FROM publication_source_feed f
WHERE f.source_code = 'dou' AND NOT f.is_hidden
ORDER BY f.published_on DESC NULLS LAST, f.first_collected_at DESC, f.publication_id LIMIT 25;
EXPLAIN (COSTS OFF)
SELECT p.id FROM publications p
WHERE NOT p.is_hidden AND p.title_vector @@ to_tsquery('public.pt_unaccent', 'convenio');

ROLLBACK;
