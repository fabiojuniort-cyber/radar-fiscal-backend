-- F2-T02: release-scoped, auditable CNAE origin of each Atuação concept.
-- Do not attach these rows to tenants or treat them as legal determinations.
-- No automatic load: the curator must provide the exact signed source projection.

CREATE TABLE taxonomy_release_actuacao_cnae_origins (
  release_id UUID NOT NULL REFERENCES taxonomy_releases(id),
  release_concept_id UUID NOT NULL,
  cnae_code TEXT NOT NULL CHECK (cnae_code ~ '^[0-9]{7}$'),
  source_line INTEGER NOT NULL CHECK (source_line BETWEEN 2 AND 1333),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, cnae_code),
  CONSTRAINT uq_taxonomy_actuacao_origin_line UNIQUE (release_id, source_line),
  CONSTRAINT fk_taxonomy_actuacao_origin_concept
    FOREIGN KEY (release_concept_id, release_id)
    REFERENCES taxonomy_release_concepts (id, release_id)
);

CREATE INDEX ix_taxonomy_actuacao_origin_concept
  ON taxonomy_release_actuacao_cnae_origins(release_id, release_concept_id);

CREATE TRIGGER trg_taxonomy_actuacao_origins_release_guard
BEFORE INSERT OR UPDATE OR DELETE
ON taxonomy_release_actuacao_cnae_origins
FOR EACH ROW EXECUTE FUNCTION taxonomy_guard_release_membership();

REVOKE ALL ON taxonomy_release_actuacao_cnae_origins
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON taxonomy_release_actuacao_cnae_origins
TO radar_app, radar_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON taxonomy_release_actuacao_cnae_origins
TO radar_taxonomy_curator;
