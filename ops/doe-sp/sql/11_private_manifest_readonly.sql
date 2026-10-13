-- DOE-SP rebuild — 11 private manifest (READ ONLY). CONTAINS IDENTIFIERS.
-- Output stays inside Railway (runner volume). Never paste into GitHub/chat.
-- One JSON line per DOE-SP publication, ordered by publication id, plus
-- checkpoint payloads. Its SHA-256 (not the content) may be published.
\set ON_ERROR_STOP 1
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif
SET LOCAL statement_timeout = '300s';
SET LOCAL lock_timeout = '2s';
\ir 00_assert_read_only.sql

WITH src AS (SELECT id FROM sources WHERE code = 'doe-sp' AND connector_key = 'doe-sp'),
doe_pub AS (
  SELECT DISTINCT po.publication_id AS id
  FROM publication_origins po JOIN src ON src.id = po.source_id
),
item_counts AS (
  SELECT ci.publication_id, count(*) AS n FROM collection_items ci JOIN doe_pub d ON d.id = ci.publication_id GROUP BY ci.publication_id
),
company_counts AS (
  SELECT cp.publication_id, count(*) AS n FROM company_publications cp JOIN doe_pub d ON d.id = cp.publication_id GROUP BY cp.publication_id
),
audit_counts AS (
  SELECT d.id AS publication_id, count(*) AS n FROM audit_log al JOIN doe_pub d ON al.entity_id = d.id::text GROUP BY d.id
)
SELECT jsonb_build_object(
  'publicationId', p.id,
  'identityHash', p.identity_hash,
  'identityStrength', p.identity_strength,
  'title', p.title,
  'publishedOn', p.published_on,
  'origins', (SELECT jsonb_agg(jsonb_build_object('id', po.id, 'sourceId', po.source_id, 'externalId', po.external_id, 'officialUrl', po.official_url, 'metadataSha256', encode(sha256(convert_to(po.metadata::text, 'UTF8')), 'hex')) ORDER BY po.id) FROM publication_origins po WHERE po.publication_id = p.id),
  'versions', (SELECT jsonb_agg(jsonb_build_object('id', pv.id, 'versionNo', pv.version_no, 'isCurrent', pv.is_current, 'contentHash', pv.content_hash, 'contentChars', COALESCE(length(pv.content_text), 0), 'contentSha256', encode(sha256(convert_to(COALESCE(pv.content_text, ''), 'UTF8')), 'hex'), 'sourceMetadataSha256', encode(sha256(convert_to(pv.source_metadata::text, 'UTF8')), 'hex'), 'files', (SELECT jsonb_agg(jsonb_build_object('id', pf.id, 'rawSha256', pf.raw_sha256, 'sizeBytes', pf.size_bytes) ORDER BY pf.id) FROM publication_files pf WHERE pf.publication_version_id = pv.id)) ORDER BY pv.version_no) FROM publication_versions pv WHERE pv.publication_id = p.id),
  'runLinks', (SELECT jsonb_agg(jsonb_build_object('runId', crp.collection_run_id, 'versionId', crp.publication_version_id, 'disposition', crp.disposition) ORDER BY crp.collection_run_id) FROM collection_run_publications crp WHERE crp.publication_id = p.id),
  'collectionItems', COALESCE(ic.n, 0),
  'companyPublications', COALESCE(cc.n, 0),
  'auditLogRefs', COALESCE(ac.n, 0)
)::text
FROM doe_pub d JOIN publications p ON p.id = d.id
LEFT JOIN item_counts ic ON ic.publication_id = p.id
LEFT JOIN company_counts cc ON cc.publication_id = p.id
LEFT JOIN audit_counts ac ON ac.publication_id = p.id
ORDER BY p.id;

SELECT jsonb_build_object(
  'checkpoint', jsonb_build_object('id', cc.id, 'generation', cc.generation, 'stateVersion', cc.state_version, 'payloadSha256', cc.payload_sha256, 'producedByRunId', cc.produced_by_run_id, 'payload', cc.payload)
)::text
FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id
WHERE s.code = 'doe-sp' AND cc.connector_key = 'doe-sp'
ORDER BY cc.generation;

SELECT to_regclass('public.norma_clara_translations') IS NOT NULL AS has_translations \gset
\if :has_translations
SELECT jsonb_build_object(
  'normaClaraTranslation', jsonb_build_object('id', t.id, 'publicationVersionId', t.publication_version_id, 'segmentHash', t.segment_hash, 'engineVersion', t.engine_version, 'textSha256', encode(sha256(convert_to(t.translation_text, 'UTF8')), 'hex'))
)::text
FROM norma_clara_translations t JOIN publication_versions pv ON pv.id = t.publication_version_id
WHERE pv.publication_id IN (SELECT po.publication_id FROM publication_origins po JOIN sources s ON s.id = po.source_id WHERE s.code = 'doe-sp' AND s.connector_key = 'doe-sp')
ORDER BY t.id;
\endif

COMMIT;
