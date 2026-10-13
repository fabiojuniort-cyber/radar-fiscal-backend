import 'dotenv/config';

import { Pool } from 'pg';

import { d056ScheduleFor } from '../../modules/collection/schedule-policy.js';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the RFB Normas source.');
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
const scheduleCron = scheduled ? d056ScheduleFor('rfb-normas') : hourly ? '0 * * * *' : null;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query(
    `
      INSERT INTO sources (
        code, name, jurisdiction_level, agency, base_url,
        connector_key, connector_config, schedule_cron,
        schedule_timezone, max_attempts, is_active
      )
      VALUES (
        'rfb-normas',
        'Receita Federal — Sistema Normas',
        'FEDERAL',
        'RFB',
        'https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action',
        'rfb-normas',
        '{"bootstrapStart":"2025-01-01","defaultLookbackDays":7,"lookbackEnv":"RFB_LOOKBACK_DAYS","filtering":"DETERMINISTIC","representations":["original","vigente","multivigente","relacional"]}'::jsonb,
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
        connector_config = EXCLUDED.connector_config,
        schedule_cron = EXCLUDED.schedule_cron,
        schedule_timezone = EXCLUDED.schedule_timezone,
        max_attempts = EXCLUDED.max_attempts,
        is_active = TRUE,
        updated_at = now()
      RETURNING id, code, connector_key, base_url, schedule_cron, schedule_timezone, max_attempts, is_active, connector_config
    `,
    [scheduleCron],
  );
  console.log('RFB_NORMAS_SOURCE=' + JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
