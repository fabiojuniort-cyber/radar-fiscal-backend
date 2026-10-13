CREATE TABLE establishment_types (
    code TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO establishment_types(code, name, sort_order)
VALUES
('HEAD_OFFICE', 'Matriz', 10),
('OFFICE', 'Escritório', 20),
('FACTORY', 'Fábrica', 30),
('INDUSTRY', 'Indústria', 40),
('WAREHOUSE', 'Armazém', 50),
('DISTRIBUTION_CENTER', 'Centro de Distribuição', 60),
('FARM', 'Fazenda', 70),
('TERMINAL', 'Terminal', 80),
('TRANSSHIPMENT', 'Transbordo', 90),
('OTHER', 'Outro', 999);

CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL
        REFERENCES tenants(id)
        ON DELETE CASCADE,

    legal_name TEXT NOT NULL,

    trade_name TEXT,

    head_office_cnpj CHAR(14) NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_companies_cnpj
        CHECK (
            head_office_cnpj ~ '^[0-9]{14}$'
        ),

    CONSTRAINT uq_company_cnpj_per_tenant
        UNIQUE (
            tenant_id,
            head_office_cnpj
        )
);

CREATE INDEX ix_companies_tenant
ON companies(
    tenant_id,
    is_active
);

CREATE INDEX ix_companies_legal_name
ON companies(
    tenant_id,
    legal_name
);

CREATE TRIGGER trg_companies_updated_at
BEFORE UPDATE ON companies
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE company_tax_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    version_no INTEGER NOT NULL,

    tax_regime TEXT NOT NULL
        CHECK (
            tax_regime IN (
                'SIMPLES_NACIONAL',
                'LUCRO_PRESUMIDO',
                'LUCRO_REAL',
                'IMUNE_ISENTA',
                'OUTRO',
                'NAO_INFORMADO'
            )
        ),

    activities JSONB NOT NULL DEFAULT '[]'::jsonb,

    segments TEXT[] NOT NULL DEFAULT '{}',

    personalization JSONB NOT NULL DEFAULT '{}'::jsonb,

    valid_from DATE,

    valid_to DATE,

    is_current BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_company_profile_version
        UNIQUE(company_id, version_no),

    CONSTRAINT chk_company_profile_activities
        CHECK(jsonb_typeof(activities) = 'array'),

    CONSTRAINT chk_company_profile_personalization
        CHECK(jsonb_typeof(personalization) = 'object'),

    CONSTRAINT chk_profile_dates
        CHECK(
            valid_to IS NULL
            OR valid_from IS NULL
            OR valid_to >= valid_from
        )
);

CREATE UNIQUE INDEX uq_company_current_tax_profile
ON company_tax_profiles(company_id)
WHERE is_current = TRUE;

CREATE TABLE establishments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    cnpj CHAR(14) NOT NULL,

    name TEXT NOT NULL,

    establishment_type_code TEXT NOT NULL
        REFERENCES establishment_types(code),

    is_head_office BOOLEAN NOT NULL DEFAULT FALSE,

    uf CHAR(2) NOT NULL,

    municipality_name TEXT,

    municipality_ibge_code CHAR(7),

    postal_code CHAR(8),

    street TEXT,

    street_number TEXT,

    complement TEXT,

    district TEXT,

    latitude NUMERIC(9,6),

    longitude NUMERIC(9,6),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_establishment_cnpj
        CHECK(cnpj ~ '^[0-9]{14}$'),

    CONSTRAINT chk_establishment_uf
        CHECK(uf ~ '^[A-Z]{2}$'),

    CONSTRAINT chk_establishment_latitude
        CHECK(
            latitude IS NULL
            OR latitude BETWEEN -90 AND 90
        ),

    CONSTRAINT chk_establishment_longitude
        CHECK(
            longitude IS NULL
            OR longitude BETWEEN -180 AND 180
        ),

    CONSTRAINT chk_establishment_coordinates
        CHECK (
            (
                latitude IS NULL
                AND longitude IS NULL
            )
            OR
            (
                latitude IS NOT NULL
                AND longitude IS NOT NULL
            )
        ),

    CONSTRAINT uq_establishment_company_cnpj
        UNIQUE(company_id, cnpj)
);

CREATE INDEX ix_establishments_company
ON establishments(
    company_id,
    is_active
);

CREATE INDEX ix_establishments_company_uf
ON establishments(
    company_id,
    uf
)
WHERE is_active = TRUE;

CREATE INDEX ix_establishments_type
ON establishments(
    establishment_type_code
);

CREATE UNIQUE INDEX uq_company_head_office
ON establishments(company_id)
WHERE
    is_head_office = TRUE
    AND is_active = TRUE;

CREATE TRIGGER trg_establishments_updated_at
BEFORE UPDATE ON establishments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE cnaes (
    code CHAR(7) PRIMARY KEY,

    description TEXT NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE company_cnaes (
    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    cnae_code CHAR(7) NOT NULL
        REFERENCES cnaes(code),

    is_primary BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY(
        company_id,
        cnae_code
    )
);

CREATE UNIQUE INDEX uq_company_primary_cnae
ON company_cnaes(company_id)
WHERE is_primary = TRUE;

CREATE TABLE establishment_cnaes (
    establishment_id UUID NOT NULL
        REFERENCES establishments(id)
        ON DELETE CASCADE,

    cnae_code CHAR(7) NOT NULL
        REFERENCES cnaes(code),

    is_primary BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY(
        establishment_id,
        cnae_code
    )
);

CREATE UNIQUE INDEX uq_establishment_primary_cnae
ON establishment_cnaes(establishment_id)
WHERE is_primary = TRUE;
