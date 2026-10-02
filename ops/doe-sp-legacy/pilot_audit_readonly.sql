-- DOE-SP legacy archive — pilot audit (READ ONLY). Issue #20.
-- Run with PGOPTIONS='-c default_transaction_read_only=on'. Prints public
-- data only (titles are "Diário Oficial ... — página N", links are the public
-- viewer); never the page text.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
DO $$ BEGIN IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'not read only'; END IF; END $$;

SELECT 'LEGACY_PILOT_SOURCE=' || jsonb_build_object(
  'id', s.id, 'active', s.is_active, 'schedule', s.schedule_cron, 'connector', s.connector_key)::text
FROM sources s WHERE s.code = 'doe-sp-legado';

-- Runs of the source: status and the connector's counters.
SELECT 'LEGACY_PILOT_RUN=' || jsonb_build_object(
  'id', cr.id, 'status', cr.status, 'trigger', cr.trigger_type, 'created', cr.created_at, 'finished', cr.finished_at,
  'attempts', (SELECT jsonb_agg(jsonb_build_object('status', ca.status, 'error', ca.error_code,
      'completion', ca.metadata->'completion',
      'publications', ca.metadata->'publicationCount',
      'legacy', ca.metadata->'doeSpLegacy') ORDER BY ca.attempt_no)
    FROM collection_attempts ca WHERE ca.collection_run_id = cr.id))::text
FROM collection_runs cr JOIN sources s ON s.id = cr.source_id
WHERE s.code = 'doe-sp-legado' ORDER BY cr.created_at;

-- Current checkpoint (browse/search cursors, pending pages, listing in progress, OCR queue).
SELECT 'LEGACY_PILOT_CHECKPOINT=' || jsonb_build_object(
  'generation', cc.generation, 'version', cc.state_version,
  'cursor', cc.payload::jsonb->'cursor',
  'searchCursor', cc.payload::jsonb->'searchCursor',
  'pending', jsonb_array_length(coalesce(cc.payload::jsonb->'pending', '[]')),
  'retry', jsonb_array_length(coalesce(cc.payload::jsonb->'retry', '[]')),
  'listing', cc.payload::jsonb->'listing' IS NOT NULL AND cc.payload::jsonb->'listing' <> 'null'::jsonb,
  'needsOcr', jsonb_array_length(coalesce(cc.payload::jsonb->'needsOcr', '[]')),
  'totals', cc.payload::jsonb->'totals')::text
FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id
WHERE s.code = 'doe-sp-legado' AND cc.connector_key = 'doe-sp-legacy'
ORDER BY cc.generation DESC LIMIT 1;

-- Persisted pages: aggregates.
SELECT 'LEGACY_PILOT_PAGES=' || jsonb_build_object(
  'publications', count(DISTINCT p.id),
  'versions', count(pv.id),
  'byExtraction', (SELECT jsonb_object_agg(k, n) FROM (
      SELECT pv2.source_metadata->>'textExtraction' AS k, count(*) AS n
      FROM publication_versions pv2 JOIN publication_origins po2 ON po2.publication_id = pv2.publication_id
      JOIN sources s2 ON s2.id = po2.source_id WHERE s2.code = 'doe-sp-legado' GROUP BY 1) x),
  'avgChars', round(avg(length(pv.content_text))),
  'minChars', min(length(pv.content_text)),
  -- Decision of 2026-09-29: the PDF is never stored (publication_files must stay empty).
  'storedFiles', (SELECT count(*) FROM publication_files pf
      JOIN publication_versions pvf ON pvf.id = pf.publication_version_id
      WHERE EXISTS (SELECT 1 FROM publication_origins pof JOIN sources sf ON sf.id = pof.source_id
        WHERE pof.publication_id = pvf.publication_id AND sf.code = 'doe-sp-legado')),
  'withoutOfficialUrl', count(*) FILTER (WHERE p.primary_official_url IS NULL))::text
FROM publications p
JOIN publication_origins po ON po.publication_id = p.id
JOIN sources s ON s.id = po.source_id
LEFT JOIN publication_versions pv ON pv.publication_id = p.id
WHERE s.code = 'doe-sp-legado';

-- Sample for the human audit (public link + matched terms).
SELECT 'LEGACY_PILOT_SAMPLE=' || jsonb_build_object(
  'title', p.title, 'viewer', p.primary_official_url,
  'terms', pv.source_metadata->'matchedTaxTerms',
  'extraction', pv.source_metadata->>'textExtraction', 'chars', length(pv.content_text))::text
FROM publications p
JOIN publication_origins po ON po.publication_id = p.id
JOIN sources s ON s.id = po.source_id
JOIN publication_versions pv ON pv.publication_id = p.id AND pv.is_current
WHERE s.code = 'doe-sp-legado'
ORDER BY p.published_on, p.title LIMIT 60;
COMMIT;
