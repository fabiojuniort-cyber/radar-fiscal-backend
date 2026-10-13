-- F2-T03: auditable, administration-only projection of source suggestions.
-- No staging writes, classification changes, release publication or tenant linkage.
-- Base staging stays inaccessible to radar_app; only these four source fields,
-- tightly pinned to the two approved XLSX SHA-256 values, may be read.
--
-- IMPORTANT: this view cannot replace the official double-run in restored PG18.
-- The 066 staging writer is isolated-test-only. There may be zero production
-- rows until a separate, expressly approved production-data authorization.

CREATE VIEW taxonomy_f2_segment_suggestions_readonly
WITH (security_barrier = true) AS
SELECT
  sr.cnae_code,
  sr.atuacao,
  NULLIF(btrim(sr.raw_cells ->> 6), '') AS suggested_products,
  NULLIF(btrim(sr.raw_cells ->> 7), '') AS suggested_ncms,
  b.id AS source_batch_id,
  b.segmento_sha256 AS source_sha256
FROM taxonomy_f2_import_batches b
JOIN taxonomy_f2_import_segment_rows sr ON sr.batch_id = b.id
WHERE b.status = 'STAGED'
  AND b.segmento_sha256 = '588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd'
  AND b.produto_sha256 = '45f2594ad53bb83408fbf198f51dec8bffdf3801a053c8ffcfe544542d51b2b8'
  AND b.segmento_rows = 1332
  AND b.produto_rows = 3793
  AND b.expected_warnings = 442
  AND sr.cnae_code ~ '^[0-9]{7}$'
  -- A batch is only readable after BOTH source tables have their complete
  -- approved row counts. A partially populated batch must show nothing.
  AND (SELECT count(*) FROM taxonomy_f2_import_segment_rows s WHERE s.batch_id = b.id) = 1332
  AND (SELECT count(*) FROM taxonomy_f2_import_product_rows p WHERE p.batch_id = b.id) = 3793;

REVOKE ALL ON taxonomy_f2_segment_suggestions_readonly
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

-- Platform-admin auth gate lives in the API route; worker never needs access.
GRANT SELECT ON taxonomy_f2_segment_suggestions_readonly TO radar_app;

COMMENT ON VIEW taxonomy_f2_segment_suggestions_readonly IS
  'Administrative XLSX F2 source suggestions only; never legal NCM matches, published taxonomic links or effective tax determinations.';
