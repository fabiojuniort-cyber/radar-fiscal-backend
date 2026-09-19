CREATE TABLE monitoring_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,

    description TEXT,

    is_active BOOLEAN NOT NULL
        DEFAULT TRUE,

    criteria JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    criteria_schema_version SMALLINT NOT NULL
        DEFAULT 1,

    profile_version INTEGER NOT NULL
        DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT chk_monitoring_criteria
        CHECK(
            jsonb_typeof(criteria)
            = 'object'
        )
);

CREATE INDEX ix_monitoring_profiles_company
ON monitoring_profiles(
    company_id,
    is_active
);

CREATE INDEX ix_monitoring_profiles_criteria
ON monitoring_profiles
USING GIN(criteria);

CREATE TABLE company_publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id UUID NOT NULL
        REFERENCES companies(id)
        ON DELETE CASCADE,

    publication_id UUID NOT NULL
        REFERENCES publications(id)
        ON DELETE CASCADE,

    status TEXT NOT NULL
        DEFAULT 'POTENTIALLY_RELEVANT'
        CHECK(
            status IN (
                'POTENTIALLY_RELEVANT',
                'REVIEW_PENDING',
                'RELEVANT',
                'NOT_RELEVANT',
                'IGNORED'
            )
        ),

    first_matched_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    last_matched_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_company_publication
        UNIQUE(
            company_id,
            publication_id
        )
);

CREATE INDEX ix_company_publications_dashboard
ON company_publications(
    company_id,
    status,
    first_matched_at DESC
);

CREATE TABLE publication_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    company_publication_id UUID NOT NULL
        REFERENCES company_publications(id)
        ON DELETE CASCADE,

    monitoring_profile_id UUID NOT NULL
        REFERENCES monitoring_profiles(id),

    profile_version INTEGER NOT NULL,

    rule_engine_version TEXT NOT NULL,

    matched_fields JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now()
);

CREATE INDEX ix_publication_matches_company_publication
ON publication_matches(company_publication_id);

CREATE INDEX ix_publication_matches_profile
ON publication_matches(monitoring_profile_id);
