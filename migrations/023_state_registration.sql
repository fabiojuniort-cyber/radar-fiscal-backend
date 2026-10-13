ALTER TABLE establishments
ADD COLUMN state_registration TEXT,
ADD COLUMN state_registration_status TEXT,
ADD COLUMN state_registration_source TEXT,
ADD COLUMN state_registration_checked_at TIMESTAMPTZ,
ADD COLUMN state_registration_lookup_status TEXT
    CHECK (
        state_registration_lookup_status IS NULL
        OR state_registration_lookup_status IN (
            'SUCCESS',
            'NOT_FOUND',
            'UNAVAILABLE',
            'NOT_SUPPORTED'
        )
    );

CREATE INDEX ix_establishments_state_registration
ON establishments(uf, state_registration)
WHERE
    is_active = TRUE
    AND state_registration IS NOT NULL;
