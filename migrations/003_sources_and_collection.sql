CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    code TEXT NOT NULL UNIQUE,

    name TEXT NOT NULL,

    jurisdiction_level TEXT NOT NULL
        CHECK(
            jurisdiction_level IN (
                'FEDERAL',
                'STATE'
            )
        ),

    uf CHAR(2),

    agency TEXT,

    base_url TEXT NOT NULL,

    connector_key TEXT NOT NULL UNIQUE,

    connector_config JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    schedule_cron TEXT,

    schedule_timezone TEXT NOT NULL
        DEFAULT 'America/Sao_Paulo',

    max_attempts SMALLINT NOT NULL
        DEFAULT 3
        CHECK(
            max_attempts BETWEEN 1 AND 10
        ),

    is_active BOOLEAN NOT NULL
        DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT chk_source_config
        CHECK(
            jsonb_typeof(connector_config)
            = 'object'
        ),

    CONSTRAINT chk_source_uf
        CHECK(
            (
                jurisdiction_level = 'FEDERAL'
                AND uf IS NULL
            )
            OR
            (
                jurisdiction_level = 'STATE'
                AND uf IS NOT NULL
                AND uf ~ '^[A-Z]{2}$'
            )
        )
);

CREATE INDEX ix_sources_active
ON sources(is_active);

CREATE INDEX ix_sources_scope
ON sources(
    jurisdiction_level,
    uf
);

CREATE TABLE collection_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    source_id UUID NOT NULL
        REFERENCES sources(id),

    scheduled_for TIMESTAMPTZ NOT NULL,

    trigger_type TEXT NOT NULL
        DEFAULT 'SCHEDULED'
        CHECK(
            trigger_type IN (
                'SCHEDULED',
                'MANUAL',
                'BACKFILL'
            )
        ),

    status TEXT NOT NULL
        DEFAULT 'PENDING'
        CHECK(
            status IN (
                'PENDING',
                'RUNNING',
                'SUCCESS',
                'SUCCESS_NO_RESULTS',
                'PARTIAL_SUCCESS',
                'SOURCE_UNAVAILABLE',
                'FETCH_FAILED',
                'PROCESSING_FAILED',
                'NOT_CONSULTED',
                'CANCELLED'
            )
        ),

    source_consulted_at TIMESTAMPTZ,

    started_at TIMESTAMPTZ,

    finished_at TIMESTAMPTZ,

    next_attempt_at TIMESTAMPTZ,

    worker_id TEXT,

    locked_at TIMESTAMPTZ,

    heartbeat_at TIMESTAMPTZ,

    error_summary TEXT,

    correlation_id UUID NOT NULL
        DEFAULT gen_random_uuid(),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_collection_run_schedule
        UNIQUE(
            source_id,
            scheduled_for,
            trigger_type
        ),

    CONSTRAINT chk_collection_run_dates
        CHECK(
            finished_at IS NULL
            OR started_at IS NULL
            OR finished_at >= started_at
        )
);

CREATE INDEX ix_collection_runs_queue
ON collection_runs(
    status,
    next_attempt_at,
    scheduled_for
);

CREATE INDEX ix_collection_runs_source_history
ON collection_runs(
    source_id,
    scheduled_for DESC
);

CREATE INDEX ix_collection_runs_status_history
ON collection_runs(
    status,
    scheduled_for DESC
);

CREATE TABLE collection_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    collection_run_id UUID NOT NULL
        REFERENCES collection_runs(id)
        ON DELETE CASCADE,

    attempt_no SMALLINT NOT NULL
        CHECK(attempt_no >= 1),

    status TEXT NOT NULL
        CHECK(
            status IN (
                'RUNNING',
                'SUCCESS',
                'SOURCE_UNAVAILABLE',
                'NETWORK_ERROR',
                'HTTP_ERROR',
                'FETCH_ERROR',
                'PROCESSING_ERROR',
                'TIMEOUT',
                'RATE_LIMITED',
                'CANCELLED'
            )
        ),

    started_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    finished_at TIMESTAMPTZ,

    response_time_ms INTEGER
        CHECK(
            response_time_ms IS NULL
            OR response_time_ms >= 0
        ),

    http_status SMALLINT,

    connector_version TEXT,

    error_code TEXT,

    error_message TEXT,

    retryable BOOLEAN NOT NULL
        DEFAULT FALSE,

    retry_after_seconds INTEGER
        CHECK(
            retry_after_seconds IS NULL
            OR retry_after_seconds >= 0
        ),

    metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    CONSTRAINT uq_collection_attempt
        UNIQUE(
            collection_run_id,
            attempt_no
        ),

    CONSTRAINT chk_attempt_dates
        CHECK(
            finished_at IS NULL
            OR finished_at >= started_at
        )
);

CREATE INDEX ix_collection_attempts_run
ON collection_attempts(
    collection_run_id,
    attempt_no
);

CREATE TABLE collection_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    collection_run_id UUID NOT NULL
        REFERENCES collection_runs(id)
        ON DELETE CASCADE,

    first_attempt_id UUID
        REFERENCES collection_attempts(id),

    source_item_key TEXT NOT NULL,

    external_id TEXT,

    source_url TEXT,

    status TEXT NOT NULL
        CHECK(
            status IN (
                'DISCOVERED',
                'PROCESSED_NEW',
                'PROCESSED_EXISTING',
                'NEW_VERSION',
                'FAILED'
            )
        ),

    publication_id UUID,

    error_code TEXT,

    error_message TEXT,

    raw_metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT now(),

    CONSTRAINT uq_collection_item
        UNIQUE(
            collection_run_id,
            source_item_key
        )
);
