import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';

/**
 * Read-only diagnostics for recurring collection problems: item failures per
 * source, origin/identity conflicts and DOU partial failures. Returns bounded
 * aggregates and official identifiers only (no content text).
 */

export interface ItemFailureGroup {
  sourceCode: string;
  errorCode: string | null;
  errorMessage: string | null;
  failures: number;
  distinctItems: number;
  lastSeenAt: Date;
  sampleItemKeys: string[];
}

export interface OriginConflict {
  sourceCode: string;
  externalId: string | null;
  sourceItemKey: string;
  lastFailedAt: Date;
  failedItemMetadata: Record<string, unknown>;
  linkedPublication: {
    id: string;
    title: string;
    actType: string | null;
    actNumber: string | null;
    publishedOn: string | null;
    identityStrength: string;
    identityBasis: unknown;
    createdAt: Date;
  } | null;
  linkedOrigin: {
    officialUrl: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
  } | null;
}

export interface DouPartialDiagnostics {
  attemptId: string;
  runId: string;
  runStatus: string;
  finishedAt: Date | null;
  partialFailures: unknown[];
  problemArchives: unknown[];
}

export interface CollectionDiagnostics {
  sinceHours: number;
  itemFailures: ItemFailureGroup[];
  originConflicts: OriginConflict[];
  dou: DouPartialDiagnostics | null;
}

/** Upper bound of runs examined per source (hourly sources: ~1 day). */
export const RECENT_RUNS_PER_SOURCE = 24;

const CONFLICT_MESSAGE = 'Publication origin is already linked to another publication identity.';

const METADATA_KEYS = [
  'module', 'documentKind', 'documentFamily', 'revisionKind', 'republication',
  'documentStatus', 'itemId', 'identityVersion', 'officialVersion', 'documentNumber',
  'originTitle', 'sourceCreatedAt', 'updatedAt',
];

function pick(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(METADATA_KEYS.filter((key) => key in record).map((key) => [key, record[key]]));
}

export async function readCollectionDiagnostics(
  db: Kysely<DB>,
  sinceHours = 48,
): Promise<CollectionDiagnostics> {
  const since = new Date(Date.now() - sinceHours * 3_600_000);

  const failures = await sql<{
    source_code: string;
    error_code: string | null;
    error_message: string | null;
    failures: number;
    distinct_items: number;
    last_seen_at: Date;
    sample_keys: string[];
  }>`
    WITH recent_runs AS (
      -- Bounded candidate set: at most RECENT_RUNS_PER_SOURCE runs per source
      -- inside the window, via ix_collection_runs_source_history
      -- (source_id, scheduled_for DESC). Items are then reached through
      -- uq_collection_item (collection_run_id, ...), so the work is bounded
      -- by sources x runs, never a scan of all collection_items.
      SELECT r.id, r.source_id
      FROM sources src
      CROSS JOIN LATERAL (
        SELECT cr.id, cr.source_id
        FROM collection_runs cr
        WHERE cr.source_id = src.id
          AND cr.scheduled_for >= ${since}
        ORDER BY cr.scheduled_for DESC
        LIMIT ${RECENT_RUNS_PER_SOURCE}
      ) r
    )
    SELECT
      s.code AS source_code,
      ci.error_code,
      LEFT(ci.error_message, 300) AS error_message,
      COUNT(*)::int AS failures,
      COUNT(DISTINCT ci.source_item_key)::int AS distinct_items,
      MAX(ci.updated_at) AS last_seen_at,
      (ARRAY_AGG(DISTINCT ci.source_item_key))[1:5] AS sample_keys
    FROM recent_runs cr
    JOIN sources s ON s.id = cr.source_id
    JOIN collection_items ci ON ci.collection_run_id = cr.id
    WHERE ci.status = 'FAILED'
    GROUP BY s.code, ci.error_code, LEFT(ci.error_message, 300)
    ORDER BY failures DESC
    LIMIT 50
  `.execute(db);

  const conflicts = await sql<{
    source_code: string;
    external_id: string | null;
    source_item_key: string;
    last_failed_at: Date;
    raw_metadata: unknown;
    publication_id: string | null;
    title: string | null;
    act_type: string | null;
    act_number: string | null;
    published_on: Date | null;
    identity_strength: string | null;
    identity_basis: unknown;
    publication_created_at: Date | null;
    official_url: string | null;
    first_seen_at: Date | null;
    origin_last_seen_at: Date | null;
  }>`
    WITH recent_runs AS (
      -- Bounded candidate set: at most RECENT_RUNS_PER_SOURCE runs per source
      -- inside the window, via ix_collection_runs_source_history
      -- (source_id, scheduled_for DESC). Items are then reached through
      -- uq_collection_item (collection_run_id, ...), so the work is bounded
      -- by sources x runs, never a scan of all collection_items.
      SELECT r.id, r.source_id
      FROM sources src
      CROSS JOIN LATERAL (
        SELECT cr.id, cr.source_id
        FROM collection_runs cr
        WHERE cr.source_id = src.id
          AND cr.scheduled_for >= ${since}
        ORDER BY cr.scheduled_for DESC
        LIMIT ${RECENT_RUNS_PER_SOURCE}
      ) r
    )
    SELECT DISTINCT ON (cr.source_id, ci.source_item_key)
      s.code AS source_code,
      ci.external_id,
      ci.source_item_key,
      ci.updated_at AS last_failed_at,
      ci.raw_metadata,
      p.id AS publication_id,
      p.title,
      p.act_type,
      p.act_number,
      p.published_on,
      p.identity_strength,
      p.identity_basis,
      p.created_at AS publication_created_at,
      o.official_url,
      o.first_seen_at,
      o.last_seen_at AS origin_last_seen_at
    FROM recent_runs cr
    JOIN sources s ON s.id = cr.source_id
    JOIN collection_items ci ON ci.collection_run_id = cr.id
    LEFT JOIN publication_origins o
      ON o.source_id = cr.source_id
     AND (o.external_id = ci.external_id OR (ci.external_id IS NULL AND o.official_url = ci.source_url))
    LEFT JOIN publications p ON p.id = o.publication_id
    WHERE ci.status = 'FAILED'
      AND ci.error_message = ${CONFLICT_MESSAGE}
    ORDER BY cr.source_id, ci.source_item_key, ci.updated_at DESC
    LIMIT 20
  `.execute(db);

  const dou = await sql<{
    attempt_id: string;
    run_id: string;
    run_status: string;
    finished_at: Date | null;
    partial_failures: unknown;
    archives: unknown;
  }>`
    SELECT
      ca.id AS attempt_id,
      cr.id AS run_id,
      cr.status AS run_status,
      cr.finished_at,
      ca.metadata->'dou'->'partialFailures' AS partial_failures,
      ca.metadata->'dou'->'archives' AS archives
    FROM collection_attempts ca
    JOIN collection_runs cr ON cr.id = ca.collection_run_id
    JOIN sources s ON s.id = cr.source_id AND s.code = 'dou'
    WHERE ca.status = 'SUCCESS'
    ORDER BY ca.started_at DESC
    LIMIT 1
  `.execute(db);

  const douRow = dou.rows[0];
  const archives = Array.isArray(douRow?.archives) ? douRow.archives : [];

  return {
    sinceHours,
    itemFailures: failures.rows.map((row) => ({
      sourceCode: row.source_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      failures: row.failures,
      distinctItems: row.distinct_items,
      lastSeenAt: row.last_seen_at,
      sampleItemKeys: row.sample_keys ?? [],
    })),
    originConflicts: conflicts.rows.map((row) => ({
      sourceCode: row.source_code,
      externalId: row.external_id,
      sourceItemKey: row.source_item_key,
      lastFailedAt: row.last_failed_at,
      failedItemMetadata: pick(row.raw_metadata),
      linkedPublication: row.publication_id
        ? {
            id: row.publication_id,
            title: row.title ?? '',
            actType: row.act_type,
            actNumber: row.act_number,
            publishedOn: row.published_on ? new Date(row.published_on).toISOString().slice(0, 10) : null,
            identityStrength: row.identity_strength ?? '',
            identityBasis: row.identity_basis,
            createdAt: row.publication_created_at!,
          }
        : null,
      linkedOrigin: row.official_url
        ? { officialUrl: row.official_url, firstSeenAt: row.first_seen_at!, lastSeenAt: row.origin_last_seen_at! }
        : null,
    })),
    dou: douRow
      ? {
          attemptId: douRow.attempt_id,
          runId: douRow.run_id,
          runStatus: douRow.run_status,
          finishedAt: douRow.finished_at,
          partialFailures: Array.isArray(douRow.partial_failures) ? douRow.partial_failures : [],
          problemArchives: archives.filter((archive) => {
            const state = (archive as { state?: unknown })?.state;
            return state !== 'PARSED' && state !== 'UNCHANGED' && state !== 'NOT_AVAILABLE';
          }),
        }
      : null,
  };
}
