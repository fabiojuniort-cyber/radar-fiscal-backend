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
  'collectionItems', (SELECT count(*) FROM collection_items ci WHERE ci.publication_id = p.id),
  'companyPublications', (SELECT count(*) FROM company_publications cp WHERE cp.publication_id = p.id),
  'auditLogRefs', (SELECT count(*) FROM audit_log al WHERE al.entity_id = p.id::text)
)::text
FROM doe_pub d JOIN publications p ON p.id = d.id
ORDER BY p.id;

SELECT jsonb_build_object(
  'checkpoint', jsonb_build_object('id', cc.id, 'generation', cc.generation, 'stateVersion', cc.state_version, 'payloadSha256', cc.payload_sha256, 'producedByRunId', cc.produced_by_run_id, 'payload', cc.payload)
)::text
FROM collection_checkpoints cc JOIN sources s ON s.id = cc.source_id
WHERE s.code = 'doe-sp' AND cc.connector_key = 'doe-sp'
ORDER BY cc.generation;

COMMIT;
