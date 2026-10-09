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
  DB_PROOF_VERIFIER_RUNTIME_PASSWORD: z.string().min(32).optional(),
  DB_HTTP_COLLECTOR_RUNTIME_PASSWORD: z.string().min(32).optional(),
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
const DB_PROOF_VERIFIER_RUNTIME_PASSWORD = parsed.data.DB_PROOF_VERIFIER_RUNTIME_PASSWORD;
const DB_HTTP_COLLECTOR_RUNTIME_PASSWORD = parsed.data.DB_HTTP_COLLECTOR_RUNTIME_PASSWORD;
if (Boolean(DB_LEGAL_ISSUER_RUNTIME_PASSWORD) !== Boolean(DB_NCM_SEALER_RUNTIME_PASSWORD)) {
  throw new Error('TAX13_ISOLATED_RUNTIME_PASSWORD_PAIR_REQUIRED');
}
if (DB_PROOF_VERIFIER_RUNTIME_PASSWORD &&
    (!DB_LEGAL_ISSUER_RUNTIME_PASSWORD || !DB_NCM_SEALER_RUNTIME_PASSWORD)) {
  throw new Error('TAX13_R8_VERIFIER_REQUIRES_SEPARATE_ISSUER_AND_SEALER');
}
if (DB_HTTP_COLLECTOR_RUNTIME_PASSWORD) {
  const others = [DB_RUNTIME_PASSWORD,DB_WORKER_RUNTIME_PASSWORD,
    DB_CURATOR_RUNTIME_PASSWORD,DB_LEGAL_ISSUER_RUNTIME_PASSWORD,
    DB_NCM_SEALER_RUNTIME_PASSWORD,DB_PROOF_VERIFIER_RUNTIME_PASSWORD];
  if (others.includes(DB_HTTP_COLLECTOR_RUNTIME_PASSWORD)) {
    throw new Error('TAX13_R802_COLLECTOR_SECRET_NOT_ISOLATED');
  }
}
if (DB_LEGAL_ISSUER_RUNTIME_PASSWORD && DB_NCM_SEALER_RUNTIME_PASSWORD) {
  const values = [DB_RUNTIME_PASSWORD, DB_WORKER_RUNTIME_PASSWORD,
    DB_CURATOR_RUNTIME_PASSWORD, DB_LEGAL_ISSUER_RUNTIME_PASSWORD,
    DB_NCM_SEALER_RUNTIME_PASSWORD,DB_PROOF_VERIFIER_RUNTIME_PASSWORD].filter((item): item is string => Boolean(item));
  if (new Set([DB_LEGAL_ISSUER_RUNTIME_PASSWORD, DB_NCM_SEALER_RUNTIME_PASSWORD,
        DB_PROOF_VERIFIER_RUNTIME_PASSWORD].filter(Boolean)).size !==
        [DB_LEGAL_ISSUER_RUNTIME_PASSWORD, DB_NCM_SEALER_RUNTIME_PASSWORD,
          DB_PROOF_VERIFIER_RUNTIME_PASSWORD].filter(Boolean).length ||
      [DB_RUNTIME_PASSWORD,DB_WORKER_RUNTIME_PASSWORD,DB_CURATOR_RUNTIME_PASSWORD]
        .some(other=>Boolean(DB_PROOF_VERIFIER_RUNTIME_PASSWORD) &&
          other===DB_PROOF_VERIFIER_RUNTIME_PASSWORD) ||
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
    | 'radar_scan_sealer_runtime'
    | 'radar_proof_verifier_runtime'
    | 'radar_http_collector_runtime',
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

    if (DB_PROOF_VERIFIER_RUNTIME_PASSWORD) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_proof_verifier_runtime') THEN
            CREATE ROLE radar_proof_verifier_runtime LOGIN INHERIT NOSUPERUSER
              NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER ROLE radar_proof_verifier_runtime LOGIN INHERIT NOSUPERUSER
          NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      `);
      await setPassword(client,'radar_proof_verifier_runtime',DB_PROOF_VERIFIER_RUNTIME_PASSWORD);
      await client.query('GRANT radar_proof_verifier TO radar_proof_verifier_runtime');
      await client.query(
        'REVOKE radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer FROM radar_proof_verifier_runtime');
      for (const role of ['radar_legal_issuer_runtime','radar_scan_sealer_runtime',
        'radar_app_runtime','radar_worker_runtime','radar_taxonomy_curator_runtime']) {
        const exists=await client.query<{exists:boolean}>(
          'SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists',[role]);
        if (exists.rows[0]?.exists) {
          const command=(await client.query<{cmd:string}>(
            'SELECT format($1::text,$2::text,$3::text) AS cmd',
            ['REVOKE %I FROM %I','radar_proof_verifier',role])).rows[0]?.cmd;
          if (!command) throw new Error('TAX13_R8_REVOKE_FORMATION_FAILED');
          await client.query(command);
        }
      }
      await client.query("ALTER ROLE radar_proof_verifier_runtime SET timezone='UTC'");
    }
    if (DB_HTTP_COLLECTOR_RUNTIME_PASSWORD) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='radar_http_collector_runtime') THEN
            CREATE ROLE radar_http_collector_runtime LOGIN INHERIT NOSUPERUSER
              NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
          END IF;
        END $$;
      `);
      await client.query(`
        ALTER ROLE radar_http_collector_runtime LOGIN INHERIT NOSUPERUSER
          NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      `);
      await setPassword(client,'radar_http_collector_runtime',DB_HTTP_COLLECTOR_RUNTIME_PASSWORD);
      await client.query('GRANT radar_http_collector TO radar_http_collector_runtime');
      await client.query(
        'REVOKE radar_app,radar_worker,radar_taxonomy_curator,radar_legal_issuer,radar_scan_sealer,radar_proof_verifier FROM radar_http_collector_runtime');
      await client.query("ALTER ROLE radar_http_collector_runtime SET timezone='UTC'");
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
