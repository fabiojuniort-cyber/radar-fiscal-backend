import { Pool } from 'pg';
import { z } from 'zod';

const schema = z.object({
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') ||
        value.startsWith('postgresql://'),
      'DATABASE_ADMIN_URL must be a PostgreSQL URL',
    ),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid worker role verification configuration.',
    parsed.error.issues,
  );
  process.exit(1);
}

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString:
      parsed.data.DATABASE_ADMIN_URL,
    max: 1,
  });

  try {
    const roleResult = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      is_worker_member: boolean;
      is_app_member: boolean;
    }>(`
      SELECT
        r.rolcanlogin,
        r.rolsuper,
        r.rolbypassrls,
        pg_has_role(
          'radar_worker_runtime',
          'radar_worker',
          'MEMBER'
        ) AS is_worker_member,
        pg_has_role(
          'radar_worker_runtime',
          'radar_app',
          'MEMBER'
        ) AS is_app_member
      FROM pg_roles r
      WHERE r.rolname = 'radar_worker_runtime'
    `);

    const role = roleResult.rows[0];

    if (
      !role ||
      !role.rolcanlogin ||
      role.rolsuper ||
      role.rolbypassrls ||
      !role.is_worker_member ||
      role.is_app_member
    ) {
      throw new Error(
        'Worker runtime role does not match the expected security policy.',
      );
    }

    const privileges = await pool.query<{
      can_read_sources: boolean;
      can_insert_runs: boolean;
      can_update_runs: boolean;
      can_insert_attempts: boolean;
      can_insert_publications: boolean;
      can_update_publications: boolean;
      can_read_credentials: boolean;
      can_read_sessions: boolean;
      can_read_migrations: boolean;
    }>(`
      SELECT
        has_table_privilege(
          'radar_worker_runtime',
          'public.sources',
          'SELECT'
        ) AS can_read_sources,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_runs',
          'INSERT'
        ) AS can_insert_runs,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_runs',
          'UPDATE'
        ) AS can_update_runs,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_attempts',
          'INSERT'
        ) AS can_insert_attempts,
        has_table_privilege(
          'radar_worker_runtime',
          'public.publications',
          'INSERT'
        ) AS can_insert_publications,
        has_table_privilege(
          'radar_worker_runtime',
          'public.publications',
          'UPDATE'
        ) AS can_update_publications,
        has_table_privilege(
          'radar_worker_runtime',
          'public.user_credentials',
          'SELECT'
        ) AS can_read_credentials,
        has_table_privilege(
          'radar_worker_runtime',
          'public.auth_sessions',
          'SELECT'
        ) AS can_read_sessions,
        has_table_privilege(
          'radar_worker_runtime',
          'public.schema_migrations',
          'SELECT'
        ) AS can_read_migrations
    `);

    const privilege = privileges.rows[0];

    if (
      !privilege ||
      !privilege.can_read_sources ||
      !privilege.can_insert_runs ||
      !privilege.can_update_runs ||
      !privilege.can_insert_attempts ||
      !privilege.can_insert_publications ||
      !privilege.can_update_publications ||
      privilege.can_read_credentials ||
      privilege.can_read_sessions ||
      privilege.can_read_migrations
    ) {
      throw new Error(
        'Worker runtime privileges do not match the expected policy.',
      );
    }

    console.log(
      'Database worker runtime security verified.',
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'Database worker runtime security verification failed.',
    error,
  );
  process.exit(1);
});
