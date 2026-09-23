-- Operational checkpoint store for collection connectors.
--
-- collection_attempts.metadata is the execution history/audit trail and must
-- not be the primary, ever-growing store of heavy connector state. The current
-- checkpoint (plus a few previous generations for recovery/rollback) lives
-- here; attempts only keep a small checkpointRef.
--
-- Generations are allocated per (source_id, connector_key) under a
-- transaction-scoped advisory lock; the UNIQUE constraint is the backstop.

CREATE TABLE collection_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    source_id UUID NOT NULL
        REFERENCES sources(id)
        ON DELETE CASCADE,

    connector_key TEXT NOT NULL
        CHECK (length(connector_key) BETWEEN 1 AND 100),

    state_version INTEGER NOT NULL
        CHECK (state_version >= 1),

    generation BIGINT NOT NULL
        CHECK (generation >= 1),

    payload JSONB NOT NULL,

    payload_sha256 TEXT NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),

    payload_bytes INTEGER NOT NULL
        CHECK (payload_bytes >= 0),

    produced_by_run_id UUID
        REFERENCES collection_runs(id)
        ON DELETE SET NULL,

    produced_by_attempt_id UUID
        REFERENCES collection_attempts(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_collection_checkpoint_generation
        UNIQUE (source_id, connector_key, generation)
);

CREATE INDEX ix_collection_checkpoints_current
ON collection_checkpoints (source_id, connector_key, generation DESC);

CREATE INDEX ix_collection_checkpoints_run
ON collection_checkpoints (produced_by_run_id);

REVOKE ALL ON collection_checkpoints FROM PUBLIC;

-- Only the collection runtime (worker/scheduler) reads and writes checkpoints.
-- DELETE is required to keep just the current generation + 2 previous ones.
GRANT SELECT, INSERT, DELETE
ON collection_checkpoints
TO radar_worker;
