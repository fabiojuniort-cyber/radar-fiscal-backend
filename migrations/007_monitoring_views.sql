CREATE VIEW v_source_monitoring AS
SELECT
    s.id AS source_id,
    s.code,
    s.name,
    s.jurisdiction_level,
    s.uf,

    (
        SELECT MAX(ca.started_at)
        FROM collection_attempts ca
        JOIN collection_runs cr
          ON cr.id = ca.collection_run_id
        WHERE cr.source_id = s.id
    ) AS last_attempt_at,

    (
        SELECT MAX(cr.finished_at)
        FROM collection_runs cr
        WHERE cr.source_id = s.id
          AND cr.status IN (
              'SUCCESS',
              'SUCCESS_NO_RESULTS'
          )
    ) AS last_success_at,

    (
        SELECT ca.response_time_ms
        FROM collection_attempts ca
        JOIN collection_runs cr
          ON cr.id = ca.collection_run_id
        WHERE cr.source_id = s.id
          AND ca.response_time_ms IS NOT NULL
        ORDER BY ca.started_at DESC
        LIMIT 1
    ) AS last_response_time_ms,

    (
        SELECT cr.status
        FROM collection_runs cr
        WHERE cr.source_id = s.id
        ORDER BY cr.scheduled_for DESC
        LIMIT 1
    ) AS last_run_status

FROM sources s;
