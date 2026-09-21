import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    'DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the DOU source.',
  );
  process.exit(1);
}

if (process.env.DOU_CONNECTOR_ENABLED !== 'true') {
  console.error(
    'DOU_CONNECTOR_ENABLED=true is required before activating the DOU source.',
  );
  process.exit(1);
}

if (!process.env.INLABS_EMAIL || !process.env.INLABS_PASSWORD) {
  console.error(
    'INLABS_EMAIL and INLABS_PASSWORD are required before activating the DOU source.',
  );
  process.exit(1);
}

const scheduleCron =
  process.env.DOU_SCHEDULE_CRON?.trim() || '10 * * * *';

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

try {
  await pool.query(
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
        'dou',
        'DOU — Diário Oficial da União (INLABS)',
        'FEDERAL',
        'Imprensa Nacional',
        'https://inlabs.in.gov.br',
        'dou',
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
    `,
    [scheduleCron],
  );

  console.log(
    `DOU source ensured with schedule ${scheduleCron}.`,
  );
} finally {
  await pool.end();
}
