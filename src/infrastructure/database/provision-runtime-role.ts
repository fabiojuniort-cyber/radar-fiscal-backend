import { Pool } from 'pg';
import { z } from 'zod';

const provisionEnvSchema = z.object({
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') ||
        value.startsWith('postgresql://'),
      'DATABASE_ADMIN_URL must be a PostgreSQL URL',
    ),
  DB_RUNTIME_PASSWORD: z.string().min(32),
});

const parsed = provisionEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid database role provisioning configuration.',
    parsed.error.issues,
  );
  process.exit(1);
}

const { DATABASE_ADMIN_URL, DB_RUNTIME_PASSWORD } = parsed.data;

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_ADMIN_URL,
    max: 1,
  });

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = 'radar_app_runtime'
          ) THEN
            CREATE ROLE radar_app_runtime
              LOGIN
              INHERIT
              NOSUPERUSER
              NOCREATEDB
              NOCREATEROLE
              NOREPLICATION
              NOBYPASSRLS;
          END IF;
        END;
        $$;
      `);

      await client.query(`
        ALTER ROLE radar_app_runtime
          LOGIN
          INHERIT
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOREPLICATION
          NOBYPASSRLS
      `);

      const formatted = await client.query<{ command: string }>(
        `
          SELECT format(
            'ALTER ROLE radar_app_runtime PASSWORD %L',
            $1::text
          ) AS command
        `,
        [DB_RUNTIME_PASSWORD],
      );

      const passwordCommand = formatted.rows[0]?.command;

      if (!passwordCommand) {
        throw new Error(
          'Failed to build runtime role password command.',
        );
      }

      await client.query(passwordCommand);

      await client.query(`
        GRANT radar_app TO radar_app_runtime
      `);

      await client.query(`
        ALTER ROLE radar_app_runtime
          SET timezone = 'UTC'
      `);

      await client.query('COMMIT');

      console.log('Database runtime role provisioned.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error('Database runtime role provisioning failed.', error);
  process.exit(1);
});
