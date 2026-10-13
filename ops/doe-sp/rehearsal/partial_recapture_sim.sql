-- DOE-SP rebuild — REHEARSAL ONLY: simulate a partial recapture on a
-- temporary copy (never production). Reproduces what publication.persistence
-- does in a real run after 30: a new DOE-SP run, new origins and v1 versions
-- on preserved publication ids, changed canonical fields (title, URL,
-- last_seen_at), one brand-new publication, items, run links, a new
-- checkpoint and (if the table exists) a translation of a new version.
-- The real-code equivalent is test/doe-sp.rebuild-ops.integration.test.ts.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF current_database() !~ '^(rehearsal|doe_sp_ops_)' THEN
    RAISE EXCEPTION 'partial_recapture_sim refuses to run on database %', current_database();
  END IF;
END
$$;
BEGIN;
CREATE TEMP TABLE sim_src ON COMMIT DROP AS SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp';
CREATE TEMP TABLE sim_run ON COMMIT DROP AS SELECT gen_random_uuid() AS id;
INSERT INTO collection_runs (id, source_id, scheduled_for, trigger_type, status, started_at, finished_at)
SELECT r.id, s.id, now(), 'SCHEDULED', 'PARTIAL_SUCCESS', now(), now() FROM sim_run r, sim_src s;

-- two preserved publications (no versions/origins after 30) are recaptured
CREATE TEMP TABLE sim_pub ON COMMIT DROP AS
  SELECT p.id, gen_random_uuid() AS version_id, row_number() OVER (ORDER BY p.id) AS n
  FROM publications p
  WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM publication_versions pv WHERE pv.publication_id = p.id)
  ORDER BY p.id LIMIT 2;
UPDATE publications p SET title = p.title || ' [recaptura]', primary_official_url = 'https://doe.sp.gov.br/sim/' || p.id,
  effective_on = COALESCE(p.effective_on, DATE '2026-01-01'), last_seen_at = now(), updated_at = now()
FROM sim_pub s WHERE s.id = p.id;
INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, metadata)
SELECT s.id, src.id, 'sim-' || s.id, 'https://doe.sp.gov.br/sim/' || s.id, '{"contentHashVersion":2}' FROM sim_pub s, sim_src src;
INSERT INTO publication_versions (id, publication_id, version_no, content_hash, content_text, source_metadata, is_current)
SELECT s.version_id, s.id, 1, encode(sha256(convert_to('sim' || s.id, 'UTF8')), 'hex'), 'texto recapturado', '{"contentHashVersion":2}', true FROM sim_pub s;
INSERT INTO collection_run_publications (collection_run_id, publication_id, publication_version_id, disposition)
SELECT r.id, s.id, s.version_id, 'NEW_VERSION' FROM sim_pub s, sim_run r;
INSERT INTO collection_items (collection_run_id, source_item_key, external_id, status, publication_id)
SELECT r.id, 'sim-' || s.id, 'sim-' || s.id, 'NEW_VERSION', s.id FROM sim_pub s, sim_run r;

-- one brand-new publication
CREATE TEMP TABLE sim_new ON COMMIT DROP AS SELECT gen_random_uuid() AS id, gen_random_uuid() AS version_id;
INSERT INTO publications (id, identity_hash, identity_strength, identity_basis, jurisdiction_level, uf, title, published_on)
SELECT n.id, encode(sha256(convert_to('sim-new' || n.id, 'UTF8')), 'hex'), 'SOURCE_SCOPED', '{}', 'STATE', 'SP', 'ATO NOVO NA RECAPTURA', DATE '2025-01-02' FROM sim_new n;
INSERT INTO publication_origins (publication_id, source_id, external_id, official_url, metadata)
SELECT n.id, src.id, 'sim-new-' || n.id, 'https://doe.sp.gov.br/sim-new/' || n.id, '{}' FROM sim_new n, sim_src src;
INSERT INTO publication_versions (id, publication_id, version_no, content_hash, content_text, source_metadata, is_current)
SELECT n.version_id, n.id, 1, encode(sha256(convert_to('sim-new-v' || n.id, 'UTF8')), 'hex'), 'ato novo', '{"contentHashVersion":2}', true FROM sim_new n;
INSERT INTO collection_run_publications (collection_run_id, publication_id, publication_version_id, disposition)
SELECT r.id, n.id, n.version_id, 'NEW_PUBLICATION' FROM sim_new n, sim_run r;
INSERT INTO collection_items (collection_run_id, source_item_key, external_id, status, publication_id)
SELECT r.id, 'sim-new-' || n.id, 'sim-new-' || n.id, 'PROCESSED_NEW', n.id FROM sim_new n, sim_run r;

-- new checkpoint generation (bootstrap cursor mid-way)
INSERT INTO collection_checkpoints (source_id, connector_key, state_version, generation, payload, payload_sha256, payload_bytes, produced_by_run_id)
SELECT src.id, 'doe-sp', 1, 1, '{"coverageFrom":"2025-01-01","pendingRanges":[{"from":"2025-03-01","to":"2026-09-24"}],"days":{}}',
  repeat('a', 64), 80, r.id FROM sim_src src, sim_run r;
COMMIT;

SELECT to_regclass('public.norma_clara_translations') IS NOT NULL AS sim_has_translations \gset
\if :sim_has_translations
INSERT INTO norma_clara_translations (publication_version_id, segment_hash, engine_version, model, translation_text)
SELECT pv.id, repeat('b', 64), 'sim', 'sim', 'traducao gerada na janela'
FROM publication_versions pv JOIN publication_origins po ON po.publication_id = pv.publication_id
JOIN sources s ON s.id = po.source_id AND s.code = 'doe-sp' LIMIT 1;
\endif
SELECT 'DOE_SP_SIM_RECAPTURE=' || jsonb_build_object('runs', 1, 'recapturedPreserved', 2, 'newPublications', 1)::text;
