-- F2-TAB-02 B1: curated suggestions belong to one taxonomy release.
-- NULL = no curator override; empty array = curator intentionally cleared values.
-- Staging XLSX and previously published releases remain immutable.
ALTER TABLE public.taxonomy_release_concepts
  ADD COLUMN f2_suggested_products TEXT[],
  ADD COLUMN f2_suggested_ncms TEXT[];

ALTER TABLE public.taxonomy_release_concepts
  ADD CONSTRAINT chk_f2_suggestions_maximum
    CHECK (
      (f2_suggested_products IS NULL OR cardinality(f2_suggested_products) <= 100)
      AND (f2_suggested_ncms IS NULL OR cardinality(f2_suggested_ncms) <= 100)
    );
