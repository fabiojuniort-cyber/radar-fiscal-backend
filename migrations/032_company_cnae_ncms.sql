-- TAX-11 / 032
-- NCMs a company declares for one of its CNAEs, independent of products.
-- Products and NCMs are edited separately in the Tax Profile; an NCM that
-- belongs to a product stays in company_product_ncms.

CREATE TABLE company_cnae_ncms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,
    cnae_code CHAR(7) NOT NULL
        REFERENCES cnaes(code),
    official_catalog_entry_id UUID NOT NULL
        REFERENCES official_catalog_entries(id)
        ON DELETE RESTRICT,
    assignment_source TEXT NOT NULL DEFAULT 'MANUAL'
        CHECK (assignment_source IN ('MANUAL', 'IMPORT', 'MATCHED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_company_cnae_ncm
        UNIQUE (company_id, cnae_code, official_catalog_entry_id)
);

CREATE INDEX ix_company_cnae_ncms_company
ON company_cnae_ncms(company_id, cnae_code);

CREATE INDEX ix_company_cnae_ncms_entry
ON company_cnae_ncms(official_catalog_entry_id);

CREATE TRIGGER trg_company_cnae_ncm_catalog
BEFORE INSERT OR UPDATE OF official_catalog_entry_id
ON company_cnae_ncms
FOR EACH ROW
EXECUTE FUNCTION validate_ncm_catalog_entry();

REVOKE ALL ON company_cnae_ncms FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON company_cnae_ncms
TO radar_app;

GRANT SELECT ON company_cnae_ncms
TO radar_worker;

ALTER TABLE company_cnae_ncms
ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_cnae_ncms
FORCE ROW LEVEL SECURITY;

CREATE POLICY company_cnae_ncms_app
ON company_cnae_ncms
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

CREATE POLICY company_cnae_ncms_worker_select
ON company_cnae_ncms
FOR SELECT
TO radar_worker
USING (
    app_company_is_in_current_tenant(company_id)
);
