-- Synthetic catalog volume for performance tests. NEVER run against a real
-- environment: it refuses to run unless the database name contains "perf".
--
-- Usage (after npm run db:migrate on an empty scratch database):
--   psql "$PERF_DATABASE_URL" -v n=5000000 -f ops/perf/seed-catalog-scale.sql
--
-- Shape (approximation of production, adjust as data evolves):
--   90% FEDERAL / 10% STATE (SP); ~2.5% without published_on;
--   ~6% hidden families (AVISO DE LICITAÇÃO, COMUNICADO DGFIN in title);
--   ~4% CONFAZ-typed acts; 2% with a second origin; dates over 24 years;
--   one current version per publication with short content (content volume
--   is measured separately, see README.md).

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() NOT LIKE '%perf%' THEN
    RAISE EXCEPTION 'refusing to seed %: database name must contain "perf"', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM publications) THEN
    RAISE EXCEPTION 'publications is not empty';
  END IF;
END
$$;

INSERT INTO sources (code, name, jurisdiction_level, uf, base_url, connector_key, is_active)
SELECT c, n, j, u, 'https://perf.invalid/' || c, 'perf-' || c, true
FROM (VALUES
  ('dou', 'Diário Oficial da União', 'FEDERAL', NULL),
  ('confaz', 'CONFAZ', 'FEDERAL', NULL),
  ('sped', 'SPED', 'FEDERAL', NULL),
  ('cgibs', 'CGIBS', 'FEDERAL', NULL),
  ('rfb-normas', 'RFB Normas', 'FEDERAL', NULL),
  ('nfe-encat', 'NF-e ENCAT', 'FEDERAL', NULL),
  ('doe-sp', 'DOE-SP', 'STATE', 'SP')
) AS v(c, n, j, u)
ON CONFLICT (code) DO NOTHING;

CREATE TEMP TABLE perf_sources AS
SELECT id, code FROM sources
WHERE code IN ('dou', 'confaz', 'sped', 'cgibs', 'rfb-normas', 'nfe-encat', 'doe-sp');

-- One run per source every 3 hours over the last 90 days.
INSERT INTO collection_runs (source_id, scheduled_for, status, started_at, finished_at)
SELECT s.id, ts, 'SUCCESS', ts, ts + interval '2 minutes'
FROM perf_sources s,
     generate_series(now() - interval '90 days', now(), interval '3 hours') ts
ON CONFLICT DO NOTHING;

INSERT INTO publications (
  identity_hash, identity_strength, identity_basis, jurisdiction_level, uf,
  agency, act_type, act_number, title, published_on, first_collected_at
)
SELECT
  md5(g::text) || md5((g * 7)::text),
  'STRONG',
  '{}'::jsonb,
  CASE WHEN g % 10 = 0 THEN 'STATE' ELSE 'FEDERAL' END,
  CASE WHEN g % 10 = 0 THEN 'SP' END,
  'Órgão ' || (g % 200),
  CASE
    WHEN g % 17 = 0 THEN 'AVISO DE LICITAÇÃO'
    WHEN g % 23 = 0 THEN 'CONVÊNIO ICMS'
    WHEN g % 5 = 0 THEN 'PORTARIA'
    ELSE 'INSTRUÇÃO NORMATIVA'
  END,
  (g % 99999)::text,
  CASE
    WHEN g % 97 = 0 THEN 'Comunicado DGFIN ' || g
    ELSE 'Publicação ' || g || ' sobre tributos e obrigações acessórias'
  END,
  CASE WHEN g % 40 = 0 THEN NULL ELSE current_date - (g % 8760) END,
  now() - ((g % 2160) || ' hours')::interval
FROM generate_series(1, :n) g;

-- First origin: 10% doe-sp, ~13% spread over the other sources, rest dou.
INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, first_seen_at)
SELECT p.id, s.id, p.identity_hash, 'https://perf.invalid/' || p.identity_hash, p.first_collected_at
FROM (
  SELECT id, identity_hash, first_collected_at,
         CASE
           WHEN rn % 10 = 0 THEN 'doe-sp'
           WHEN rn % 7 = 0 THEN (ARRAY['confaz', 'sped', 'cgibs', 'rfb-normas', 'nfe-encat'])[1 + (rn % 5)::int]
           ELSE 'dou'
         END AS code
  FROM (SELECT id, identity_hash, first_collected_at, row_number() OVER () AS rn FROM publications) numbered
) p
JOIN perf_sources s ON s.code = p.code;

-- 2% of publications also appear in a second source.
INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, first_seen_at)
SELECT po.publication_id, s.id, 'x' || po.publication_id, 'https://perf.invalid/x/' || po.publication_id,
       po.first_seen_at + interval '1 hour'
FROM publication_origins po
JOIN perf_sources s ON s.code = CASE WHEN po.source_id = (SELECT id FROM perf_sources WHERE code = 'sped') THEN 'dou' ELSE 'sped' END
WHERE ('x' || po.id::text) < 'x05';

INSERT INTO publication_versions (publication_id, version_no, content_hash, content_text, relevant_excerpt)
SELECT id, 1, identity_hash,
       'Texto do ato ' || act_type || ' número ' || act_number || ' do ' || agency || '. ' || id::text,
       'Trecho relevante ' || act_type
FROM publications;

INSERT INTO collection_run_publications (collection_run_id, publication_id, disposition, detected_at)
SELECT r.id, po.publication_id, 'NEW_PUBLICATION', po.first_seen_at
FROM publication_origins po
JOIN LATERAL (
  SELECT cr.id
  FROM collection_runs cr
  WHERE cr.source_id = po.source_id
    AND cr.scheduled_for <= po.first_seen_at
  ORDER BY cr.scheduled_for DESC
  LIMIT 1
) r ON true
ON CONFLICT DO NOTHING;

VACUUM ANALYZE;
