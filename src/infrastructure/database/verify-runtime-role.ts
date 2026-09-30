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
  throw new Error(
    'Runtime database verification configuration is invalid.',
  );
}

const runtimeDatabaseUrl = parsed.data.DATABASE_URL;


const TAXONOMY_TABLES = [
  'taxonomy_releases',
  'taxonomy_dimensions',
  'taxonomy_dimension_revisions',
  'taxonomy_release_dimensions',
  'taxonomy_concepts',
  'taxonomy_concept_revisions',
  'taxonomy_release_concepts',
  'taxonomy_aliases',
  'taxonomy_release_alias_bindings',
  'taxonomy_relation_types',
  'taxonomy_release_relation_rules',
  'taxonomy_concept_relations',
  'taxonomy_evidence',
  'taxonomy_concept_revision_evidence',
  'taxonomy_alias_binding_evidence',
  'taxonomy_relation_evidence',
  'official_catalogs',
  'official_catalog_editions',
  'official_catalog_entries',
  'taxonomy_official_mappings',
  'taxonomy_official_mapping_evidence',
  'publication_taxonomy_runs',
  'publication_taxonomy_assertions',
  'publication_taxonomy_spans',
  'publication_taxonomy_reviews',
  'v_publication_taxonomy_effective_assertions',
] as const;

const PROTECTED_TABLES = [
  'tenants',
  'tenant_memberships',
  'tenant_onboarding_profiles',
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
    connectionString: runtimeDatabaseUrl,
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
      can_read_checkpoints: boolean;
      can_read_capacity: boolean;
      can_read_signup_profile: boolean;
      can_insert_signup_profile: boolean;
      can_read_signup_rate_limits: boolean;
      can_execute_signup_create: boolean;
      can_execute_signup_rate_limit: boolean;
      is_monitor_member: boolean;
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
        ) AS can_update_audit,
        has_table_privilege(
          current_user,
          'public.collection_checkpoints',
          'SELECT'
        ) AS can_read_checkpoints,
        has_table_privilege(
          current_user,
          'public.db_capacity_snapshots',
          'SELECT'
        ) AS can_read_capacity,
        has_table_privilege(
          current_user,
          'public.tenant_onboarding_profiles',
          'SELECT'
        ) AS can_read_signup_profile,
        has_table_privilege(
          current_user,
          'public.tenant_onboarding_profiles',
          'INSERT'
        ) AS can_insert_signup_profile,
        has_table_privilege(
          current_user,
          'public.public_signup_rate_limits',
          'SELECT'
        ) AS can_read_signup_rate_limits,
        has_function_privilege(
          current_user,
          'public.auth_public_signup_create_account(text,text,text,text,text,boolean,text,text)',
          'EXECUTE'
        ) AS can_execute_signup_create,
        has_function_privilege(
          current_user,
          'public.auth_public_signup_rate_limit(text,integer,integer)',
          'EXECUTE'
        ) AS can_execute_signup_rate_limit,
        pg_has_role(
          current_user,
          'pg_monitor',
          'MEMBER'
        ) AS is_monitor_member
    `);

    const privilege = privileges.rows[0];

    if (
      !privilege ||
      !privilege.can_read_companies ||
      privilege.can_delete_companies ||
      privilege.can_read_migrations ||
      privilege.can_update_audit ||
      privilege.can_read_checkpoints ||
      privilege.can_read_capacity ||
      !privilege.can_read_signup_profile ||
      privilege.can_insert_signup_profile ||
      privilege.can_read_signup_rate_limits ||
      !privilege.can_execute_signup_create ||
      !privilege.can_execute_signup_rate_limit ||
      privilege.is_monitor_member
    ) {
      throw new Error(
        'Runtime database privileges do not match the expected policy.',
      );
    }

    const taxonomyPrivileges = await pool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `
        SELECT
          table_name,
          has_table_privilege(
            current_user,
            format('public.%I', table_name),
            'SELECT'
          ) AS can_select,
          has_table_privilege(
            current_user,
            format('public.%I', table_name),
            'INSERT'
          ) AS can_insert,
          has_table_privilege(
            current_user,
            format('public.%I', table_name),
            'UPDATE'
          ) AS can_update,
          has_table_privilege(
            current_user,
            format('public.%I', table_name),
            'DELETE'
          ) AS can_delete
        FROM unnest($1::text[]) AS t(table_name)
      `,
      [TAXONOMY_TABLES],
    );

    if (
      taxonomyPrivileges.rows.length !== TAXONOMY_TABLES.length ||
      taxonomyPrivileges.rows.some(
        (row) =>
          !row.can_select ||
          row.can_insert ||
          row.can_update ||
          row.can_delete,
      )
    ) {
      throw new Error(
        'App runtime taxonomy privileges do not match read-only policy.',
      );
    }

    const candidatePrivileges = await pool.query<{
      table_name: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(\`
      SELECT
        table_name,
        has_table_privilege(
          current_user,
          format('public.%I', table_name),
          'SELECT'
        ) AS can_select,
        has_table_privilege(
          current_user,
          format('public.%I', table_name),
          'INSERT'
        ) AS can_insert,
        has_table_privilege(
          current_user,
          format('public.%I', table_name),
          'UPDATE'
        ) AS can_update,
        has_table_privilege(
          current_user,
          format('public.%I', table_name),
          'DELETE'
        ) AS can_delete
      FROM unnest(
        ARRAY[
          'taxonomy_unmapped_occurrences',
          'taxonomy_candidates',
          'taxonomy_candidate_occurrence_links'
        ]::text[]
      ) AS t(table_name)
    \`);

    if (
      candidatePrivileges.rows.length !== 3 ||
      candidatePrivileges.rows.some(
        (row) =>
          !row.can_select ||
          row.can_insert ||
          row.can_update ||
          row.can_delete,
      )
    ) {
      throw new Error(
        'App runtime taxonomy candidate privileges do not match read-only policy.',
      );
    }

    const curatorMembership = await pool.query<{
      is_curator_member: boolean;
    }>(`
      SELECT pg_has_role(
        current_user,
        'radar_taxonomy_curator',
        'MEMBER'
      ) AS is_curator_member
    `);

    if (curatorMembership.rows[0]?.is_curator_member) {
      throw new Error(
        'App runtime must not inherit taxonomy curator privileges.',
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
