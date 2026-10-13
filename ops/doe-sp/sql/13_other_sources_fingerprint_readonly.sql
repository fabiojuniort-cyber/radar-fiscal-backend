-- DOE-SP rebuild — 13 fingerprint of everything OUTSIDE the DOE-SP scope
-- (READ ONLY, one SHA-256; safe to publish). Equal before/after a step proves
-- that step did not touch other sources, tenants, matches or their caches.
--
-- The fingerprint is compared ACROSS servers (production vs. the runner's
-- temporary PostgreSQL, initdb --locale=C.UTF-8), so it must not depend on
-- server settings: parts are ordered by byte (COLLATE "C"; en_US.utf8 ignores
-- punctuation and orders 'run:' and 'run-link:' parts differently) and
-- row_to_json renders timestamptz in UTC.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '300s';
SET LOCAL TimeZone = 'UTC';
\ir 00_assert_read_only.sql

SELECT to_regclass('public.norma_clara_translations') IS NOT NULL AS has_translations \gset

WITH doe_sp_fp_src AS (SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'),
doe_sp_fp_pub AS (
  SELECT DISTINCT po.publication_id AS id FROM publication_origins po WHERE po.source_id IS DISTINCT FROM (SELECT id FROM doe_sp_fp_src)),
doe_sp_fp_runs AS (
  SELECT id FROM collection_runs WHERE source_id IS DISTINCT FROM (SELECT id FROM doe_sp_fp_src))
SELECT 'DOE_SP_OTHER_SOURCES_FINGERPRINT=' || encode(sha256(convert_to(COALESCE(string_agg(part, E'\n' ORDER BY part COLLATE "C"), ''), 'UTF8')), 'hex')
FROM (
  SELECT 'source:' || md5(row_to_json(s)::text) AS part FROM sources s WHERE s.id IS DISTINCT FROM (SELECT id FROM doe_sp_fp_src)
  UNION ALL SELECT 'origin:' || md5(row_to_json(po)::text) FROM publication_origins po WHERE po.source_id IS DISTINCT FROM (SELECT id FROM doe_sp_fp_src)
  UNION ALL SELECT 'publication:' || md5(row_to_json(p)::text) FROM publications p JOIN doe_sp_fp_pub d ON d.id = p.id
  UNION ALL SELECT 'orphan-publication:' || p.id FROM publications p WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)
  UNION ALL SELECT 'version:' || md5(pv.id::text || pv.content_hash || pv.is_current::text || pv.version_no::text || pv.source_metadata::text || COALESCE(md5(pv.content_text), '')) FROM publication_versions pv JOIN doe_sp_fp_pub d ON d.id = pv.publication_id
  UNION ALL SELECT 'file:' || md5(row_to_json(pf)::text) FROM publication_files pf JOIN publication_versions pv ON pv.id = pf.publication_version_id JOIN doe_sp_fp_pub d ON d.id = pv.publication_id
  UNION ALL SELECT 'run:' || md5(row_to_json(cr)::text) FROM collection_runs cr JOIN doe_sp_fp_runs r ON r.id = cr.id
  UNION ALL SELECT 'item:' || md5(row_to_json(ci)::text) FROM collection_items ci JOIN doe_sp_fp_runs r ON r.id = ci.collection_run_id
  UNION ALL SELECT 'run-link:' || md5(row_to_json(crp)::text) FROM collection_run_publications crp JOIN doe_sp_fp_runs r ON r.id = crp.collection_run_id
  UNION ALL SELECT 'checkpoint:' || md5(row_to_json(cc)::text) FROM collection_checkpoints cc WHERE cc.source_id IS DISTINCT FROM (SELECT id FROM doe_sp_fp_src)
  UNION ALL SELECT 'company-publication:' || md5(row_to_json(cp)::text) FROM company_publications cp
  UNION ALL SELECT 'match:' || md5(row_to_json(pm)::text) FROM publication_matches pm
  UNION ALL SELECT 'audit:' || md5(row_to_json(al)::text) FROM audit_log al
) parts;

\if :has_translations
WITH doe_sp_fp_src AS (SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp')
SELECT 'DOE_SP_OTHER_TRANSLATIONS_FINGERPRINT=' || COALESCE(encode(sha256(convert_to(string_agg(md5(row_to_json(t)::text), E'\n' ORDER BY t.id), 'UTF8')), 'hex'), 'none')
FROM norma_clara_translations t JOIN publication_versions pv ON pv.id = t.publication_version_id
WHERE pv.publication_id NOT IN (SELECT po.publication_id FROM publication_origins po WHERE po.source_id IS NOT DISTINCT FROM (SELECT id FROM doe_sp_fp_src));
\endif

COMMIT;
