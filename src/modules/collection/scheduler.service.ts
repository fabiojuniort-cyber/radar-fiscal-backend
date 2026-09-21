import type { Kysely } from 'kysely';

import type { DB } from '../../infrastructure/database/database.types.js';
import type { ProcessLogger } from '../../infrastructure/logging/process-logger.js';
import { createCollectionRun } from './collection-run.repository.js';
import {
  floorToUtcMinute,
  isCronDue,
} from './cron.js';

export interface SchedulerTickResult {
  evaluatedSources: number;
  dueSources: number;
  runIds: string[];
  invalidSchedules: number;
}

export async function runSchedulerTick(
  db: Kysely<DB>,
  now: Date,
  logger?: ProcessLogger,
): Promise<SchedulerTickResult> {
  const sources = await db
    .selectFrom('sources')
    .select([
      'id',
      'code',
      'schedule_cron',
      'schedule_timezone',
      'connector_key',
    ])
    .where('is_active', '=', true)
    .where('schedule_cron', 'is not', null)
    .execute();

  const scheduledFor =
    floorToUtcMinute(now);

  const runIds: string[] = [];
  let dueSources = 0;
  let invalidSchedules = 0;

  for (const source of sources) {
    try {
      if (
        !isCronDue(
          source.schedule_cron!,
          scheduledFor,
          source.schedule_timezone,
        )
      ) {
        continue;
      }

      dueSources += 1;

      if (source.connector_key === 'dou') {
        const activeDouRun = await db
          .selectFrom('collection_runs')
          .select([
            'id',
            'scheduled_for',
            'trigger_type',
          ])
          .where('source_id', '=', source.id)
          .where('status', 'in', ['PENDING', 'RUNNING'])
          .orderBy('created_at')
          .executeTakeFirst();

        if (activeDouRun) {
          const sameScheduledSlot =
            activeDouRun.trigger_type === 'SCHEDULED' &&
            activeDouRun.scheduled_for.getTime() ===
              scheduledFor.getTime();

          if (sameScheduledSlot) {
            runIds.push(activeDouRun.id);

            logger?.info(
              {
                sourceId: source.id,
                sourceCode: source.code,
                runId: activeDouRun.id,
                scheduledFor:
                  scheduledFor.toISOString(),
              },
              'Scheduled DOU run already exists for this slot',
            );

            continue;
          }

          logger?.info(
            {
              sourceId: source.id,
              sourceCode: source.code,
              activeRunId: activeDouRun.id,
              scheduledFor:
                scheduledFor.toISOString(),
            },
            'Scheduled DOU run skipped because an active DOU run already exists',
          );

          continue;
        }
      }

      const runId = await createCollectionRun(
        db,
        {
          sourceId: source.id,
          scheduledFor,
          triggerType: 'SCHEDULED',
        },
      );

      runIds.push(runId);

      logger?.info(
        {
          sourceId: source.id,
          sourceCode: source.code,
          runId,
          scheduledFor:
            scheduledFor.toISOString(),
        },
        'Scheduled collection run ensured',
      );
    } catch (error) {
      invalidSchedules += 1;

      logger?.error(
        {
          sourceId: source.id,
          sourceCode: source.code,
          scheduleCron: source.schedule_cron,
          scheduleTimezone:
            source.schedule_timezone,
          error:
            error instanceof Error
              ? error.message
              : 'Unknown scheduler error',
        },
        'Source schedule could not be evaluated',
      );
    }
  }

  return {
    evaluatedSources: sources.length,
    dueSources,
    runIds,
    invalidSchedules,
  };
}
