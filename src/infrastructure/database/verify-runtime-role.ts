import { Pool } from 'pg';
import { z } from 'zod';

const runtimeEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith('postgres://') ||
        value.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL URL',
    ),
});

const parsed = runtimeEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid runtime database verification configuration.',
    parsed.error.issues,
  );
  process.exit(1);
}

const PROTECTED_TABLES = [
  'tenants',
  'tenant_memberships',
  'companies',
  'company_tax_profiles',
  'establishments',
  'company_cnaes',
  'establishment_cnaes',
  'monitoring_profiles',
  'company_publications',
  'publication_matches',
  'audit_log',
] as const;

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString: parsed.data.DATABASE_URL,
    max: 1,
  });

  try {
    const identity = await pool.query<{
      current_user: string;
      is_superuser: boolean;
      bypass_rls: boolean;
    }>(`
      SELECT
        current_user,
        r.rolsuper AS is_superuser,
        r.rolbypassrls AS bypass_rls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);

    const role = identity.rows[0];

    if (!role) {
      throw new Error('Runtime database role could not be inspected.');
    }

    if (role.current_user !== 'radar_app_runtime') {
      throw new Error(
        `Unexpected runtime database role: ${role.current_user}`,
      );
    }

    if (role.is_superuser || role.bypass_rls) {
      throw new Error(
        'Runtime database role has forbidden elevated privileges.',
      );
    }

    const rls = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner_name: string;
    }>(
      `
        SELECT
          c.relname,
          c.relrowsecurity,
          c.relforcerowsecurity,
          owner_role.rolname AS owner_name
        FROM pg_class c
        JOIN pg_namespace n
          ON n.oid = c.relnamespace
        JOIN pg_roles owner_role
          ON owner_role.oid = c.relowner
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])
        ORDER BY c.relname
      `,
      [PROTECTED_TABLES],
    );

    if (rls.rows.length !== PROTECTED_TABLES.length) {
      throw new Error(
        'One or more protected tables were not found.',
      );
    }

    for (const table of rls.rows) {
      if (!table.relrowsecurity || !table.relforcerowsecurity) {
        throw new Error(
          `RLS is not fully enforced on ${table.relname}.`,
        );
      }

      if (table.owner_name === role.current_user) {
        throw new Error(
          `Runtime role owns protected table ${table.relname}.`,
        );
      }
    }

    const privileges = await pool.query<{
      can_read_companies: boolean;
      can_delete_companies: boolean;
      can_read_migrations: boolean;
      can_update_audit: boolean;
    }>(`
      SELECT
        has_table_privilege(
          current_user,
          'public.companies',
          'SELECT'
        ) AS can_read_companies,
        has_table_privilege(
          current_user,
          'public.companies',
          'DELETE'
        ) AS can_delete_companies,
        has_table_privilege(
          current_user,
          'public.schema_migrations',
          'SELECT'
        ) AS can_read_migrations,
        has_table_privilege(
          current_user,
          'public.audit_log',
          'UPDATE'
        ) AS can_update_audit
    `);

    const privilege = privileges.rows[0];

    if (
      !privilege ||
      !privilege.can_read_companies ||
      privilege.can_delete_companies ||
      privilege.can_read_migrations ||
      privilege.can_update_audit
    ) {
      throw new Error(
        'Runtime database privileges do not match the expected policy.',
      );
    }

    console.log('Database runtime security verified.');
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error('Database runtime security verification failed.', error);
  process.exit(1);
});
