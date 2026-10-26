CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID
        REFERENCES tenants(id),

    actor_type TEXT NOT NULL
        CHECK(
            actor_type IN (
                'USER',
                'SYSTEM',
                'WORKER',
                'ADMIN'
            )
        ),

    actor_id TEXT,

    action TEXT NOT NULL,

    entity_type TEXT NOT NULL,

    entity_id TEXT,

    before_data JSONB,

    after_data JSONB,

    correlation_id UUID,

    request_id TEXT,

    occurred_at TIMESTAMPTZ NOT NULL
        DEFAULT now()
);

CREATE INDEX ix_audit_tenant
ON audit_log(
    tenant_id,
    occurred_at DESC
);

CREATE INDEX ix_audit_entity
ON audit_log(
    entity_type,
    entity_id,
    occurred_at DESC
);

CREATE INDEX ix_audit_correlation
ON audit_log(correlation_id);
