import 'dotenv/config';

import {
  Kysely,
  PostgresDialect,
} from 'kysely';
import { Pool } from 'pg';

import type { DB } from './database.types.js';
import { runSchedulerTick } from '../../modules/collection/scheduler.service.js';

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required to run the NF-e/ENCAT scheduler gate.',
  );
  process.exit(1);
}

function saoPauloHour(date: Date): number {
  const hour = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hourCycle: 'h23',
    },
  ).format(date);

  return Number(hour);
}

function gateSlot(now: Date): Date {
  const candidate = new Date(now);
  candidate.setUTCMinutes(0, 0, 0);

  const douHours = new Set([8, 12, 16, 20]);

  for (let offset = 0; offset < 6; offset += 1) {
    if (!douHours.has(saoPauloHour(candidate))) {
      return candidate;
    }

    candidate.setUTCHours(
      candidate.getUTCHours() - 1,
    );
  }

  throw new Error(
    'Unable to find a safe scheduler gate slot.',
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

try {
  const source = await db
    .selectFrom('sources')
    .select([
      'id',
      'schedule_cron',
      'schedule_timezone',
      'is_active',
    ])
    .where('code', '=', 'nfe-encat')
    .executeTakeFirst();

  if (!source) {
    throw new Error(
      'NF-e/ENCAT source is not provisioned.',
    );
  }

  if (
    source.is_active !== true ||
    source.schedule_cron !== '0 * * * *' ||
    source.schedule_timezone !== 'America/Sao_Paulo'
  ) {
    throw new Error(
      'NF-e/ENCAT source must be active with the approved hourly schedule before the scheduler gate.',
    );
  }

  const now = new Date();
  const scheduledFor = gateSlot(now);
  const result = await runSchedulerTick(
    db,
    scheduledFor,
  );

  const runs = await db
    .selectFrom('collection_runs')
    .select([
      'id',
      'source_id',
      'trigger_type',
      'status',
      'scheduled_for',
    ])
    .where('source_id', '=', source.id)
    .where('trigger_type', '=', 'SCHEDULED')
    .where('scheduled_for', '=', scheduledFor)
    .execute();

  console.log(
    'NFE_ENCAT_SCHEDULER_GATE=' +
      JSON.stringify({
        scheduledFor:
          scheduledFor.toISOString(),
        schedulerResult: result,
        nfeRuns: runs.map((run) => ({
          ...run,
          scheduled_for:
            run.scheduled_for.toISOString(),
        })),
      }),
  );
} finally {
  await db.destroy();
}
