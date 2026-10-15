-- F2-DRAFT-01: dedicated curator-only staging read and idempotence ledger.
-- No published taxonomy, publication, company, tenant or matching rows are changed.
CREATE TABLE taxonomy_f2_draft_import_ledger (
  release_id UUID NOT NULL REFERENCES taxonomy_releases(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES taxonomy_f2_import_batches(id) ON DELETE RESTRICT,
  source_content_sha256 CHAR(64) NOT NULL CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  segmento_rows INTEGER NOT NULL CHECK (segmento_rows = 1332),
  produto_rows INTEGER NOT NULL CHECK (produto_rows = 4225),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, batch_id)
);
REVOKE ALL ON taxonomy_f2_draft_import_ledger
  FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT SELECT, INSERT ON taxonomy_f2_draft_import_ledger TO radar_taxonomy_curator;
-- Read-only source access is limited to the curator role; writes remain prohibited.
GRANT SELECT ON
  taxonomy_f2_import_batches,
  taxonomy_f2_import_segment_rows,
  taxonomy_f2_import_product_rows
  TO radar_taxonomy_curator;
COMMENT ON TABLE taxonomy_f2_draft_import_ledger IS
  'F2-DRAFT-01: append-only evidence of one explicit, atomic, unpublished curator draft import.';
