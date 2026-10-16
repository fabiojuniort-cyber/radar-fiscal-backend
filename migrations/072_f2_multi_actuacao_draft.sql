-- F2-TAB-03: release-scoped editable multiple Atuacoes for one CNAE.
-- Immutable source provenance stays in taxonomy_release_actuacao_cnae_origins.
-- A missing override means inherit the single verified source association.
-- No data backfill or mutation to already-published v1.7.0.
CREATE TABLE public.taxonomy_release_cnae_actuacoes (
  release_id UUID NOT NULL REFERENCES public.taxonomy_releases(id),
  cnae_code TEXT NOT NULL CHECK (cnae_code ~ '^[0-9]{7}$'),
  release_actuacao_concept_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id, cnae_code, release_actuacao_concept_id),
  CONSTRAINT fk_taxonomy_cnae_actuacao_release
    FOREIGN KEY (release_actuacao_concept_id, release_id)
    REFERENCES public.taxonomy_release_concepts(id, release_id)
);
CREATE INDEX ix_taxonomy_release_cnae_actuacoes_concept
  ON public.taxonomy_release_cnae_actuacoes(release_id, release_actuacao_concept_id);
CREATE TRIGGER trg_taxonomy_cnae_actuacoes_release_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.taxonomy_release_cnae_actuacoes
FOR EACH ROW EXECUTE FUNCTION public.taxonomy_guard_release_membership();
REVOKE ALL ON public.taxonomy_release_cnae_actuacoes
  FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;
GRANT SELECT ON public.taxonomy_release_cnae_actuacoes TO radar_app, radar_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.taxonomy_release_cnae_actuacoes
  TO radar_taxonomy_curator;
