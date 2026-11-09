-- E9-ACERVO-01 (tribusca-control#116): inventário de candidatos RFB e DOE-SP já coletados no Acervo.
-- SOMENTE LEITURA. Para o Fábio rodar no Dashboard do Postgres de produção; esta sessão não tem canal ao banco.
-- Não lê nem exporta texto de ato, dados de tenant, empresa ou usuário: só metadados globais de publicação,
-- comprimentos e hashes. Termina em ROLLBACK.
--
-- Uso do resultado: o porte vem de char_length(content_text). A medição offline sobre os 10 atos RFB preservados
-- (rfb-acervo-equivalence.result.json) mostrou o mesmo porte que o motor em 10/10; RFB guarda a visão ORIGINAL,
-- então o porte da multivigente é >= o porte medido aqui. near_boundary marca até 2% de uma fronteira.
-- O resultado NÃO cobre célula: só escolhe qual ato capturar na representação oficial (ver README.md §3).

BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';

-- A. Inventário: quantos atos existem por fonte × tipo × porte (sem texto).
WITH v AS (
  SELECT s.code AS source_code, p.act_type, char_length(pv.content_text) AS chars, p.published_on
  FROM publications p
  JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current
  JOIN publication_origins o ON o.publication_id = p.id
  JOIN sources s ON s.id = o.source_id
  WHERE s.code IN ('rfb-normas', 'doe-sp') AND pv.content_text IS NOT NULL AND NOT p.is_hidden
)
SELECT source_code, act_type,
       CASE WHEN chars < 10000 THEN 'pequeno' WHEN chars < 50000 THEN 'medio' ELSE 'grande' END AS size,
       count(*) AS acts,
       count(*) FILTER (WHERE published_on < DATE '2026-01-01') AS acts_before_2026
FROM v
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- B. Candidatos: até 3 por fonte × tipo × porte, publicados antes de 2026 (margem dos reservados), mais recentes primeiro.
WITH v AS (
  SELECT s.code AS source_code, p.id AS publication_id, o.external_id, p.act_type, p.act_number, p.agency,
         p.published_on, o.official_url, pv.id AS version_id, pv.content_hash,
         char_length(pv.content_text) AS chars,
         pv.source_metadata -> 'presentation' ->> 'format' AS presentation_format,
         octet_length(pv.source_metadata -> 'presentation' ->> 'html') AS presentation_html_bytes
  FROM publications p
  JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current
  JOIN publication_origins o ON o.publication_id = p.id
  JOIN sources s ON s.id = o.source_id
  WHERE s.code IN ('rfb-normas', 'doe-sp') AND pv.content_text IS NOT NULL AND NOT p.is_hidden
    AND p.published_on < DATE '2026-01-01'
), c AS (
  SELECT *,
         CASE WHEN chars < 10000 THEN 'pequeno' WHEN chars < 50000 THEN 'medio' ELSE 'grande' END AS size,
         (abs(chars - 10000) <= 200 OR abs(chars - 50000) <= 1000) AS near_boundary
  FROM v
), r AS (
  SELECT *, row_number() OVER (PARTITION BY source_code, act_type, size
                               ORDER BY near_boundary, published_on DESC NULLS LAST, publication_id) AS rn
  FROM c
)
SELECT source_code, act_type, size, rn, external_id, act_number, agency, published_on, official_url,
       publication_id, version_id, content_hash, chars, near_boundary, presentation_format, presentation_html_bytes
FROM r
WHERE rn <= 3
ORDER BY source_code, act_type, size, rn;

ROLLBACK;
