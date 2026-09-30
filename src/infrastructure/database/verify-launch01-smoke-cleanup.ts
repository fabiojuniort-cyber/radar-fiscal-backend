import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL is required.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});

async function run(): Promise<void> {
  try {
    const result = await pool.query<{
      onboarding_count: string;
      company_count: string;
    }>(
      `
        SELECT
          (
            SELECT count(*)
            FROM tenant_onboarding_profiles
            WHERE company_name = 'LAUNCH01 Smoke Test'
          )::text AS onboarding_count,
          (
            SELECT count(*)
            FROM companies
            WHERE legal_name = 'LAUNCH01 Smoke Company Ltda'
          )::text AS company_count
      `,
    );

    const row = result.rows[0];

    if (
      !row ||
      row.onboarding_count !== '0' ||
      row.company_count !== '0'
    ) {
      throw new Error(
        'launch01_smoke_cleanup_not_complete',
      );
    }

    console.log('LAUNCH01_SMOKE_CLEANUP=PASS');
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'LAUNCH-01 cleanup verification failed.',
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'UnknownError' },
  );
  process.exit(1);
});
