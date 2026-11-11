-- E9-ACERVO-01 (tribusca-control#116): variante da consulta B de 01_candidates_readonly.sql para o editor de consultas do
-- Dashboard (Railway). Esse editor pagina o resultado (cerca de 100 linhas) e não exporta CSV. Por isso:
--   - só RFB e só os 5 tipos do P2-c;
--   - saída numa única coluna `linha`, já em CSV (cabeçalho na 1ª linha);
--   - uma última linha `FIM,<n>` para conferir que nada foi cortado. O parser do plano ignora linhas mais curtas que o
--     cabeçalho e as repetições de `linha` vindas da cópia por página.
-- SOMENTE LEITURA: um único SELECT. Não lê texto de ato nem dados de tenant, empresa ou usuário. Mesmo porte, mesma margem
-- de 2026 e mesma ordem da consulta B. Executada por Fábio em 2026-11-10 → candidates-b-rfb-2026-11-10.csv (FIM,33).
WITH v AS (
  SELECT s.code AS source_code, p.id AS publication_id, o.external_id, p.act_type, p.act_number,
         p.published_on, o.official_url, char_length(pv.content_text) AS chars
  FROM publications p
  JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current
  JOIN publication_origins o ON o.publication_id = p.id
  JOIN sources s ON s.id = o.source_id
  WHERE s.code = 'rfb-normas' AND pv.content_text IS NOT NULL AND NOT p.is_hidden
    AND p.published_on < DATE '2026-01-01'
    AND (p.act_type ILIKE '%interpretativo%' OR p.act_type ILIKE '%executivo%'
         OR p.act_type ILIKE '%consulta%' OR p.act_type ILIKE 'portaria%' OR p.act_type ILIKE 'resolu%')
), c AS (
  SELECT *,
         CASE WHEN chars < 10000 THEN 'pequeno' WHEN chars < 50000 THEN 'medio' ELSE 'grande' END AS size,
         (abs(chars - 10000) <= 200 OR abs(chars - 50000) <= 1000) AS near_boundary,
         (extract(month FROM published_on) = 1 AND extract(day FROM published_on) <= 15) AS ambiguous_year
  FROM v
), r AS (
  SELECT *, row_number() OVER (PARTITION BY source_code, act_type, size
                               ORDER BY near_boundary, ambiguous_year, published_on DESC NULLS LAST, publication_id) AS rn
  FROM c
), q AS (
  SELECT 0 AS ord, 'source_code,act_type,size,rn,external_id,act_number,published_on,official_url,chars,near_boundary,ambiguous_year' AS linha
  UNION ALL
  SELECT row_number() OVER (ORDER BY act_type, size, rn),
         concat_ws(',',
           '"' || replace(coalesce(source_code, ''), '"', '""') || '"',
           '"' || replace(coalesce(act_type, ''), '"', '""') || '"',
           size, rn,
           '"' || replace(coalesce(external_id::text, ''), '"', '""') || '"',
           '"' || replace(coalesce(act_number::text, ''), '"', '""') || '"',
           coalesce(published_on::text, ''),
           '"' || replace(coalesce(official_url, ''), '"', '""') || '"',
           chars,
           CASE WHEN near_boundary THEN 'true' ELSE 'false' END,
           CASE WHEN ambiguous_year THEN 'true' ELSE 'false' END)
  FROM r WHERE rn <= 5
  UNION ALL
  SELECT 999999, 'FIM,' || (SELECT count(*) FROM r WHERE rn <= 5)
)
SELECT linha FROM q ORDER BY ord;
