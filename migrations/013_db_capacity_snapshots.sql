-- PostgreSQL-side storage telemetry.
--
-- These snapshots explain WHY storage grows (database, WAL when observable,
-- heaviest tables, row counts). They are an ESTIMATE of the space used by
-- PostgreSQL: the authoritative "volume is N% full" figure must come from the
-- platform/filesystem metric. platform_volume_used_bytes is reserved for that
-- integration and stays NULL until it exists.

CREATE TABLE db_capacity_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    db_bytes BIGINT NOT NULL
        CHECK (db_bytes >= 0),

    -- NULL when the collector has no privilege to list pg_wal
    -- (requires a dedicated monitoring role; never granted to runtime roles).
    wal_bytes BIGINT
        CHECK (wal_bytes IS NULL OR wal_bytes >= 0),

    -- MEASURED: wal_bytes came from pg_ls_waldir (monitoring connection).
    -- MAX_WAL_SIZE: WAL not observable; estimated_pg_bytes uses max_wal_size
    -- as a conservative allowance (it is a checkpoint target, not a hard cap).
    wal_estimate_basis TEXT NOT NULL
        CHECK (wal_estimate_basis IN ('MEASURED', 'MAX_WAL_SIZE')),

    estimated_pg_bytes BIGINT NOT NULL
        CHECK (estimated_pg_bytes >= 0),

    capacity_bytes BIGINT
        CHECK (capacity_bytes IS NULL OR capacity_bytes > 0),

    -- Capped at 9999.9999 by the collector (a misconfigured capacity must
    -- never make the snapshot fail).
    estimated_used_ratio NUMERIC(8, 4)
        CHECK (estimated_used_ratio IS NULL OR estimated_used_ratio >= 0),

    platform_volume_used_bytes BIGINT
        CHECK (platform_volume_used_bytes IS NULL OR platform_volume_used_bytes >= 0),

    top_tables JSONB NOT NULL DEFAULT '[]'::jsonb,

    attempts_rows BIGINT NOT NULL
        CHECK (attempts_rows >= 0),

    publications_rows BIGINT NOT NULL
        CHECK (publications_rows >= 0),

    alert_level TEXT NOT NULL DEFAULT 'OK'
        CHECK (alert_level IN ('OK', 'WARNING', 'CRITICAL', 'UNKNOWN'))
);

CREATE INDEX ix_db_capacity_snapshots_taken_at
ON db_capacity_snapshots (taken_at DESC);

REVOKE ALL ON db_capacity_snapshots FROM PUBLIC;

GRANT SELECT, INSERT
ON db_capacity_snapshots
TO radar_worker;
