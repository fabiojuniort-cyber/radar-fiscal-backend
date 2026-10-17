-- F2-TAB-03: canonical multi-valued CNAE ↔ Atuação membership, scoped to a
-- taxonomy release. Signed one-row-per-CNAE provenance in migration 064 is immutable.
-- Never UPDATE v1.7.0, its tags, or the F2 XLSX staging.
CREATE TABLE public.taxonomy_release_cnae_actuacao (
  release_id UUID NOT NULL REFERENCES public.taxonomy_releases(id),
  cnae_code TEXT NOT NULL CHECK (cnae_code ~ '^[0-9]{7}$'),
  release_concept_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (release_id,cnae_code,release_concept_id),
  CONSTRAINT fk_cnae_actuacao_concept FOREIGN KEY(release_concept_id,release_id)
    REFERENCES public.taxonomy_release_concepts(id,release_id)
);

CREATE INDEX ix_taxonomy_release_cnae_actuacao_concept
ON public.taxonomy_release_cnae_actuacao(release_id,release_concept_id);

CREATE TRIGGER trg_taxonomy_release_cnae_actuacao_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.taxonomy_release_cnae_actuacao
FOR EACH ROW EXECUTE FUNCTION taxonomy_guard_release_membership();

REVOKE ALL ON public.taxonomy_release_cnae_actuacao
FROM PUBLIC,radar_app,radar_worker,radar_taxonomy_curator;
GRANT SELECT ON public.taxonomy_release_cnae_actuacao TO radar_app,radar_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.taxonomy_release_cnae_actuacao
TO radar_taxonomy_curator;

-- Backfill a PREEXISTING v1.8.0 DRAFT when applying this migration.
-- Prefer edited multi-memberships when available; otherwise carry every
-- official historical v1.7.0 CNAE origin across by concept identity.
-- On databases where v1.8 has not yet been created, copyReleaseGraph does it.
INSERT INTO public.taxonomy_release_cnae_actuacao
  (release_id,cnae_code,release_concept_id)
SELECT target.id, origin.cnae_code, target_concept.id
FROM public.taxonomy_releases target
JOIN public.taxonomy_releases source
  ON source.version_major=1 AND source.version_minor=7 AND source.version_patch=0
JOIN public.taxonomy_release_actuacao_cnae_origins origin
  ON origin.release_id=source.id
JOIN public.taxonomy_release_concepts source_concept
  ON source_concept.id=origin.release_concept_id
JOIN public.taxonomy_release_concepts target_concept
  ON target_concept.release_id=target.id
 AND target_concept.concept_id=source_concept.concept_id
WHERE target.version_major=1 AND target.version_minor=8
  AND target.version_patch=0 AND target.status='DRAFT'
ON CONFLICT DO NOTHING;
