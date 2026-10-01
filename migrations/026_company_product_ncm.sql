-- PROFILE-01 / 026
-- Private company product context + global publication NCM mentions.
-- Sector/product identities reuse the versioned TriBusca taxonomy.
-- NCM reference data reuses official_catalogs/official_catalog_entries.

CREATE TABLE company_product_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,
    cnae_code CHAR(7)
        REFERENCES cnaes(code),
    taxonomy_release_id UUID
        REFERENCES taxonomy_releases(id)
        ON DELETE RESTRICT,
    sector_release_concept_id UUID,
    product_release_concept_id UUID,
    product_label TEXT NOT NULL
        CHECK (btrim(product_label) <> ''),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_company_product_sector_release
        FOREIGN KEY (
            sector_release_concept_id,
            taxonomy_release_id
        )
        REFERENCES taxonomy_release_concepts(id, release_id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_company_product_product_release
        FOREIGN KEY (
            product_release_concept_id,
            taxonomy_release_id
        )
        REFERENCES taxonomy_release_concepts(id, release_id)
        ON DELETE RESTRICT,
    CONSTRAINT chk_company_product_taxonomy_release
        CHECK (
            taxonomy_release_id IS NOT NULL
            OR (
                sector_release_concept_id IS NULL
                AND product_release_concept_id IS NULL
            )
        )
);

CREATE UNIQUE INDEX uq_company_product_profile_active
ON company_product_profiles(
    company_id,
    COALESCE(cnae_code::text, ''),
    lower(btrim(product_label))
)
WHERE is_active = TRUE;

CREATE INDEX ix_company_product_profiles_company
ON company_product_profiles(company_id, is_active);

CREATE INDEX ix_company_product_profiles_cnae
ON company_product_profiles(company_id, cnae_code)
WHERE cnae_code IS NOT NULL AND is_active = TRUE;

CREATE TRIGGER trg_company_product_profiles_updated_at
BEFORE UPDATE ON company_product_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_company_product_taxonomy_dimensions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    dimension_code TEXT;
BEGIN
    IF NEW.sector_release_concept_id IS NOT NULL THEN
        SELECT d.code
        INTO dimension_code
        FROM taxonomy_release_concepts rc
        JOIN taxonomy_concepts c
          ON c.id = rc.concept_id
        JOIN taxonomy_dimensions d
          ON d.id = c.dimension_id
        WHERE rc.id = NEW.sector_release_concept_id
          AND rc.release_id = NEW.taxonomy_release_id;

        IF dimension_code IS DISTINCT FROM 'sector' THEN
            RAISE EXCEPTION
                'sector_release_concept_id must belong to taxonomy dimension sector';
        END IF;
    END IF;

    IF NEW.product_release_concept_id IS NOT NULL THEN
        SELECT d.code
        INTO dimension_code
        FROM taxonomy_release_concepts rc
        JOIN taxonomy_concepts c
          ON c.id = rc.concept_id
        JOIN taxonomy_dimensions d
          ON d.id = c.dimension_id
        WHERE rc.id = NEW.product_release_concept_id
          AND rc.release_id = NEW.taxonomy_release_id;

        IF dimension_code IS DISTINCT FROM 'product' THEN
            RAISE EXCEPTION
                'product_release_concept_id must belong to taxonomy dimension product';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_company_product_taxonomy_dimensions
BEFORE INSERT OR UPDATE OF
    taxonomy_release_id,
    sector_release_concept_id,
    product_release_concept_id
ON company_product_profiles
FOR EACH ROW
EXECUTE FUNCTION validate_company_product_taxonomy_dimensions();

CREATE TABLE company_product_ncms (
    company_product_profile_id UUID NOT NULL
        REFERENCES company_product_profiles(id)
        ON DELETE CASCADE,
    official_catalog_entry_id UUID NOT NULL
        REFERENCES official_catalog_entries(id)
        ON DELETE RESTRICT,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    assignment_source TEXT NOT NULL DEFAULT 'MANUAL'
        CHECK (assignment_source IN ('MANUAL', 'IMPORT', 'MATCHED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (
        company_product_profile_id,
        official_catalog_entry_id
    )
);

CREATE UNIQUE INDEX uq_company_product_primary_ncm
ON company_product_ncms(company_product_profile_id)
WHERE is_primary = TRUE;

CREATE INDEX ix_company_product_ncms_entry
ON company_product_ncms(official_catalog_entry_id);

CREATE OR REPLACE FUNCTION validate_ncm_catalog_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    catalog_code TEXT;
BEGIN
    SELECT c.code
    INTO catalog_code
    FROM official_catalog_entries e
    JOIN official_catalog_editions ed
      ON ed.id = e.catalog_edition_id
    JOIN official_catalogs c
      ON c.id = ed.catalog_id
    WHERE e.id = NEW.official_catalog_entry_id;

    IF catalog_code IS DISTINCT FROM 'NCM' THEN
        RAISE EXCEPTION
            'official_catalog_entry_id must belong to catalog NCM';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_company_product_ncm_catalog
BEFORE INSERT OR UPDATE OF official_catalog_entry_id
ON company_product_ncms
FOR EACH ROW
EXECUTE FUNCTION validate_ncm_catalog_entry();

CREATE TABLE publication_ncm_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    publication_version_id UUID NOT NULL
        REFERENCES publication_versions(id)
        ON DELETE RESTRICT,
    ncm_code CHAR(8) NOT NULL
        CHECK (ncm_code ~ '^[0-9]{8}$'),
    official_catalog_entry_id UUID
        REFERENCES official_catalog_entries(id)
        ON DELETE RESTRICT,
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
        CHECK (
            verification_status IN (
                'UNVERIFIED',
                'CATALOG_MATCHED',
                'REJECTED'
            )
        ),
    method_type TEXT NOT NULL
        CHECK (
            method_type IN (
                'RULE',
                'EXTRACTOR',
                'MODEL',
                'HUMAN',
                'HYBRID'
            )
        ),
    detector_key TEXT NOT NULL
        CHECK (btrim(detector_key) <> ''),
    detector_version TEXT NOT NULL
        CHECK (btrim(detector_version) <> ''),
    confidence NUMERIC(6,5)
        CHECK (
            confidence IS NULL
            OR (confidence >= 0 AND confidence <= 1)
        ),
    span_start INTEGER
        CHECK (span_start IS NULL OR span_start >= 0),
    span_end INTEGER
        CHECK (span_end IS NULL OR span_end >= 0),
    excerpt TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_publication_ncm_detector
        UNIQUE (
            publication_version_id,
            ncm_code,
            detector_key,
            detector_version
        ),
    CONSTRAINT chk_publication_ncm_span
        CHECK (
            (span_start IS NULL AND span_end IS NULL)
            OR (
                span_start IS NOT NULL
                AND span_end IS NOT NULL
                AND span_end > span_start
            )
        ),
    CONSTRAINT chk_publication_ncm_metadata
        CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT chk_publication_ncm_catalog_status
        CHECK (
            official_catalog_entry_id IS NULL
            OR verification_status = 'CATALOG_MATCHED'
        )
);

CREATE INDEX ix_publication_ncm_mentions_version
ON publication_ncm_mentions(publication_version_id);

CREATE INDEX ix_publication_ncm_mentions_code
ON publication_ncm_mentions(ncm_code, publication_version_id);

CREATE INDEX ix_publication_ncm_mentions_catalog_entry
ON publication_ncm_mentions(official_catalog_entry_id)
WHERE official_catalog_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_publication_ncm_catalog_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    catalog_code TEXT;
    entry_code TEXT;
BEGIN
    IF NEW.official_catalog_entry_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.code, e.official_code
    INTO catalog_code, entry_code
    FROM official_catalog_entries e
    JOIN official_catalog_editions ed
      ON ed.id = e.catalog_edition_id
    JOIN official_catalogs c
      ON c.id = ed.catalog_id
    WHERE e.id = NEW.official_catalog_entry_id;

    IF catalog_code IS DISTINCT FROM 'NCM' THEN
        RAISE EXCEPTION
            'publication NCM catalog entry must belong to catalog NCM';
    END IF;

    IF regexp_replace(entry_code, '[^0-9]', '', 'g') IS DISTINCT FROM NEW.ncm_code::text THEN
        RAISE EXCEPTION
            'publication NCM code does not match official catalog entry';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_publication_ncm_catalog
BEFORE INSERT OR UPDATE OF ncm_code, official_catalog_entry_id
ON publication_ncm_mentions
FOR EACH ROW
EXECUTE FUNCTION validate_publication_ncm_catalog_entry();

CREATE OR REPLACE FUNCTION app_company_product_profile_is_in_current_tenant(
    p_company_product_profile_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM company_product_profiles cpp
        JOIN companies c
          ON c.id = cpp.company_id
        WHERE cpp.id = p_company_product_profile_id
          AND c.tenant_id = app_current_tenant_id()
    );
$$;

REVOKE ALL ON FUNCTION validate_company_product_taxonomy_dimensions()
FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_ncm_catalog_entry()
FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_publication_ncm_catalog_entry()
FROM PUBLIC;
REVOKE ALL ON FUNCTION app_company_product_profile_is_in_current_tenant(UUID)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_company_product_profile_is_in_current_tenant(UUID)
TO radar_app, radar_worker;

REVOKE ALL ON
    company_product_profiles,
    company_product_ncms,
    publication_ncm_mentions
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    company_product_profiles,
    company_product_ncms
TO radar_app;

GRANT SELECT ON
    company_product_profiles,
    company_product_ncms
TO radar_worker;

GRANT SELECT ON publication_ncm_mentions
TO radar_app;

GRANT SELECT, INSERT ON publication_ncm_mentions
TO radar_worker;

ALTER TABLE company_product_profiles
ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_product_profiles
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_product_profiles_app
ON company_product_profiles
FOR ALL
TO radar_app
USING (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(app_current_tenant_id())
)
WITH CHECK (
    app_company_is_in_current_tenant(company_id)
    AND app_user_has_tenant_access(app_current_tenant_id())
);

CREATE POLICY company_product_profiles_worker_select
ON company_product_profiles
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);

ALTER TABLE company_product_ncms
ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_product_ncms
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_product_ncms_app
ON company_product_ncms
FOR ALL
TO radar_app
USING (
    app_company_product_profile_is_in_current_tenant(
        company_product_profile_id
    )
    AND app_user_has_tenant_access(app_current_tenant_id())
)
WITH CHECK (
    app_company_product_profile_is_in_current_tenant(
        company_product_profile_id
    )
    AND app_user_has_tenant_access(app_current_tenant_id())
);

CREATE POLICY company_product_ncms_worker_select
ON company_product_ncms
FOR SELECT
TO radar_worker
USING (
    app_company_product_profile_is_in_current_tenant(
        company_product_profile_id
    )
);
