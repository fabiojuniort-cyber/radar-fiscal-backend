import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the DOE-SP source.');
  process.exit(1);
}

const hourly = process.argv.includes('--hourly');
const scheduleCron = hourly ? '0 * * * *' : null;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const config = {
  journal: 'Executivo',
  section: 'Atos Normativos',
  api: ['https://do-api-web-search.doe.sp.gov.br/', 'https://do-api-publication-pdf.doe.sp.gov.br/'],
  defaultLookbackDays: 3,
  lookbackEnv: 'DOE_SP_LOOKBACK_DAYS',
  bootstrapEnv: 'DOE_SP_BOOTSTRAP_START_DATE',
  platformStart: '2023-07-01',
  filtering: 'DETERMINISTIC',
};

try {
  const result = await pool.query(
    `
      INSERT INTO sources (
        code, name, jurisdiction_level, uf, agency, base_url,
        connector_key, connector_config, schedule_cron,
        schedule_timezone, max_attempts, is_active
      )
      VALUES (
        'doe-sp',
        'Diário Oficial do Estado de São Paulo',
        'STATE',
        'SP',
        'Governo do Estado de São Paulo',
        'https://doe.sp.gov.br/',
        'doe-sp',
        $2::jsonb,
        $1,
        'America/Sao_Paulo',
        3,
        TRUE
      )
      ON CONFLICT (code)
      DO UPDATE SET
        name = EXCLUDED.name,
        jurisdiction_level = EXCLUDED.jurisdiction_level,
        uf = EXCLUDED.uf,
        agency = EXCLUDED.agency,
        base_url = EXCLUDED.base_url,
        connector_key = EXCLUDED.connector_key,
        connector_config = EXCLUDED.connector_config,
        schedule_cron = EXCLUDED.schedule_cron,
        schedule_timezone = EXCLUDED.schedule_timezone,
        max_attempts = EXCLUDED.max_attempts,
        is_active = TRUE,
        updated_at = now()
      RETURNING id, code, connector_key, base_url, uf, schedule_cron, schedule_timezone, max_attempts, is_active, connector_config
    `,
    [scheduleCron, JSON.stringify(config)],
  );
  console.log('DOE_SP_SOURCE=' + JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
