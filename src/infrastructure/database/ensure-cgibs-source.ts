import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the CGIBS source.');
  process.exit(1);
}

const hourly = process.argv.includes('--hourly');
const scheduleCron = hourly ? '0 * * * *' : null;
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
        'cgibs',
        'CGIBS — Comitê Gestor do IBS',
        'FEDERAL',
        'CGIBS',
        'https://www.cgibs.gov.br/',
        'cgibs',
        '{"scope":["RESOLUTIONS","REGULATIONS","PORTARIAS","JOINT_ACTS","JOINT_TECHNICAL_ACTS","OFFICIAL_COMMUNIQUES","TECHNICAL_DOCUMENTS","GUIDES","BOOKLETS","OPERATIONAL_NEWS"]}'::jsonb,
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
      RETURNING id, code, connector_key, base_url, schedule_cron, schedule_timezone, max_attempts, is_active
    `,
    [scheduleCron],
  );
  console.log('CGIBS_SOURCE=' + JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
