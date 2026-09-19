import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';

export type SourceOperationalState =
  | 'NOT_YET_CONSULTED'
  | 'OPERATIONAL'
  | 'UNSTABLE'
  | 'UNAVAILABLE';

export interface SourceOperationalSnapshot {
  sourceId: string;
  sourceCode: string;
  sourceName: string;
  operationalState: SourceOperationalState;
  lastRunStatus: string | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastDurationMs: number | null;
  latestRunId: string | null;
  foundItems: number;
  processedItems: number;
  newPublications: number;
  newVersions: number;
  existingPublications: number;
  itemErrors: number;
  attemptCount: number;
  retryCount: number;
}

function stateFromStatus(
  lastRunStatus: string | null,
  lastAttemptAt: Date | null,
): SourceOperationalState {
  if (!lastAttemptAt) {
    return 'NOT_YET_CONSULTED';
  }

  if (lastRunStatus === 'SOURCE_UNAVAILABLE') {
    return 'UNAVAILABLE';
  }

  if (
    lastRunStatus === 'SUCCESS' ||
    lastRunStatus === 'SUCCESS_NO_RESULTS'
  ) {
    return 'OPERATIONAL';
  }

  return 'UNSTABLE';
}

export async function getSourceOperationalSnapshot(
  db: Kysely<DB>,
  sourceId: string,
): Promise<SourceOperationalSnapshot> {
  const result = await sql<{
    source_id: string;
    source_code: string;
    source_name: string;
    last_run_status: string | null;
    last_attempt_at: Date | null;
    last_success_at: Date | null;
    last_duration_ms: number | null;
    latest_run_id: string | null;
    found_items: number;
    processed_items: number;
    new_publications: number;
    new_versions: number;
    existing_publications: number;
    item_errors: number;
    attempt_count: number;
  }>`
    WITH latest_run AS (
      SELECT cr.*
      FROM collection_runs cr
      WHERE cr.source_id = ${sourceId}
      ORDER BY cr.scheduled_for DESC, cr.created_at DESC
      LIMIT 1
    ),
    latest_attempt AS (
      SELECT ca.*
      FROM collection_attempts ca
      JOIN latest_run lr
        ON lr.id = ca.collection_run_id
      ORDER BY ca.attempt_no DESC
      LIMIT 1
    ),
    last_success AS (
      SELECT max(cr.finished_at) AS last_success_at
      FROM collection_runs cr
      WHERE cr.source_id = ${sourceId}
        AND cr.status IN (
          'SUCCESS',
          'SUCCESS_NO_RESULTS',
          'PARTIAL_SUCCESS'
        )
    ),
    item_metrics AS (
      SELECT
        count(*)::int AS found_items,
        count(*) FILTER (
          WHERE ci.status IN (
            'PROCESSED_NEW',
            'PROCESSED_EXISTING',
            'NEW_VERSION'
          )
        )::int AS processed_items,
        count(*) FILTER (
          WHERE ci.status = 'PROCESSED_NEW'
        )::int AS new_publications,
        count(*) FILTER (
          WHERE ci.status = 'NEW_VERSION'
        )::int AS new_versions,
        count(*) FILTER (
          WHERE ci.status = 'PROCESSED_EXISTING'
        )::int AS existing_publications,
        count(*) FILTER (
          WHERE ci.status = 'FAILED'
        )::int AS item_errors
      FROM collection_items ci
      JOIN latest_run lr
        ON lr.id = ci.collection_run_id
    ),
    attempt_metrics AS (
      SELECT count(*)::int AS attempt_count
      FROM collection_attempts ca
      JOIN latest_run lr
        ON lr.id = ca.collection_run_id
    )
    SELECT
      s.id AS source_id,
      s.code AS source_code,
      s.name AS source_name,
      lr.status AS last_run_status,
      la.started_at AS last_attempt_at,
      ls.last_success_at,
      la.response_time_ms AS last_duration_ms,
      lr.id AS latest_run_id,
      coalesce(im.found_items, 0)::int AS found_items,
      coalesce(im.processed_items, 0)::int AS processed_items,
      coalesce(im.new_publications, 0)::int AS new_publications,
      coalesce(im.new_versions, 0)::int AS new_versions,
      coalesce(im.existing_publications, 0)::int AS existing_publications,
      coalesce(im.item_errors, 0)::int AS item_errors,
      coalesce(am.attempt_count, 0)::int AS attempt_count
    FROM sources s
    LEFT JOIN latest_run lr ON true
    LEFT JOIN latest_attempt la ON true
    LEFT JOIN last_success ls ON true
    LEFT JOIN item_metrics im ON true
    LEFT JOIN attempt_metrics am ON true
    WHERE s.id = ${sourceId}
  `.execute(db);

  const row = result.rows[0];

  if (!row) {
    throw new Error(
      `Source not found: ${sourceId}`,
    );
  }

  return {
    sourceId: row.source_id,
    sourceCode: row.source_code,
    sourceName: row.source_name,
    operationalState: stateFromStatus(
      row.last_run_status,
      row.last_attempt_at,
    ),
    lastRunStatus: row.last_run_status,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastDurationMs: row.last_duration_ms,
    latestRunId: row.latest_run_id,
    foundItems: row.found_items,
    processedItems: row.processed_items,
    newPublications: row.new_publications,
    newVersions: row.new_versions,
    existingPublications: row.existing_publications,
    itemErrors: row.item_errors,
    attemptCount: row.attempt_count,
    retryCount: Math.max(
      row.attempt_count - 1,
      0,
    ),
  };
}
