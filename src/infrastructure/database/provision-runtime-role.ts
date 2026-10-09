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
  DB_LEGAL_ISSUER_RUNTIME_PASSWORD: z.string().min(32).optional(),
  DB_NCM_SEALER_RUNTIME_PASSWORD: z.string().min(32).optional(),
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


const DB_LEGAL_ISSUER_RUNTIME_PASSWORD = parsed.data.DB_LEGAL_ISSUER_RUNTIME_PASSWORD;
const DB_NCM_SEALER_RUNTIME_PASSWORD = parsed.data.DB_NCM_SEALER_RUNTIME_PASSWORD;
if (Boolean(DB_LEGAL_ISSUER_RUNTIME_PASSWORD) !== Boolean(DB_NCM_SEALER_RUNTIME_PASSWORD)) {
  throw new Error('TAX13_ISOLATED_RUNTIME_PASSWORD_PAIR_REQUIRED');
}
if (DB_LEGAL_ISSUER_RUNTIME_PASSWORD && DB_NCM_SEALER_RUNTIME_PASSWORD) {
  const values = [DB_RUNTIME_PASSWORD, DB_WORKER_RUNTIME_PASSWORD,
    DB_CURATOR_RUNTIME_PASSWORD, DB_LEGAL_ISSUER_RUNTIME_PASSWORD,
    DB_NCM_SEALER_RUNTIME_PASSWORD].filter((item): item is string => Boolean(item));
  if (new Set([DB_LEGAL_ISSUER_RUNTIME_PASSWORD, DB_NCM_SEALER_RUNTIME_PASSWORD]).size !== 2 ||
      [DB_RUNTIME_PASSWORD, DB_WORKER_RUNTIME_PASSWORD, DB_CURATOR_RUNTIME_PASSWORD]
        .some((other) => other === DB_LEGAL_ISSUER_RUNTIME_PASSWORD ||
          other === DB_NCM_SEALER_RUNTIME_PASSWORD)) {
    throw new Error('TAX13_ISOLATED_RUNTIME_PASSWORDS_MUST_BE_DISTINCT');
  }
  void values; // Never log or expose any secrets.
}

async function setPassword(
  client: PoolClient,
  roleName:
    | 'radar_app_runtime'
    | 'radar_worker_runtime'
    | 'radar_taxonomy_curator_runtime'
    | 'radar_legal_issuer_runtime'
    | 'radar_scan_sealer_runtime',
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


    if (DB_LEGAL_ISSUER_RUNTIME_PASSWORD && DB_NCM_SEALER_RUNTIME_PASSWORD) {
      // Production does not provision optional TAX13 accounts until both
      // independent secrets are explicitly configured. The emitter and
      // sealer never receive app/worker/curator memberships.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_legal_issuer_runtime') THEN
            CREATE ROLE radar_legal_issuer_runtime LOGIN INHERIT NOSUPERUSER
              NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_scan_sealer_runtime') THEN
            CREATE ROLE radar_scan_sealer_runtime LOGIN INHERIT NOSUPERUSER
              NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER ROLE radar_legal_issuer_runtime LOGIN INHERIT NOSUPERUSER
          NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      `);
      await client.query(`
        ALTER ROLE radar_scan_sealer_runtime LOGIN INHERIT NOSUPERUSER
          NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      `);
      await setPassword(client,'radar_legal_issuer_runtime',DB_LEGAL_ISSUER_RUNTIME_PASSWORD);
      await setPassword(client,'radar_scan_sealer_runtime',DB_NCM_SEALER_RUNTIME_PASSWORD);
      await client.query('GRANT radar_legal_issuer TO radar_legal_issuer_runtime');
      await client.query('GRANT radar_scan_sealer TO radar_scan_sealer_runtime');
      for (const sqlCommand of [
        'REVOKE radar_app,radar_worker,radar_taxonomy_curator,radar_scan_sealer FROM radar_legal_issuer_runtime',
        'REVOKE radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer FROM radar_scan_sealer_runtime',
        "ALTER ROLE radar_legal_issuer_runtime SET timezone = 'UTC'",
        "ALTER ROLE radar_scan_sealer_runtime SET timezone = 'UTC'",
      ]) await client.query(sqlCommand);
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
