-- ACT-SCOPE-02 / D-067, D-068, D-071
-- Versioned collection-filter policy. Runtime roles receive read-only access;
-- publication decisions remain pure in application code.

CREATE TABLE collection_filter_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL UNIQUE CHECK (version > 0),
    status TEXT NOT NULL
        CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
    context_window_words INTEGER NOT NULL DEFAULT 12
        CHECK (context_window_words BETWEEN 0 AND 100),
    weak_score_threshold INTEGER NOT NULL DEFAULT 3
        CHECK (weak_score_threshold BETWEEN 1 AND 100),
    title_weight INTEGER NOT NULL DEFAULT 3
        CHECK (title_weight BETWEEN 1 AND 20),
    summary_weight INTEGER NOT NULL DEFAULT 2
        CHECK (summary_weight BETWEEN 1 AND 20),
    body_weight INTEGER NOT NULL DEFAULT 1
        CHECK (body_weight BETWEEN 1 AND 20),
    change_notes TEXT,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (status = 'APPROVED' AND approved_at IS NOT NULL)
        OR status <> 'APPROVED'
    )
);

CREATE UNIQUE INDEX uq_collection_filter_one_approved
ON collection_filter_policies ((status))
WHERE status = 'APPROVED';

CREATE TABLE collection_filter_type_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL
        REFERENCES collection_filter_policies(id) ON DELETE CASCADE,
    source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
    section TEXT NOT NULL DEFAULT '',
    canonical_type TEXT NOT NULL CHECK (btrim(canonical_type) <> ''),
    mode TEXT NOT NULL CHECK (
        mode IN (
            'KEEP_ALWAYS',
            'KEEP_IF_TAX_TERM',
            'EXCLUDE_UNLESS_STRONG',
            'EXCLUDE_ALWAYS'
        )
    ),
    help_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (policy_id, source_code, section, canonical_type)
);

CREATE INDEX ix_collection_filter_type_rules_lookup
ON collection_filter_type_rules (
    policy_id, lower(source_code), lower(section), canonical_type
);

CREATE TABLE collection_filter_type_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL
        REFERENCES collection_filter_policies(id) ON DELETE CASCADE,
    source_code TEXT NOT NULL CHECK (btrim(source_code) <> ''),
    section TEXT NOT NULL DEFAULT '',
    normalized_alias TEXT NOT NULL CHECK (btrim(normalized_alias) <> ''),
    canonical_type TEXT NOT NULL CHECK (btrim(canonical_type) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (policy_id, source_code, section, normalized_alias)
);

CREATE TABLE collection_filter_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL
        REFERENCES collection_filter_policies(id) ON DELETE CASCADE,
    term_text TEXT NOT NULL CHECK (btrim(term_text) <> ''),
    normalized_term TEXT NOT NULL CHECK (btrim(normalized_term) <> ''),
    strength TEXT NOT NULL
        CHECK (strength IN ('STRONG', 'WEAK', 'NEGATIVE')),
    source_code TEXT,
    section TEXT,
    canonical_type TEXT,
    location_scope TEXT NOT NULL DEFAULT 'ANY'
        CHECK (location_scope IN ('ANY', 'TITLE', 'SUMMARY', 'BODY')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_code IS NULL OR btrim(source_code) <> ''),
    CHECK (section IS NULL OR btrim(section) <> ''),
    CHECK (canonical_type IS NULL OR btrim(canonical_type) <> '')
);

CREATE INDEX ix_collection_filter_terms_policy
ON collection_filter_terms (policy_id, strength);

CREATE INDEX ix_collection_filter_terms_scope
ON collection_filter_terms (
    policy_id, lower(source_code), lower(section), canonical_type
);

CREATE UNIQUE INDEX uq_collection_filter_terms_effective
ON collection_filter_terms (
    policy_id,
    normalized_term,
    strength,
    COALESCE(lower(source_code), ''),
    COALESCE(lower(section), ''),
    COALESCE(lower(canonical_type), ''),
    location_scope
);

REVOKE ALL ON
    collection_filter_policies,
    collection_filter_type_rules,
    collection_filter_type_aliases,
    collection_filter_terms
FROM PUBLIC, radar_app, radar_worker, radar_taxonomy_curator;

GRANT SELECT ON
    collection_filter_policies,
    collection_filter_type_rules,
    collection_filter_type_aliases,
    collection_filter_terms
TO radar_app, radar_worker;

ALTER TABLE collection_filter_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_type_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_type_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_type_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_type_aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_filter_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY collection_filter_policies_app_select
ON collection_filter_policies
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_policies_worker_select
ON collection_filter_policies
FOR SELECT TO radar_worker
USING (status = 'APPROVED');

CREATE POLICY collection_filter_type_rules_app_select
ON collection_filter_type_rules
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_type_rules_worker_select
ON collection_filter_type_rules
FOR SELECT TO radar_worker
USING (
    EXISTS (
        SELECT 1
        FROM collection_filter_policies p
        WHERE p.id = policy_id
          AND p.status = 'APPROVED'
    )
);

CREATE POLICY collection_filter_type_aliases_app_select
ON collection_filter_type_aliases
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_type_aliases_worker_select
ON collection_filter_type_aliases
FOR SELECT TO radar_worker
USING (
    EXISTS (
        SELECT 1
        FROM collection_filter_policies p
        WHERE p.id = policy_id
          AND p.status = 'APPROVED'
    )
);

CREATE POLICY collection_filter_terms_app_select
ON collection_filter_terms
FOR SELECT TO radar_app
USING (app_user_is_platform_admin());

CREATE POLICY collection_filter_terms_worker_select
ON collection_filter_terms
FOR SELECT TO radar_worker
USING (
    EXISTS (
        SELECT 1
        FROM collection_filter_policies p
        WHERE p.id = policy_id
          AND p.status = 'APPROVED'
    )
);
