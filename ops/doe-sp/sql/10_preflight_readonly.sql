-- DOE-SP rebuild — 10 preflight (READ ONLY, aggregates only, safe to publish).
-- Run: psql -v ON_ERROR_STOP=1 -X -q -t -A -f 10_preflight_readonly.sql
-- Output: one line `DOE_SP_PREFLIGHT=<json>` with counts only (no ids/urls/titles).
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';
\ir 00_assert_read_only.sql

WITH src AS (
  SELECT id, is_active, schedule_cron IS NOT NULL AS has_schedule
  FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'
),
doe_pub AS (
  SELECT DISTINCT po.publication_id AS id
  FROM publication_origins po JOIN src ON src.id = po.source_id
),
shared_pub AS (
  SELECT DISTINCT po.publication_id AS id
  FROM publication_origins po
  JOIN doe_pub d ON d.id = po.publication_id
  JOIN src ON true
  WHERE po.source_id <> src.id
),
ver AS (
  SELECT pv.* FROM publication_versions pv JOIN doe_pub d ON d.id = pv.publication_id
),
cur AS (SELECT * FROM ver WHERE is_current),
files_meta AS (
  SELECT f
  FROM cur, jsonb_array_elements(COALESCE(cur.source_metadata->'files', '[]'::jsonb)) f
),
fk AS (
  SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref, conname
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN ('publications'::regclass, 'publication_versions'::regclass, 'company_publications'::regclass)
)
SELECT 'DOE_SP_PREFLIGHT=' || jsonb_build_object(
  'capturedAt', now(),
  'serverVersion', current_setting('server_version_num')::int,
  'transactionReadOnly', current_setting('transaction_read_only'),
  'source', (SELECT jsonb_build_object('found', count(*) = 1, 'isActive', bool_and(is_active), 'hasSchedule', bool_and(has_schedule)) FROM src),
  'publications', (SELECT count(*) FROM doe_pub),
  'sharedWithOtherSources', (SELECT count(*) FROM shared_pub),
  'doeSpOrigins', (SELECT count(*) FROM publication_origins po JOIN src ON src.id = po.source_id),
  'otherSourceOriginsOnDoeSpPublications', (SELECT count(*) FROM publication_origins po JOIN doe_pub d ON d.id = po.publication_id JOIN src ON po.source_id <> src.id),
  'versions', (SELECT count(*) FROM ver),
  'currentVersions', (SELECT count(*) FROM cur),
  'historicalVersions', (SELECT count(*) FROM ver WHERE NOT is_current),
  'publicationsWithoutCurrentVersion', (SELECT count(*) FROM doe_pub d WHERE NOT EXISTS (SELECT 1 FROM cur WHERE cur.publication_id = d.id)),
  'emptyTextCurrentVersions', (SELECT count(*) FROM cur WHERE COALESCE(length(content_text), 0) = 0),
  'contentChars', (SELECT COALESCE(sum(length(content_text)), 0) FROM cur),
  'contentHashV2Versions', (SELECT count(*) FROM ver WHERE source_metadata->>'contentHashVersion' = '2'),
  'versionFileEntries', (SELECT count(*) FROM files_meta),
  'authenticatedPdfEntries', (SELECT count(*) FROM files_meta WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF'),
  'attachmentEntries', (SELECT count(*) FROM files_meta WHERE f->'metadata'->>'kind' = 'ATTACHMENT'),
  'publicationFiles', (SELECT count(*) FROM publication_files pf JOIN ver ON ver.id = pf.publication_version_id),
  'crossOriginFiles', (SELECT count(*) FROM publication_origins po JOIN src ON src.id = po.source_id, jsonb_array_elements(COALESCE(po.metadata->'files', '[]'::jsonb)) f WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF' AND f->>'externalId' IS DISTINCT FROM 'auth:' || (po.metadata->>'authCode')),
  -- Prototype-owned cache (tribusca-site-prototype), FK ON DELETE CASCADE to publication_versions.
  'normaClaraTranslations', CASE WHEN to_regclass('public.norma_clara_translations') IS NULL THEN 0 ELSE
    (xpath('/row/c/text()', query_to_xml(
      'SELECT count(*) AS c FROM norma_clara_translations t WHERE t.publication_version_id IN (
         SELECT pv.id FROM publication_versions pv WHERE pv.publication_id IN (
           SELECT po.publication_id FROM publication_origins po JOIN sources s ON s.id = po.source_id
           WHERE s.code = ''doe-sp'' AND s.connector_key = ''doe-sp''))',
      false, true, '')))[1]::text::bigint END,
  'companyPublications', (SELECT count(*) FROM company_publications cp JOIN doe_pub d ON d.id = cp.publication_id),
  'tenantsLinked', (SELECT count(DISTINCT c.tenant_id) FROM company_publications cp JOIN doe_pub d ON d.id = cp.publication_id JOIN companies c ON c.id = cp.company_id),
  'publicationMatches', (SELECT count(*) FROM publication_matches pm JOIN company_publications cp ON cp.id = pm.company_publication_id JOIN doe_pub d ON d.id = cp.publication_id),
  'collectionItemsLinked', (SELECT count(*) FROM collection_items ci JOIN doe_pub d ON d.id = ci.publication_id),
  'collectionItemsLinkedFromForeignRuns', (SELECT count(*) FROM collection_items ci JOIN doe_pub d ON d.id = ci.publication_id JOIN collection_runs cr ON cr.id = ci.collection_run_id JOIN src ON cr.source_id <> src.id),
  'runPublicationLinks', (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id),
  'runPublicationLinksFromForeignRuns', (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id JOIN collection_runs cr ON cr.id = crp.collection_run_id JOIN src ON cr.source_id <> src.id),
  'runPublicationLinksWithVersion', (SELECT count(*) FROM collection_run_publications crp JOIN doe_pub d ON d.id = crp.publication_id WHERE crp.publication_version_id IS NOT NULL),
  'auditLogEntityRefs', (SELECT count(*) FROM audit_log al JOIN doe_pub d ON al.entity_id = d.id::text),
  'runs', (SELECT jsonb_object_agg(status, n) FROM (SELECT cr.status, count(*) n FROM collection_runs cr JOIN src ON src.id = cr.source_id GROUP BY cr.status) s),
  'activeRuns', (SELECT count(*) FROM collection_runs cr JOIN src ON src.id = cr.source_id WHERE cr.status IN ('PENDING', 'RUNNING')),
  'checkpoints', (SELECT count(*) FROM collection_checkpoints cc JOIN src ON src.id = cc.source_id WHERE cc.connector_key = 'doe-sp'),
  'checkpointLatest', (
    SELECT jsonb_build_object(
      'generation', cc.generation,
      'coverageFrom', cc.payload->'coverageFrom',
      'windowEnd', cc.payload->'windowEnd',
      'pendingRanges', jsonb_array_length(COALESCE(cc.payload->'pendingRanges', '[]'::jsonb)),
      'firstPendingDate', cc.payload->'pendingRanges'->0->'from',
      'deferredItems', jsonb_array_length(COALESCE(cc.payload->'deferredItems', '[]'::jsonb)))
    FROM collection_checkpoints cc JOIN src ON src.id = cc.source_id
    WHERE cc.connector_key = 'doe-sp' ORDER BY cc.generation DESC LIMIT 1),
  'act_b8bec255', (
    SELECT jsonb_build_object(
      'originFound', count(*) > 0,
      'currentVersionChars', max(length(cur.content_text)),
      'authenticatedPdfEntries', max((SELECT count(*) FROM jsonb_array_elements(COALESCE(cur.source_metadata->'files', '[]'::jsonb)) f WHERE f->'metadata'->>'kind' = 'AUTHENTICATED_PUBLICATION_PDF')))
    FROM publication_origins po JOIN src ON src.id = po.source_id
    LEFT JOIN cur ON cur.publication_id = po.publication_id
    WHERE po.external_id = 'b8bec255-a9b3-44c0-1648-08dd40ce108a'),
  'foreignKeysToScope', (SELECT jsonb_agg(tbl || '.' || conname || '->' || ref ORDER BY tbl, conname) FROM fk),
  'global', jsonb_build_object(
    'publications', (SELECT count(*) FROM publications),
    'publicationOrigins', (SELECT count(*) FROM publication_origins),
    'publicationVersions', (SELECT count(*) FROM publication_versions),
    'publicationFiles', (SELECT count(*) FROM publication_files),
    'collectionRuns', (SELECT count(*) FROM collection_runs),
    'collectionItems', (SELECT count(*) FROM collection_items),
    'collectionRunPublications', (SELECT count(*) FROM collection_run_publications),
    'collectionCheckpoints', (SELECT count(*) FROM collection_checkpoints),
    'companyPublications', (SELECT count(*) FROM company_publications),
    'publicationMatches', (SELECT count(*) FROM publication_matches),
    'auditLog', (SELECT count(*) FROM audit_log),
    'sources', (SELECT count(*) FROM sources))
)::text;

COMMIT;
