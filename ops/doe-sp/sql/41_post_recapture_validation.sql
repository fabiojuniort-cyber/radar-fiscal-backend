-- DOE-SP rebuild — 41 validation after recapture (READ ONLY, aggregates only).
-- Gate: coverage 2025-01-01..today with pendingRanges empty; then one later
-- SCHEDULED run as replay proof (0 new publications, 0 new versions).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\ir 00_assert_read_only.sql
WITH src AS (SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'),
doe_pub AS (SELECT DISTINCT po.publication_id AS id FROM publication_origins po JOIN src ON src.id = po.source_id),
cur AS (SELECT pv.* FROM publication_versions pv JOIN doe_pub d ON d.id = pv.publication_id WHERE pv.is_current),
cp AS (SELECT cc.payload FROM collection_checkpoints cc JOIN src ON src.id = cc.source_id WHERE cc.connector_key = 'doe-sp' ORDER BY cc.generation DESC LIMIT 1),
files_meta AS (SELECT cur.publication_id, f FROM cur, jsonb_array_elements(COALESCE(cur.source_metadata->'files', '[]'::jsonb)) f)
SELECT 'DOE_SP_POST_RECAPTURE=' || jsonb_build_object(
  'publications', (SELECT count(*) FROM doe_pub),
  'publicationsWithoutVersionOrOrigin', (SELECT count(*) FROM publications p WHERE NOT EXISTS (SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id)),
  'versions', (SELECT count(*) FROM publication_versions pv JOIN doe_pub d ON d.id = pv.publication_id),
  'historicalVersions', (SELECT count(*) FROM publication_versions pv JOIN doe_pub d ON d.id = pv.publication_id WHERE NOT pv.is_current),
  'contentHashV2', (SELECT count(*) FROM cur WHERE cur.source_metadata->>'contentHashVersion' = '2'),
  'htmlPrimary', (SELECT count(*) FROM cur WHERE COALESCE(length(content_text), 0) > 0),
  'pdfMaterialOnly', (SELECT count(*) FROM cur WHERE COALESCE(length(content_text), 0) = 0),
  'redundantPdfInVersion', (SELECT count(*) FROM files_meta fm JOIN cur ON cur.publication_id = fm.publication_id WHERE COALESCE(length(cur.content_text), 0) > 0 AND fm.f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF'),
  'attachmentEntries', (SELECT count(*) FROM files_meta WHERE f->'metadata'->>'kind' = 'ATTACHMENT'),
  -- An authenticated PDF kept on an origin must be that origin's own PDF.
  'crossOriginFiles', (SELECT count(*) FROM publication_origins po JOIN src ON src.id = po.source_id, jsonb_array_elements(COALESCE(po.metadata->'files', '[]'::jsonb)) f WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF' AND f->>'externalId' IS DISTINCT FROM 'auth:' || (po.metadata->>'authCode')),
  'checkpoint', (SELECT jsonb_build_object('coverageFrom', payload->'coverageFrom', 'windowEnd', payload->'windowEnd', 'pendingRanges', payload->'pendingRanges', 'deferredItems', jsonb_array_length(COALESCE(payload->'deferredItems', '[]'::jsonb))) FROM cp),
  'act_b8bec255', (SELECT jsonb_build_object('found', count(*) > 0, 'contentChars', max(length(cur.content_text))) FROM publication_origins po JOIN src ON src.id = po.source_id LEFT JOIN cur ON cur.publication_id = po.publication_id WHERE po.external_id = 'b8bec255-a9b3-44c0-1648-08dd40ce108a'),
  'activeRuns', (SELECT count(*) FROM collection_runs cr JOIN src ON src.id = cr.source_id WHERE cr.status IN ('PENDING', 'RUNNING'))
)::text;
COMMIT;
