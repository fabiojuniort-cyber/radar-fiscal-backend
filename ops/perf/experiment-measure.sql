-- PERF-02 experiment: timings for the proposed solutions (P1-P6).
-- Run after experiment-build.sql. Scratch DB only.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF current_database() NOT LIKE '%perf%' THEN
    RAISE EXCEPTION 'refusing to run on %: database name must contain "perf"', current_database();
  END IF;
END
$$;

\timing on
\set dou '(SELECT id FROM sources WHERE code = ''dou'')'
\set sped '(SELECT id FROM sources WHERE code = ''sped'')'
\echo == P1 pre-aggregated counts per source (replaces 37 s query)
SELECT s.code, c.all_visible, c.non_confaz_visible FROM sources s LEFT JOIN catalog_source_counts c ON c.source_id = s.id;
\echo == P2 visible total with stored flag
SELECT count(*) FROM publications WHERE NOT is_hidden;
\echo == P3 archive by source: page 1 (stored primary source + index)
SELECT id FROM publications WHERE primary_source_id = :dou AND NOT is_hidden ORDER BY published_on DESC NULLS LAST, first_collected_at DESC LIMIT 25;
SELECT id FROM publications WHERE primary_source_id = :sped AND NOT is_hidden ORDER BY published_on DESC NULLS LAST, first_collected_at DESC LIMIT 25;
\echo == P3b archive by source: exact count
SELECT count(*) FROM publications WHERE primary_source_id = :dou AND NOT is_hidden;
SELECT count(*) FROM publications WHERE primary_source_id = :sped AND NOT is_hidden;
\echo == P4 capped count (answers "more than 10,000")
SELECT count(*) FROM (SELECT 1 FROM publications WHERE primary_source_id = :dou AND NOT is_hidden LIMIT 10001) t;
\echo == P5 facets from stored primary source
SELECT DISTINCT primary_source_id FROM publications WHERE NOT is_hidden;
\echo == P6 search: current ILIKE vs full-text index
SELECT count(*) FROM publications p JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current WHERE NOT p.is_hidden AND (p.title ILIKE '%99999%' OR coalesce(pv.content_text,'') ILIKE '%99999%');
SELECT count(*) FROM publication_versions pv WHERE pv.is_current AND pv.search_vector @@ websearch_to_tsquery('portuguese', '99999');
SELECT p.id FROM publication_versions pv JOIN publications p ON p.id = pv.publication_id WHERE pv.is_current AND NOT p.is_hidden AND pv.search_vector @@ websearch_to_tsquery('portuguese', '99999') ORDER BY p.published_on DESC NULLS LAST LIMIT 25;
\echo == P6b broad term (worst case for full-text: many matches)
SELECT count(*) FROM publication_versions pv WHERE pv.is_current AND pv.search_vector @@ websearch_to_tsquery('portuguese', 'portaria');
SELECT p.id FROM publication_versions pv JOIN publications p ON p.id = pv.publication_id WHERE pv.is_current AND NOT p.is_hidden AND pv.search_vector @@ websearch_to_tsquery('portuguese', 'portaria') ORDER BY p.published_on DESC NULLS LAST LIMIT 25;
