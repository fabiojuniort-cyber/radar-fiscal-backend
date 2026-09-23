import 'dotenv/config';

import { hostname } from 'node:os';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { canonicalJson } from '../../modules/collection/checkpoint.repository.js';
import type { AcquiredCollectionRun } from '../../modules/collection/collection-run.repository.js';
import { processAcquiredCollectionRun } from '../../modules/collection/collection.engine.js';
import { buildConnectorRegistry } from '../../modules/collection/connector-registry.factory.js';
import type { CollectionConnector } from '../../modules/collection/connector.contract.js';
import { ConnectorRegistry } from '../../modules/collection/connector.registry.js';
import type { DB } from './database.types.js';

/**
 * Production gates of the Motor hardening (docs/hardening-motor.md).
 *
 *   npm run db:gate-hardening -- inspect [--since=ISO]
 *   npm run db:gate-hardening -- run <sped|nfe-encat> [--timeout-ms=N] [--grace-ms=N]
 *   npm run db:gate-hardening -- hang sped [--timeout-ms=60000]
 *
 * `run` executes ONE controlled run of the source through the real engine in
 * this process: the run row is created already owned by this gate (status
 * RUNNING, own worker id, heartbeat kept), so the production workers never
 * pick it and their COLLECTION_TIMEOUT_MS is untouched. `hang` uses a
 * connector that never returns, to prove the hard timeout (max 1 attempt, no
 * retry). `inspect` prints checkpoints (with SHA-256 verification), recent
 * runs and publication/version/origin totals for SPED and NF-e.
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const [mode, target] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

function intArg(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith('--' + name + '='));
  if (!raw) return undefined;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error('--' + name + ' must be a non-negative integer');
    process.exit(1);
  }
  return value;
}

function stringArg(name: string): string | undefined {
  const raw = process.argv.find((arg) => arg.startsWith('--' + name + '='));
  return raw ? raw.slice(name.length + 3) : undefined;
}

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 3 }) }),
});

async function sourceByConnector(connectorKey: string) {
  const code = connectorKey === 'nfe-encat' ? 'nfe-encat' : connectorKey;
  const source = await db.selectFrom('sources')
    .select(['id', 'code', 'connector_key', 'is_active'])
    .where('code', '=', code)
    .where('connector_key', '=', connectorKey)
    .executeTakeFirst();
  if (!source) throw new Error('Source not provisioned for connector ' + connectorKey);
  return source;
}

async function totals(sourceId: string) {
  const result = await sql<{
    publications: string;
    versions: string;
    origins: string;
    multi_version_publications: string;
    duplicate_origin_keys: string;
  }>`
    WITH pubs AS (
      SELECT DISTINCT publication_id FROM publication_origins WHERE source_id = ${sourceId}
    )
    SELECT
      (SELECT count(*) FROM pubs)::bigint AS publications,
      (SELECT count(*) FROM publication_versions pv JOIN pubs USING (publication_id))::bigint AS versions,
      (SELECT count(*) FROM publication_origins WHERE source_id = ${sourceId})::bigint AS origins,
      (SELECT count(*) FROM (
        SELECT pv.publication_id FROM publication_versions pv JOIN pubs USING (publication_id)
        GROUP BY pv.publication_id HAVING count(*) > 1
      ) m)::bigint AS multi_version_publications,
      (SELECT count(*) FROM (
        SELECT external_id FROM publication_origins
        WHERE source_id = ${sourceId} AND external_id IS NOT NULL
        GROUP BY external_id HAVING count(*) > 1
      ) d)::bigint AS duplicate_origin_keys
  `.execute(db);
  const row = result.rows[0]!;
  return {
    publications: Number(row.publications),
    versions: Number(row.versions),
    origins: Number(row.origins),
    multiVersionPublications: Number(row.multi_version_publications),
    duplicateOriginExternalIds: Number(row.duplicate_origin_keys),
  };
}

async function inspect(): Promise<void> {
  const since = stringArg('since');
  const report: Record<string, unknown> = {};
  for (const connectorKey of ['sped', 'nfe-encat']) {
    const source = await sourceByConnector(connectorKey);
    const checkpoints = await db.selectFrom('collection_checkpoints as cc')
      .leftJoin('collection_runs as cr', 'cr.id', 'cc.produced_by_run_id')
      .select([
        'cc.id', 'cc.generation', 'cc.state_version', 'cc.payload', 'cc.payload_sha256',
        'cc.payload_bytes', 'cc.produced_by_run_id', 'cc.created_at', 'cr.status as run_status',
      ])
      .where('cc.source_id', '=', source.id)
      .where('cc.connector_key', '=', connectorKey)
      .orderBy('cc.generation', 'desc')
      .execute();
    const { createHash } = await import('node:crypto');
    const runs = await db.selectFrom('collection_runs as cr')
      .select([
        'cr.id', 'cr.trigger_type', 'cr.status', 'cr.worker_id', 'cr.started_at', 'cr.finished_at',
        'cr.error_summary', 'cr.next_attempt_at',
        sql<unknown>`(
          SELECT jsonb_agg(jsonb_build_object(
            'attemptNo', ca.attempt_no,
            'status', ca.status,
            'errorCode', ca.error_code,
            'responseTimeMs', ca.response_time_ms,
            'publicationCount', ca.metadata->'publicationCount',
            'checkpointRef', ca.metadata->'checkpointRef',
            'completion', ca.metadata->'completion',
            'hasLegacyState', (ca.metadata ? 'spedState') OR (ca.metadata ? 'nfeEncatState'),
            'metadataBytes', pg_column_size(ca.metadata)
          ) ORDER BY ca.attempt_no)
          FROM collection_attempts ca WHERE ca.collection_run_id = cr.id
        )`.as('attempts'),
      ])
      .where('cr.source_id', '=', source.id)
      .orderBy('cr.created_at', 'desc')
      .limit(6)
      .execute();
    const versionsSince = since
      ? await sql<{ versions: string; publications: string }>`
          SELECT
            (SELECT count(*) FROM publication_versions pv
               WHERE pv.publication_id IN (SELECT publication_id FROM publication_origins WHERE source_id = ${source.id})
                 AND pv.captured_at >= ${since}::timestamptz)::bigint AS versions,
            (SELECT count(*) FROM publications p
               WHERE p.id IN (SELECT publication_id FROM publication_origins WHERE source_id = ${source.id})
                 AND p.created_at >= ${since}::timestamptz)::bigint AS publications
        `.execute(db)
      : undefined;

    report[connectorKey] = {
      sourceId: source.id,
      checkpoints: checkpoints.map((row) => {
        const payload = row.payload as Record<string, unknown>;
        return {
          id: row.id,
          generation: Number(row.generation),
          stateVersion: row.state_version,
          bytes: row.payload_bytes,
          sha256: row.payload_sha256,
          sha256Valid: createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex') === row.payload_sha256,
          producedByRunId: row.produced_by_run_id,
          producedByRunStatus: row.run_status,
          createdAt: row.created_at,
          items: Object.keys((payload.items as Record<string, unknown> | undefined) ?? {}).length,
          pages: Object.keys((payload.pages as Record<string, unknown> | undefined) ?? {}).length,
          cycle: payload.cycle
            ? {
                completedModules: (payload.cycle as { completedModules?: unknown[] }).completedModules ?? [],
                frontier: ((payload.cycle as { frontier?: unknown[] }).frontier ?? []).length,
              }
            : null,
        };
      }),
      runs,
      totals: await totals(source.id),
      ...(versionsSince ? {
        createdSince: {
          since,
          publications: Number(versionsSince.rows[0]!.publications),
          versions: Number(versionsSince.rows[0]!.versions),
        },
      } : {}),
    };
  }
  const tables = await sql<{ table_name: string; rows: string }>`
    SELECT 'collection_checkpoints' AS table_name, count(*)::bigint AS rows FROM collection_checkpoints
    UNION ALL SELECT 'db_capacity_snapshots', count(*)::bigint FROM db_capacity_snapshots
  `.execute(db);
  const migrations = await sql<{ filename: string; applied_at: Date }>`
    SELECT filename, applied_at FROM schema_migrations
    WHERE filename IN ('012_collection_checkpoints.sql', '013_db_capacity_snapshots.sql')
    ORDER BY filename
  `.execute(db).catch(() => ({ rows: [] as Array<{ filename: string; applied_at: Date }> }));
  console.log('HARDENING_INSPECTION=' + JSON.stringify({
    databaseUser: (await sql<{ u: string }>`SELECT current_user AS u`.execute(db)).rows[0]?.u,
    migrations: migrations.rows,
    tables: tables.rows,
    ...report,
  }));
}

/** Creates a run already owned by this gate (never visible to the workers' queue). */
async function ownedRun(connectorKey: string, workerId: string): Promise<AcquiredCollectionRun> {
  return db.transaction().execute(async (trx) => {
    const source = await trx.selectFrom('sources')
      .select(['id', 'connector_key', 'is_active', 'max_attempts'])
      .where('code', '=', connectorKey)
      .where('connector_key', '=', connectorKey)
      .executeTakeFirst();
    if (!source || !source.is_active) throw new Error('Active source not found for ' + connectorKey);
    // Least privilege: the worker role cannot lock sources rows (FOR UPDATE
    // needs UPDATE); gates serialize among themselves with an advisory lock.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'gate-hardening:' + source.id}, 0))`.execute(trx);
    const active = await trx.selectFrom('collection_runs')
      .select(['id', 'status'])
      .where('source_id', '=', source.id)
      .where('status', 'in', ['PENDING', 'RUNNING'])
      .executeTakeFirst();
    if (active) throw new Error(connectorKey + ' already has an active run: ' + active.id + ' (' + active.status + ')');
    const now = new Date();
    const run = await trx.insertInto('collection_runs')
      .values({
        source_id: source.id,
        scheduled_for: now,
        trigger_type: 'MANUAL',
        status: 'RUNNING',
        started_at: now,
        worker_id: workerId,
        locked_at: now,
        heartbeat_at: now,
      })
      .returning(['id', 'correlation_id'])
      .executeTakeFirstOrThrow();
    return {
      id: run.id,
      sourceId: source.id,
      connectorKey,
      // Gates never retry: one attempt, one observable result.
      maxAttempts: 1,
      correlationId: run.correlation_id,
      workerId,
    };
  });
}

const logger = {
  info: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'info', message, ...bindings })),
  warn: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'warn', message, ...bindings })),
  error: (bindings: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'error', message, ...bindings })),
};

async function runGate(connectorKey: string, hang: boolean): Promise<void> {
  if (connectorKey !== 'sped' && connectorKey !== 'nfe-encat') {
    throw new Error('connector must be sped or nfe-encat');
  }
  const timeoutMs = intArg('timeout-ms') ?? (hang ? 60_000 : Number(process.env.COLLECTION_TIMEOUT_MS ?? 1_200_000));
  const graceArg = intArg('grace-ms') ?? (process.env.COLLECTION_BUDGET_GRACE_MS ? Number(process.env.COLLECTION_BUDGET_GRACE_MS) : undefined);
  if (graceArg !== undefined && graceArg >= timeoutMs) throw new Error('grace must be lower than timeout');

  let registry: ConnectorRegistry;
  if (hang) {
    registry = new ConnectorRegistry();
    const stuck: CollectionConnector = {
      key: connectorKey,
      // A truly stuck execution: never resolves and ignores the abort signal.
      collect: () => new Promise(() => undefined),
    };
    registry.register(stuck);
  } else {
    registry = buildConnectorRegistry({ db, includeDou: false });
  }

  const before = await totals((await sourceByConnector(connectorKey)).id);
  const workerId = 'gate-hardening-' + hostname() + '-' + process.pid;
  const acquired = await ownedRun(connectorKey, workerId);
  const startedAt = Date.now();
  const result = await processAcquiredCollectionRun(db, registry, acquired, {
    timeoutMs,
    ...(graceArg !== undefined ? { budgetGraceMs: graceArg } : {}),
    heartbeatIntervalMs: 15_000,
    logger,
  });
  const after = await totals(acquired.sourceId);
  const run = await db.selectFrom('collection_runs')
    .select(['status', 'error_summary', 'next_attempt_at', 'finished_at'])
    .where('id', '=', acquired.id)
    .executeTakeFirstOrThrow();
  const attempts = await db.selectFrom('collection_attempts')
    .select(['attempt_no', 'status', 'error_code', 'response_time_ms', sql<unknown>`metadata->'completion'`.as('completion'), sql<unknown>`metadata->'checkpointRef'`.as('checkpoint_ref')])
    .where('collection_run_id', '=', acquired.id)
    .orderBy('attempt_no')
    .execute();
  console.log('HARDENING_GATE=' + JSON.stringify({
    mode: hang ? 'HANG' : 'RUN',
    connectorKey,
    runId: acquired.id,
    timeoutMs,
    budgetGraceMs: graceArg ?? 'default',
    wallMs: Date.now() - startedAt,
    engineStatus: result.status,
    metrics: result.metrics,
    run,
    attempts,
    totalsBefore: before,
    totalsAfter: after,
    delta: {
      publications: after.publications - before.publications,
      versions: after.versions - before.versions,
      origins: after.origins - before.origins,
    },
  }));
}

try {
  if (mode === 'inspect') await inspect();
  else if (mode === 'run' && target) await runGate(target, false);
  else if (mode === 'hang' && target) await runGate(target, true);
  else {
    console.error('usage: gate-hardening inspect [--since=ISO] | run <sped|nfe-encat> [--timeout-ms=N] [--grace-ms=N] | hang <sped|nfe-encat> [--timeout-ms=N]');
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
// A stuck connector leaves a pending promise behind; the gate is done.
process.exit(process.exitCode ?? 0);
