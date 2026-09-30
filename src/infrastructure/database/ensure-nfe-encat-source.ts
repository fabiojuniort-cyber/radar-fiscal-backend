import 'dotenv/config';

import { Pool } from 'pg';

import { d056ScheduleFor } from '../../modules/collection/schedule-policy.js';

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the NF-e/ENCAT source.',
  );
  process.exit(1);
}

// --scheduled applies the D-056 cycles (06h/10h/14h/18h BRT); --hourly is
// kept only for an explicit, recorded exception.
const scheduled = process.argv.includes('--scheduled');
const hourly = process.argv.includes('--hourly');
if (scheduled && hourly) {
  console.error('Use either --scheduled or --hourly, not both.');
  process.exit(1);
}
const scheduleCron = scheduled ? d056ScheduleFor('nfe-encat') : hourly ? '0 * * * *' : null;

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

try {
  const result = await pool.query<{
    id: string;
    code: string;
    connector_key: string;
    schedule_cron: string | null;
    schedule_timezone: string;
    is_active: boolean;
  }>(
    `
      INSERT INTO sources (
        code,
        name,
        jurisdiction_level,
        agency,
        base_url,
        connector_key,
        connector_config,
        schedule_cron,
        schedule_timezone,
        max_attempts,
        is_active
      )
      VALUES (
        'nfe-encat',
        'Portal Nacional NF-e/ENCAT',
        'FEDERAL',
        'ENCAT',
        'https://www.nfe.fazenda.gov.br/portal',
        'nfe-encat',
        '{}'::jsonb,
        $1,
        'America/Sao_Paulo',
        3,
        TRUE
      )
      ON CONFLICT (code)
      DO UPDATE SET
        name = EXCLUDED.name,
        jurisdiction_level = EXCLUDED.jurisdiction_level,
        agency = EXCLUDED.agency,
        base_url = EXCLUDED.base_url,
        connector_key = EXCLUDED.connector_key,
        schedule_cron = EXCLUDED.schedule_cron,
        schedule_timezone = EXCLUDED.schedule_timezone,
        max_attempts = EXCLUDED.max_attempts,
        is_active = TRUE,
        updated_at = now()
      RETURNING
        id,
        code,
        connector_key,
        schedule_cron,
        schedule_timezone,
        is_active
    `,
    [scheduleCron],
  );

  console.log(
    'NFE_ENCAT_SOURCE=' +
      JSON.stringify(result.rows[0]),
  );
} finally {
  await pool.end();
}
