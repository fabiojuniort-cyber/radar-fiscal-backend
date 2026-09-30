import 'dotenv/config';

import { Pool } from 'pg';

/*
 * Provisions the legacy DOE-SP archive source (Imprensa Oficial, 1988 –
 * 30/06/2023; Issue #20). It is created INACTIVE: activation is a separate,
 * authorized step (`--activate`). `--hourly` sets the schedule; the archive is
 * finite, so the source is deactivated again once the backfill is proven.
 * `--deactivate` turns it off explicitly (end of a pilot or of the backfill);
 * without it an upsert never turns an active source off.
 */
const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required to ensure the DOE-SP legacy source.');
  process.exit(1);
}

const activate = process.argv.includes('--activate');
const deactivate = process.argv.includes('--deactivate');
const hourly = process.argv.includes('--hourly');
if (activate && deactivate) {
  console.error('--activate and --deactivate are mutually exclusive.');
  process.exit(1);
}
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

const config = {
  archive: 'https://www.imprensaoficial.com.br/DO/',
  coverage: { from: '1988-01-01', to: '2023-06-30' },
  searchIndexFrom: '2003-01-01',
  cadernos: { search: ['Executivo I', 'Executivo II', 'Executivo III'], browse: ['Executivo I'] },
  scope: 'PAGES_WITH_TAX_TERMS',
  pdfStored: false,
  startEnv: 'DOE_SP_LEGACY_START_DATE',
  limitsEnv: ['DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS', 'DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN', 'DOE_SP_LEGACY_MAX_PERIODS_PER_RUN'],
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
        'doe-sp-legado',
        'Diário Oficial do Estado de São Paulo — acervo 1988–2023',
        'STATE',
        'SP',
        'Governo do Estado de São Paulo',
        'https://www.imprensaoficial.com.br/',
        'doe-sp-legacy',
        $2::jsonb,
        $1,
        'America/Sao_Paulo',
        3,
        $3
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
        schedule_cron = COALESCE(EXCLUDED.schedule_cron, sources.schedule_cron),
        schedule_timezone = EXCLUDED.schedule_timezone,
        max_attempts = EXCLUDED.max_attempts,
        is_active = CASE WHEN $4::boolean THEN false ELSE sources.is_active OR EXCLUDED.is_active END,
        updated_at = now()
      RETURNING id, code, connector_key, base_url, uf, schedule_cron, schedule_timezone, max_attempts, is_active, connector_config
    `,
    [hourly ? '0 * * * *' : null, JSON.stringify(config), activate, deactivate],
  );
  console.log('DOE_SP_LEGACY_SOURCE=' + JSON.stringify(result.rows[0]));
} finally {
  await pool.end();
}
