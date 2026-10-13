-- F2-T03 v5.1 (Segmento) + v5 (Produto). Correct the obsolete checks of 066
-- without rewriting applied migrations or touching historical staging rows.
-- Only staged source suggestions are readable. Zero changes to live taxonomy.
-- DO NOT run production load: staging writer is isolated-test-only.
ALTER TABLE taxonomy_f2_import_batches
  DROP CONSTRAINT IF EXISTS taxonomy_f2_import_batches_produto_rows_check;
ALTER TABLE taxonomy_f2_import_batches
  ADD CONSTRAINT taxonomy_f2_import_batches_produto_rows_check
  CHECK (produto_rows > 0);

-- Warnings are diagnostic, not a source-approval gate. Preserve the field
-- for auditing actual per-batch counts, rather than a pinned 442/448 value.
ALTER TABLE taxonomy_f2_import_batches
  DROP CONSTRAINT IF EXISTS taxonomy_f2_import_batches_expected_warnings_check;
ALTER TABLE taxonomy_f2_import_batches
  ADD CONSTRAINT taxonomy_f2_import_batches_expected_warnings_check
  CHECK (expected_warnings >= 0);

ALTER TABLE taxonomy_f2_import_product_rows
  DROP CONSTRAINT IF EXISTS taxonomy_f2_import_product_rows_source_line_check;
ALTER TABLE taxonomy_f2_import_product_rows
  ADD CONSTRAINT taxonomy_f2_import_product_rows_source_line_check
  CHECK (source_line >= 2);

-- Security-barrier view keeps one exact approved pair; v1.7.x/v5 history
-- remains in DB (if present), but is not exposed to the administrative UI.
CREATE OR REPLACE VIEW taxonomy_f2_segment_suggestions_readonly
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
  AND b.segmento_sha256 = '695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67'
  AND b.produto_sha256 = '261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a'
  AND b.segmento_rows = 1332
  AND b.produto_rows = 4225
  AND sr.cnae_code ~ '^[0-9]{7}$'
  AND (SELECT count(*) FROM taxonomy_f2_import_segment_rows s WHERE s.batch_id = b.id) = b.segmento_rows
  AND (SELECT count(*) FROM taxonomy_f2_import_product_rows p WHERE p.batch_id = b.id) = b.produto_rows;

REVOKE ALL ON taxonomy_f2_segment_suggestions_readonly
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT SELECT ON taxonomy_f2_segment_suggestions_readonly TO radar_app;

COMMENT ON VIEW taxonomy_f2_segment_suggestions_readonly IS
  'F2 v5.1 Segmento/v5 Produto source suggestions only; not a published taxonomy, tax incidence or legal NCM match.';
