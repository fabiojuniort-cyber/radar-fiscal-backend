import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { isCronDue } from '../../modules/collection/cron.js';
import {
  DouBackfillBlockedError,
  addDays,
  assertDouBackfillAvailable,
  douBackfillBatches,
  planDouBackfillDates,
  planDouExplicitReplayDates,
  readDouBackfillCoverage,
  runDouBackfillBatch,
  saoPauloDate,
} from '../../modules/collection/dou-backfill.js';
import type { DB } from './database.types.js';
import { DOU_XML_SECTIONS } from '../../modules/collection/dou.connector.js';
import type { InlabsXmlSection } from '../../modules/collection/inlabs.client.js';

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
const explicitRaw = arg('dates');
const sectionsRaw = arg('sections');
const forceCovered = process.argv.includes('--force-covered');
const replayAck = process.argv.includes('--ack-l18-81');
if (forceCovered !== Boolean(explicitRaw) || forceCovered !== Boolean(sectionsRaw)) {
  throw new Error('Explicit restoration requires --dates, --sections, and --force-covered together.');
}
if (forceCovered && apply && !replayAck) {
  throw new Error('Force replay requires the separate --ack-l18-81 flag before --apply.');
}
if (replayAck && !forceCovered) throw new Error('--ack-l18-81 is only valid with forced replay.');
const requestedDates = explicitRaw?.split(',').map(value => value.trim()) ?? [];
const requestedSections = sectionsRaw?.split(',').map(value => value.trim()) ?? [];
if (forceCovered && (requestedSections.length !== 3
  || requestedSections.join(',') !== 'DO1,DO1E,DO3'
  || requestedSections.some(section => !DOU_XML_SECTIONS.includes(section as InlabsXmlSection)))) {
  throw new Error('L18 replay must use exactly --sections=DO1,DO1E,DO3.');
}
const selectedSections = forceCovered
  ? requestedSections as InlabsXmlSection[] : undefined;
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

  // Applying cannot proceed while the source is busy; reject before loading
  // its archive history. Dry runs still show the plan even during a live run.
  if (apply) await assertDouBackfillAvailable(db, source.id);

  const coverage = await readDouBackfillCoverage(db, source.id);
  const dates = forceCovered
    ? planDouExplicitReplayDates({ dates: requestedDates, today })
    : planDouBackfillDates({ from, to, today, covered: coverage.covered });
  if (forceCovered && dates.length !== 26) {
    throw new DouBackfillBlockedError('L18 replay requires exactly 26 distinct dates from the approved manifest.');
  }
  const batches = douBackfillBatches(dates).slice(0, maxBatches);
  if (forceCovered && batches.length !== douBackfillBatches(dates).length) {
    throw new DouBackfillBlockedError('L18 replay must not silently truncate the 26 dates.');
  }
  console.log('DOU_BACKFILL_PLAN=' + JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    from, to, today,
    ...(forceCovered ? { replayCoveredDates: true, sections: selectedSections } : {}),
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
    const summary = {
      runs: 0, newPublications: 0, existingPublications: 0,
      newVersions: 0, itemErrors: 0, partialFailures: 0,
      found: 0, processed: 0, discardedByFilter: 0,
      missingDiscardStatsRuns: [] as string[], attemptedDates: [] as string[],
      runIds: [] as string[],
    };
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
        receipts: forceCovered ? {} : coverage.receipts,
        ...(selectedSections ? { sections: selectedSections } : {}),
        timeoutMs,
        logger,
      });
      const metrics = result.result.metrics;
      summary.runs += 1;
      summary.runIds.push(result.runId);
      summary.attemptedDates.push(...result.dates);
      summary.found += metrics.found;
      summary.processed += metrics.processed;
      const filterStats = await sql<{ discard_count: number }>`
        SELECT discard_count FROM public.collection_filter_discard_run_stats
        WHERE collection_run_id = ${result.runId}::uuid
      `.execute(db);
      const discardCount = filterStats.rows[0]?.discard_count;
      if (discardCount !== undefined) summary.discardedByFilter += discardCount;
      else summary.missingDiscardStatsRuns.push(result.runId);
      summary.newPublications += metrics.newPublications;
      summary.existingPublications += metrics.existingPublications;
      summary.newVersions += metrics.newVersions;
      summary.itemErrors += metrics.itemErrors;
      summary.partialFailures += metrics.connectorPartialFailures;
      console.log('DOU_BACKFILL_RUN=' + JSON.stringify({
        discardedByFilter: discardCount ?? null,
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
    if (forceCovered) {
      summary.attemptedDates = [...new Set(summary.attemptedDates)].sort();
      console.log('DOU_L18_REPLAY_REPORT=' + JSON.stringify({
        ...summary, expectedOriginalPublications: 81,
        expectedDates: 26, targetSections: selectedSections,
        originalRecovered: null,
        originalRecoveryEvidence: 'PENDING_INDIVIDUAL_RECONCILIATION',
        note: 'Run counters do not prove which of the 81 original titles returned.',
      }));
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
