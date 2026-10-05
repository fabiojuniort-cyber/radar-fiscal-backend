import { sql, type Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import {
  processAcquiredCollectionRun,
  type CollectionEngineLogger,
  type CollectionEngineResult,
} from './collection.engine.js';
import { finishCollectionRun, type AcquiredCollectionRun } from './collection-run.repository.js';
import { ConnectorRegistry } from './connector.registry.js';
import { DouConnector } from './dou.connector.js';
import type { InlabsCredentials } from './inlabs.client.js';

/**
 * Administrative DOU backfill (docs/phase-5-dou-inlabs.md, D-056).
 *
 * Fills dates the regular monitoring never collected (before the source was
 * activated, or while it was blocked). Each batch of at most four dates runs
 * as one `BACKFILL` collection run through the regular engine, so
 * persistence, identity and publication_origins rules are exactly the
 * monitoring ones. BACKFILL runs never feed the monitoring checkpoint
 * (readDouSourceState ignores them) and the worker refuses to execute them
 * without an explicit batch, so a run picked up by the worker fails closed.
 */

export const DOU_BACKFILL_MAX_DATES_PER_RUN = 4;
export const DOU_BACKFILL_SECTIONS = ['DO1', 'DO2', 'DO3', 'DO1E', 'DO2E', 'DO3E'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function validDate(value: string): boolean {
  return DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Calendar day in São Paulo, YYYY-MM-DD. */
export function saoPauloDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Dates in [from, to] not yet covered, most recent first (D-056: the backfill
 * walks back one day at a time). The three most recent days belong to the
 * monitoring window and are never planned here.
 */
export function planDouBackfillDates(input: {
  from: string;
  to: string;
  today: string;
  covered: ReadonlySet<string>;
}): string[] {
  if (!validDate(input.from) || !validDate(input.to) || !validDate(input.today)) {
    throw new RangeError('Backfill dates must be valid YYYY-MM-DD dates.');
  }
  const lastAllowed = addDays(input.today, -3);
  const to = input.to < lastAllowed ? input.to : lastAllowed;
  if (input.from > to) return [];
  const dates: string[] = [];
  for (let date = to; date >= input.from; date = addDays(date, -1)) {
    if (!input.covered.has(date)) dates.push(date);
  }
  return dates;
}

export function douBackfillBatches(dates: readonly string[], size = DOU_BACKFILL_MAX_DATES_PER_RUN): string[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > DOU_BACKFILL_MAX_DATES_PER_RUN) {
    throw new RangeError(`Batch size must be between 1 and ${DOU_BACKFILL_MAX_DATES_PER_RUN}.`);
  }
  const batches: string[][] = [];
  for (let index = 0; index < dates.length; index += size) batches.push(dates.slice(index, index + size));
  return batches;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface DouBackfillCoverage {
  /** Archive receipts (filename -> SHA-256) usable to skip unchanged packages. */
  receipts: Record<string, string>;
  /** Dates already collected (receipt) or fully consulted by a successful backfill. */
  covered: Set<string>;
}

/**
 * Coverage = dates with any archive receipt in the latest successful
 * monitoring checkpoint, plus dates whose six packages were all consulted
 * (parsed, unchanged or not available) by a successful backfill run. Dates
 * without an edition therefore become covered once a backfill has checked
 * them and are not consulted again.
 */
export async function readDouBackfillCoverage(db: Kysely<DB>, sourceId: string): Promise<DouBackfillCoverage> {
  const receipts: Record<string, string> = {};
  const covered = new Set<string>();

  const monitoring = await db.selectFrom('collection_attempts as ca')
    .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
    .select(['ca.metadata'])
    .where('cr.source_id', '=', sourceId)
    .where('cr.status', 'in', ['SUCCESS', 'SUCCESS_NO_RESULTS'])
    .where('ca.status', '=', 'SUCCESS')
    .where('cr.trigger_type', '!=', 'BACKFILL')
    .orderBy('cr.finished_at', 'desc')
    .orderBy('ca.attempt_no', 'desc')
    .executeTakeFirst();
  const rawReceipts = record(record(monitoring?.metadata)?.douArchives);
  for (const [name, value] of Object.entries(rawReceipts ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}-DO[123]E?\.zip$/.test(name) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) {
      receipts[name] = value;
      covered.add(name.slice(0, 10));
    }
  }

  const backfills = await db.selectFrom('collection_attempts as ca')
    .innerJoin('collection_runs as cr', 'cr.id', 'ca.collection_run_id')
    .select([sql<unknown>`ca.metadata -> 'dou' -> 'archives'`.as('archives')])
    .where('cr.source_id', '=', sourceId)
    .where('cr.trigger_type', '=', 'BACKFILL')
    .where('cr.status', 'in', ['SUCCESS', 'SUCCESS_NO_RESULTS'])
    .where('ca.status', '=', 'SUCCESS')
    .execute();
  const consulted = new Map<string, Set<string>>();
  for (const row of backfills) {
    if (!Array.isArray(row.archives)) continue;
    for (const raw of row.archives) {
      const archive = record(raw);
      const date = archive?.date;
      const section = archive?.section;
      const state = archive?.state;
      if (typeof date !== 'string' || !validDate(date) || typeof section !== 'string') continue;
      if (state !== 'PARSED' && state !== 'UNCHANGED' && state !== 'NOT_AVAILABLE') continue;
      const sections = consulted.get(date) ?? new Set<string>();
      sections.add(section);
      consulted.set(date, sections);
      if ((state === 'PARSED' || state === 'UNCHANGED') && typeof archive?.rawSha256 === 'string' &&
          typeof archive.filename === 'string' && /^[a-f0-9]{64}$/.test(archive.rawSha256)) {
        receipts[archive.filename] = archive.rawSha256;
      }
    }
  }
  for (const [date, sections] of consulted) {
    if (DOU_BACKFILL_SECTIONS.every((section) => sections.has(section))) covered.add(date);
  }

  return { receipts, covered };
}

export class DouBackfillBlockedError extends Error {}

/**
 * Creates the BACKFILL run already owned by `workerId`, in one transaction,
 * so the regular worker can never acquire it. Refuses when the source has an
 * open run (monitoring keeps priority; one active run per source).
 */
async function createOwnedBackfillRun(db: Kysely<DB>, sourceId: string, workerId: string): Promise<AcquiredCollectionRun> {
  return db.transaction().execute(async (trx) => {
    // Same serialization as the operator pause: a Scheduler insert in flight
    // commits first (and is seen below) or waits for this transaction.
    await sql`LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
    const source = await trx.selectFrom('sources')
      .select(['id', 'connector_key', 'is_active', 'max_attempts'])
      .where('id', '=', sourceId)
      .executeTakeFirst();
    if (!source || source.connector_key !== 'dou' || !source.is_active) {
      throw new DouBackfillBlockedError('DOU source is not active with connector key dou.');
    }
    const open = await trx.selectFrom('collection_runs')
      .select(['id', 'status', 'trigger_type'])
      .where('source_id', '=', sourceId)
      .where('status', 'in', ['PENDING', 'RUNNING'])
      .executeTakeFirst();
    if (open) {
      throw new DouBackfillBlockedError(`DOU has an open ${open.trigger_type} run ${open.id} (${open.status}).`);
    }
    const now = new Date();
    const run = await trx.insertInto('collection_runs')
      .values({
        source_id: sourceId,
        scheduled_for: now,
        trigger_type: 'BACKFILL',
        status: 'RUNNING',
        started_at: now,
        worker_id: workerId,
        locked_at: now,
        heartbeat_at: now,
      })
      .returning(['id', 'source_id', 'correlation_id'])
      .executeTakeFirstOrThrow();
    return {
      id: run.id,
      sourceId: run.source_id,
      connectorKey: 'dou',
      maxAttempts: source.max_attempts,
      correlationId: run.correlation_id,
      workerId,
    };
  });
}

/** Re-takes ownership right after a scheduled retry, before any worker can. */
async function reclaimRun(db: Kysely<DB>, runId: string, workerId: string): Promise<void> {
  const now = new Date();
  const updated = await db.updateTable('collection_runs')
    .set({ worker_id: workerId, locked_at: now, heartbeat_at: now, next_attempt_at: null, updated_at: now })
    .where('id', '=', runId)
    .where('status', '=', 'RUNNING')
    .where('worker_id', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!updated) throw new DouBackfillBlockedError(`Backfill run ${runId} could not be reclaimed.`);
}

export interface DouBackfillBatchOptions {
  sourceId: string;
  dates: string[];
  workerId: string;
  credentials: () => InlabsCredentials | undefined;
  receipts?: Record<string, string>;
  /** Attempts per batch, including transient INLABS retries. */
  maxAttempts?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger?: CollectionEngineLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface DouBackfillBatchResult {
  runId: string;
  dates: string[];
  attempts: number;
  result: CollectionEngineResult;
  /** Set when the batch stopped at the attempt limit (run closed as SOURCE_UNAVAILABLE). */
  retryLimitReached?: true;
}

export async function runDouBackfillBatch(db: Kysely<DB>, options: DouBackfillBatchOptions): Promise<DouBackfillBatchResult> {
  if (!options.dates.length || options.dates.length > DOU_BACKFILL_MAX_DATES_PER_RUN || !options.dates.every(validDate)) {
    throw new RangeError(`A DOU backfill batch needs 1 to ${DOU_BACKFILL_MAX_DATES_PER_RUN} valid dates.`);
  }
  const lastAllowed = addDays(saoPauloDate(options.now?.() ?? new Date()), -3);
  if (options.dates.some((date) => date > lastAllowed)) {
    throw new RangeError('DOU backfill only covers dates older than the monitoring window (today - 3).');
  }
  const maxAttempts = options.maxAttempts ?? 8;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const receipts = options.receipts ?? {};

  const registry = new ConnectorRegistry();
  registry.register(new DouConnector({
    credentials: options.credentials,
    dates: options.dates,
    // Only past dates are planned (never the monitoring window), so a batch
    // without editions is final, not pending availability.
    allowEmptyBatch: true,
    readState: async () => ({ archives: receipts }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }));

  const run = await createOwnedBackfillRun(db, options.sourceId, options.workerId);
  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await processAcquiredCollectionRun(db, registry, run, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    if (result.state === 'TERMINAL') return { runId: run.id, dates: options.dates, attempts, result };

    // DOU retries transient INLABS failures indefinitely in the engine; the
    // backfill bounds them and never leaves a run for the worker to pick up.
    await reclaimRun(db, run.id, run.workerId);
    if (attempts >= maxAttempts) {
      await finishCollectionRun(db, {
        runId: run.id,
        workerId: run.workerId,
        status: 'SOURCE_UNAVAILABLE',
        errorSummary: `DOU_BACKFILL_RETRY_LIMIT: ${attempts} attempts`,
      });
      return { runId: run.id, dates: options.dates, attempts, result, retryLimitReached: true };
    }
    const waitMs = Math.max(0, (result.nextAttemptAt?.getTime() ?? Date.now()) - Date.now());
    await sleep(waitMs);
  }
}
