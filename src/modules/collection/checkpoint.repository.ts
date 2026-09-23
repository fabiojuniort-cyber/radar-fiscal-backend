import { createHash } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { ConnectorCheckpoint } from './connector.contract.js';

/** Current generation + 2 previous ones (recovery/rollback). */
export const CHECKPOINT_GENERATIONS_KEPT = 3;

export interface CheckpointRef {
  id: string;
  generation: number;
  version: number;
  sha256: string;
  bytes: number;
}

export interface StoredCheckpoint {
  id: string;
  generation: number;
  version: number;
  state: Record<string, unknown>;
  producedByRunId: string | null;
  producedByRunStatus: string | null;
  createdAt: Date;
}

/**
 * Deterministic JSON (sorted object keys). jsonb does not preserve key order,
 * so the integrity hash is computed over this canonical form on write and
 * verified the same way on read.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item ?? null)).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
    .join(',') + '}';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface WriteCheckpointInput {
  sourceId: string;
  connectorKey: string;
  runId: string;
  attemptId: string;
  checkpoint: ConnectorCheckpoint;
}

/**
 * Writes a new checkpoint generation inside the caller's transaction.
 *
 * Concurrency: generations are allocated under a transaction-scoped advisory
 * lock keyed by (source_id, connector_key), so two attempts can never compute
 * the same max(generation)+1; the UNIQUE constraint is the backstop.
 */
export async function writeCheckpoint(
  trx: Transaction<DB>,
  input: WriteCheckpointInput,
): Promise<CheckpointRef> {
  if (!Number.isSafeInteger(input.checkpoint.version) || input.checkpoint.version < 1) {
    throw new RangeError('checkpoint.version must be a positive integer');
  }
  const serialized = canonicalJson(input.checkpoint.state);
  const digest = sha256(serialized);
  const bytes = Buffer.byteLength(serialized, 'utf8');

  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.sourceId + ':' + input.connectorKey}, 0))`.execute(trx);

  const last = await trx
    .selectFrom('collection_checkpoints')
    .select(sql<string>`COALESCE(max(generation), 0)`.as('generation'))
    .where('source_id', '=', input.sourceId)
    .where('connector_key', '=', input.connectorKey)
    .executeTakeFirst();
  const generation = Number(last?.generation ?? 0) + 1;

  const inserted = await trx
    .insertInto('collection_checkpoints')
    .values({
      source_id: input.sourceId,
      connector_key: input.connectorKey,
      state_version: input.checkpoint.version,
      generation,
      payload: serialized,
      payload_sha256: digest,
      payload_bytes: bytes,
      produced_by_run_id: input.runId,
      produced_by_attempt_id: input.attemptId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await trx
    .deleteFrom('collection_checkpoints')
    .where('source_id', '=', input.sourceId)
    .where('connector_key', '=', input.connectorKey)
    .where('generation', '<=', String(generation - CHECKPOINT_GENERATIONS_KEPT))
    .execute();

  return { id: inserted.id, generation, version: input.checkpoint.version, sha256: digest, bytes };
}

export interface ReadCheckpointOptions {
  /** Only accept checkpoints whose producing run ended with one of these statuses. */
  acceptedRunStatuses?: string[];
  /** Only accept this state version (others are ignored, e.g. after a semantic bump). */
  stateVersion?: number;
}

/**
 * Newest retained checkpoint that passes integrity and acceptance checks.
 * Falls back to older retained generations when the newest is not acceptable
 * (e.g. its run failed), which is the purpose of keeping a few generations.
 */
export async function readCurrentCheckpoint(
  db: Kysely<DB>,
  sourceId: string,
  connectorKey: string,
  options: ReadCheckpointOptions = {},
): Promise<StoredCheckpoint | undefined> {
  let query = db
    .selectFrom('collection_checkpoints as cc')
    .leftJoin('collection_runs as cr', 'cr.id', 'cc.produced_by_run_id')
    .select([
      'cc.id',
      'cc.generation',
      'cc.state_version',
      'cc.payload',
      'cc.payload_sha256',
      'cc.produced_by_run_id',
      'cc.created_at',
      'cr.status as run_status',
    ])
    .where('cc.source_id', '=', sourceId)
    .where('cc.connector_key', '=', connectorKey)
    .orderBy('cc.generation', 'desc')
    .limit(CHECKPOINT_GENERATIONS_KEPT);
  if (options.stateVersion !== undefined) query = query.where('cc.state_version', '=', options.stateVersion);

  for (const row of await query.execute()) {
    if (options.acceptedRunStatuses && !options.acceptedRunStatuses.includes(row.run_status ?? '')) continue;
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (sha256(canonicalJson(payload)) !== row.payload_sha256) continue;
    return {
      id: row.id,
      generation: Number(row.generation),
      version: row.state_version,
      state: payload as Record<string, unknown>,
      producedByRunId: row.produced_by_run_id,
      producedByRunStatus: row.run_status,
      createdAt: row.created_at,
    };
  }
  return undefined;
}

/** true when the (source, connector) already has at least one stored checkpoint. */
export async function hasCheckpoint(db: Kysely<DB>, sourceId: string, connectorKey: string): Promise<boolean> {
  const row = await db
    .selectFrom('collection_checkpoints')
    .select('id')
    .where('source_id', '=', sourceId)
    .where('connector_key', '=', connectorKey)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
