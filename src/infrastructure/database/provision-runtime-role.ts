import { Pool, type PoolClient } from 'pg';
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
  DB_WORKER_RUNTIME_PASSWORD: z.string().min(32).optional(),
  DB_CURATOR_RUNTIME_PASSWORD: z.string().min(32).optional(),
  DB_DOU_LIMITS_PASSWORD: z.string().min(32).optional(),
  DOU_LIMITS_SIGNING_SECRET: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const parsed = provisionEnvSchema.safeParse(
  process.env,
);

if (!parsed.success) {
  console.error(
    'Invalid database role provisioning configuration.',
    parsed.error.issues,
  );
  process.exit(1);
}

const {
  DATABASE_ADMIN_URL,
  DB_RUNTIME_PASSWORD,
} = parsed.data;

const DB_WORKER_RUNTIME_PASSWORD =
  parsed.data.DB_WORKER_RUNTIME_PASSWORD ??
  DB_RUNTIME_PASSWORD;

// TAX-11: optional dedicated login for taxonomy curation. Never shares the
// app/worker passwords; skipped entirely when the secret is not configured.
const DB_CURATOR_RUNTIME_PASSWORD =
  parsed.data.DB_CURATOR_RUNTIME_PASSWORD;
const DB_DOU_LIMITS_PASSWORD = parsed.data.DB_DOU_LIMITS_PASSWORD;
const DOU_LIMITS_SIGNING_SECRET = parsed.data.DOU_LIMITS_SIGNING_SECRET;

if (
  DB_CURATOR_RUNTIME_PASSWORD &&
  (DB_CURATOR_RUNTIME_PASSWORD === DB_RUNTIME_PASSWORD ||
    DB_CURATOR_RUNTIME_PASSWORD === DB_WORKER_RUNTIME_PASSWORD)
) {
  console.error(
    'DB_CURATOR_RUNTIME_PASSWORD must differ from the app and worker runtime passwords.',
  );
  process.exit(1);
}

async function setPassword(
  client: PoolClient,
  roleName:
    | 'radar_app_runtime'
    | 'radar_worker_runtime'
    | 'radar_taxonomy_curator_runtime'
    | 'radar_dou_limits_runtime',
  password: string,
): Promise<void> {
  const formatted = await client.query<{
    command: string;
  }>(
    `
      SELECT format(
        'ALTER ROLE %I PASSWORD %L',
        $1::text,
        $2::text
      ) AS command
    `,
    [roleName, password],
  );

  const command = formatted.rows[0]?.command;

  if (!command) {
    throw new Error(
      'Failed to build runtime role password command.',
    );
  }

  await client.query(command);
}

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_ADMIN_URL,
    max: 1,
  });

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

        IF NOT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = 'radar_worker_runtime'
        ) THEN
          CREATE ROLE radar_worker_runtime
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

    await client.query(`
      ALTER ROLE radar_worker_runtime
        LOGIN
        INHERIT
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOREPLICATION
        NOBYPASSRLS
    `);

    await setPassword(
      client,
      'radar_app_runtime',
      DB_RUNTIME_PASSWORD,
    );

    await setPassword(
      client,
      'radar_worker_runtime',
      DB_WORKER_RUNTIME_PASSWORD,
    );

    await client.query(
      'GRANT radar_app TO radar_app_runtime',
    );

    await client.query(
      'GRANT radar_worker TO radar_worker_runtime',
    );

    await client.query(
      'REVOKE radar_worker FROM radar_app_runtime',
    );

    await client.query(
      'REVOKE radar_app FROM radar_worker_runtime',
    );

    await client.query(
      "ALTER ROLE radar_app_runtime SET timezone = 'UTC'",
    );

    await client.query(
      "ALTER ROLE radar_worker_runtime SET timezone = 'UTC'",
    );

    if (DB_CURATOR_RUNTIME_PASSWORD) {
      // NOINHERIT: the login holds no privilege until a transaction runs
      // SET LOCAL ROLE radar_taxonomy_curator.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = 'radar_taxonomy_curator_runtime'
          ) THEN
            CREATE ROLE radar_taxonomy_curator_runtime
              LOGIN
              NOINHERIT
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
        ALTER ROLE radar_taxonomy_curator_runtime
          LOGIN
          NOINHERIT
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOREPLICATION
          NOBYPASSRLS
      `);

      await setPassword(
        client,
        'radar_taxonomy_curator_runtime',
        DB_CURATOR_RUNTIME_PASSWORD,
      );

      await client.query(
        'GRANT radar_taxonomy_curator TO radar_taxonomy_curator_runtime',
      );
      await client.query(
        'REVOKE radar_app FROM radar_taxonomy_curator_runtime',
      );
      await client.query(
        'REVOKE radar_worker FROM radar_taxonomy_curator_runtime',
      );
      await client.query(
        "ALTER ROLE radar_taxonomy_curator_runtime SET timezone = 'UTC'",
      );
    }

    if (DB_DOU_LIMITS_PASSWORD || DOU_LIMITS_SIGNING_SECRET) {
      const password=DB_DOU_LIMITS_PASSWORD;
      const key=DOU_LIMITS_SIGNING_SECRET;
      if (!password || !key) throw new Error('Both DOU gateway secrets are required');
      if ([DB_RUNTIME_PASSWORD,DB_WORKER_RUNTIME_PASSWORD,DB_CURATOR_RUNTIME_PASSWORD].includes(password))
        throw new Error('DOU gateway password must differ from other runtimes');
      await client.query(`ALTER ROLE radar_dou_limits_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await setPassword(client, 'radar_dou_limits_runtime', password);
      await client.query(`REVOKE radar_app,radar_worker FROM radar_dou_limits_runtime`);
      await client.query(`INSERT INTO public.ops_dou_limits_signing_keys(key_id,key_bytes) VALUES('v1',decode($1,'hex')) ON CONFLICT(key_id) DO NOTHING`,[key]);
      const check=await client.query<{ ok: boolean }>(`SELECT key_bytes=decode($1,'hex') AS ok FROM public.ops_dou_limits_signing_keys WHERE key_id='v1'`,[key]);
      if (!check.rows[0]?.ok) throw new Error('DOU signing key does not match provisioned value');
      await client.query(`ALTER ROLE radar_dou_limits_runtime SET timezone = 'UTC'`);
    }
    await client.query('COMMIT');

    console.log(
      'Database app and worker runtime roles provisioned.',
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'Database runtime role provisioning failed.',
    error,
  );
  process.exit(1);
});
