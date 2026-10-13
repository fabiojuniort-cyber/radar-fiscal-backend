-- F2-T03: immutable, release-unpublished landing zone for the signed XLSX.
-- ZERO changes to tenants, published taxonomy or live classification.
-- Production load is prohibited until signed backup + restore rehearsal + PO OK.
CREATE TABLE taxonomy_f2_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segmento_sha256 TEXT NOT NULL CHECK (segmento_sha256 ~ '^[0-9a-f]{64}$'),
  produto_sha256 TEXT NOT NULL CHECK (produto_sha256 ~ '^[0-9a-f]{64}$'),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  segmento_rows INTEGER NOT NULL CHECK (segmento_rows = 1332),
  produto_rows INTEGER NOT NULL CHECK (produto_rows = 3793),
  expected_warnings INTEGER NOT NULL CHECK (expected_warnings = 442),
  status TEXT NOT NULL DEFAULT 'STAGED' CHECK (status = 'STAGED'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (segmento_sha256, produto_sha256)
);

CREATE TABLE taxonomy_f2_import_segment_rows (
  batch_id UUID NOT NULL REFERENCES taxonomy_f2_import_batches(id) ON DELETE RESTRICT,
  source_line INTEGER NOT NULL CHECK (source_line BETWEEN 2 AND 1333),
  cnae_code TEXT NOT NULL CHECK (cnae_code ~ '^[0-9]{7}$'),
  atuacao TEXT NOT NULL,
  raw_cells JSONB NOT NULL CHECK (jsonb_typeof(raw_cells) = 'array' AND jsonb_array_length(raw_cells) = 12),
  row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (batch_id, source_line),
  UNIQUE (batch_id, cnae_code)
);

CREATE TABLE taxonomy_f2_import_product_rows (
  batch_id UUID NOT NULL REFERENCES taxonomy_f2_import_batches(id) ON DELETE RESTRICT,
  source_line INTEGER NOT NULL CHECK (source_line BETWEEN 2 AND 3794),
  product_code TEXT NOT NULL,
  segmento TEXT NOT NULL,
  grupo TEXT NOT NULL,
  item TEXT NOT NULL,
  ncm_normalized JSONB NOT NULL CHECK (jsonb_typeof(ncm_normalized) = 'array'),
  raw_cells JSONB NOT NULL CHECK (jsonb_typeof(raw_cells) = 'array' AND jsonb_array_length(raw_cells) = 10),
  row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (batch_id, source_line),
  UNIQUE (batch_id, product_code)
);

CREATE INDEX ix_f2_stage_cnae ON taxonomy_f2_import_segment_rows(batch_id, cnae_code);
CREATE INDEX ix_f2_stage_actuacao ON taxonomy_f2_import_segment_rows(batch_id, atuacao);
CREATE INDEX ix_f2_stage_ncm ON taxonomy_f2_import_product_rows USING GIN(ncm_normalized);

-- Shared DB roles cannot mutate staged records. Only the explicitly
-- authorized migration/admin connection can write in a controlled transaction.
REVOKE ALL ON taxonomy_f2_import_batches,
  taxonomy_f2_import_segment_rows,
  taxonomy_f2_import_product_rows
  FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

COMMENT ON TABLE taxonomy_f2_import_batches IS
  'F2-T03 lossless staging only; never a published or active taxonomy release.';
