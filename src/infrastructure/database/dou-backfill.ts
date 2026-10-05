import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { isCronDue } from '../../modules/collection/cron.js';
import {
  DouBackfillBlockedError,
  addDays,
  douBackfillBatches,
  planDouBackfillDates,
  readDouBackfillCoverage,
  runDouBackfillBatch,
  saoPauloDate,
} from '../../modules/collection/dou-backfill.js';
import type { DB } from './database.types.js';

/**
 * Administrative DOU backfill (R3 when run with --apply).
 *
 *   npm run db:dou-backfill -- [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--apply]
 *                              [--max-batches=N] [--guard-minutes=N] [--timeout-ms=N]
 *
 * Default range: first day of the previous month .. three days ago (São
 * Paulo), i.e. the dates the monitoring reconciliation would otherwise reach
 * only by rotation. Without --apply it only prints the plan. With --apply it
 * runs the missing dates, most recent first, in BACKFILL runs of up to four
 * dates, one at a time, through the regular engine. It never starts a batch
 * when the DOU source has an open run or a scheduled cycle is due within
 * --guard-minutes (default 20), so monitoring keeps priority.
 */

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    console.error(`--${name} must be an integer between 1 and ${max}.`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL (or DATABASE_ADMIN_URL) is required.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const today = saoPauloDate(new Date());
const [year, month] = today.split('-').map(Number) as [number, number];
const previousMonthStart = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
const from = arg('from') ?? previousMonthStart;
const to = arg('to') ?? addDays(today, -3);
const maxBatches = positiveInt('max-batches', 20, 500);
const guardMinutes = positiveInt('guard-minutes', 20, 240);
const timeoutMs = positiveInt('timeout-ms', Number(process.env.COLLECTION_TIMEOUT_MS ?? 900_000), 3_600_000);

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 3 }) }),
});

const logger = {
  info: (data: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'info', message, ...data })),
  warn: (data: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'warn', message, ...data })),
  error: (data: Record<string, unknown>, message: string) => console.log(JSON.stringify({ level: 'error', message, ...data })),
};

function minutesToNextCycle(cron: string | null, timezone: string, now: Date): number | undefined {
  if (!cron) return undefined;
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let minute = 0; minute <= guardMinutes; minute += 1) {
    if (isCronDue(cron, new Date(start + minute * 60_000), timezone)) return minute;
  }
  return undefined;
}

try {
  const source = await db.selectFrom('sources')
    .select(['id', 'schedule_cron', 'schedule_timezone', 'is_active', 'connector_key'])
    .where('code', '=', 'dou')
    .executeTakeFirst();
  if (!source || source.connector_key !== 'dou' || !source.is_active) {
    throw new DouBackfillBlockedError('DOU source is not provisioned and active.');
  }

  const coverage = await readDouBackfillCoverage(db, source.id);
  const dates = planDouBackfillDates({ from, to, today, covered: coverage.covered });
  const batches = douBackfillBatches(dates).slice(0, maxBatches);
  console.log('DOU_BACKFILL_PLAN=' + JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    from, to, today,
    missingDates: dates,
    batches,
    skippedBatches: Math.max(0, douBackfillBatches(dates).length - batches.length),
  }));

  if (apply) {
    if (!process.env.INLABS_EMAIL || !process.env.INLABS_PASSWORD) {
      throw new DouBackfillBlockedError('INLABS_EMAIL and INLABS_PASSWORD are required.');
    }
    const credentials = () => ({ email: process.env.INLABS_EMAIL!, password: process.env.INLABS_PASSWORD! });
    const workerId = `dou-backfill-${randomUUID().slice(0, 8)}`;
    const summary = { runs: 0, newPublications: 0, existingPublications: 0, newVersions: 0, itemErrors: 0, partialFailures: 0 };
    for (const batch of batches) {
      const dueIn = minutesToNextCycle(source.schedule_cron, source.schedule_timezone, new Date());
      if (dueIn !== undefined) {
        console.log('DOU_BACKFILL_PAUSED=' + JSON.stringify({ reason: 'SCHEDULED_CYCLE_DUE', minutes: dueIn, remainingBatches: batches.slice(batches.indexOf(batch)) }));
        break;
      }
      const result = await runDouBackfillBatch(db, {
        sourceId: source.id,
        dates: batch,
        workerId,
        credentials,
        receipts: coverage.receipts,
        timeoutMs,
        logger,
      });
      const metrics = result.result.metrics;
      summary.runs += 1;
      summary.newPublications += metrics.newPublications;
      summary.existingPublications += metrics.existingPublications;
      summary.newVersions += metrics.newVersions;
      summary.itemErrors += metrics.itemErrors;
      summary.partialFailures += metrics.connectorPartialFailures;
      console.log('DOU_BACKFILL_RUN=' + JSON.stringify({
        runId: result.runId,
        dates: result.dates,
        attempts: result.attempts,
        status: result.retryLimitReached ? 'SOURCE_UNAVAILABLE' : result.result.status,
        ...(result.retryLimitReached ? { retryLimitReached: true } : {}),
        metrics,
      }));
      if (result.retryLimitReached || (result.result.status !== 'SUCCESS' && result.result.status !== 'SUCCESS_NO_RESULTS' && result.result.status !== 'PARTIAL_SUCCESS')) {
        console.log('DOU_BACKFILL_STOPPED=' + JSON.stringify({ reason: 'BATCH_NOT_SUCCESSFUL', runId: result.runId }));
        break;
      }
    }
    console.log('DOU_BACKFILL_SUMMARY=' + JSON.stringify(summary));
  }
} catch (error) {
  if (error instanceof DouBackfillBlockedError) {
    console.error('DOU_BACKFILL_BLOCKED=' + error.message);
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await db.destroy();
}
