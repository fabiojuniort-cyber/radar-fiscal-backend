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
    'Invalid taxonomy curator verification configuration.',
    parsed.error.issues,
  );
  process.exit(1);
}

const { DATABASE_ADMIN_URL } = parsed.data;

const UPDATE_NO_DELETE_TABLES = [
  'taxonomy_releases',
  'taxonomy_dimensions',
  'taxonomy_concepts',
] as const;

const DRAFT_MUTABLE_TABLES = [
  'taxonomy_release_dimensions',
  'taxonomy_release_concepts',
  'taxonomy_release_alias_bindings',
  'taxonomy_release_relation_rules',
  'taxonomy_concept_relations',
  'taxonomy_official_mappings',
] as const;

const APPEND_ONLY_TABLES = [
  'taxonomy_dimension_revisions',
  'taxonomy_concept_revisions',
  'taxonomy_aliases',
  'taxonomy_relation_types',
  'taxonomy_evidence',
  'taxonomy_concept_revision_evidence',
  'taxonomy_alias_binding_evidence',
  'taxonomy_relation_evidence',
  'official_catalogs',
  'official_catalog_editions',
  'official_catalog_entries',
  'taxonomy_official_mapping_evidence',
] as const;

interface PrivilegeRow {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

async function readPrivileges(
  pool: Pool,
  tables: readonly string[],
): Promise<PrivilegeRow[]> {
  const result = await pool.query<PrivilegeRow>(
    `
      SELECT
        table_name,
        has_table_privilege(
          'radar_taxonomy_curator',
          format('public.%I', table_name),
          'SELECT'
        ) AS can_select,
        has_table_privilege(
          'radar_taxonomy_curator',
          format('public.%I', table_name),
          'INSERT'
        ) AS can_insert,
        has_table_privilege(
          'radar_taxonomy_curator',
          format('public.%I', table_name),
          'UPDATE'
        ) AS can_update,
        has_table_privilege(
          'radar_taxonomy_curator',
          format('public.%I', table_name),
          'DELETE'
        ) AS can_delete
      FROM unnest($1::text[]) AS t(table_name)
    `,
    [tables],
  );

  return result.rows;
}

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_ADMIN_URL,
    max: 1,
  });

  try {
    const roleResult = await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
      app_is_member: boolean;
      worker_is_member: boolean;
    }>(`
      SELECT
        r.rolcanlogin,
        r.rolsuper,
        r.rolcreatedb,
        r.rolcreaterole,
        r.rolreplication,
        r.rolbypassrls,
        pg_has_role(
          'radar_app_runtime',
          'radar_taxonomy_curator',
          'MEMBER'
        ) AS app_is_member,
        pg_has_role(
          'radar_worker_runtime',
          'radar_taxonomy_curator',
          'MEMBER'
        ) AS worker_is_member
      FROM pg_roles r
      WHERE r.rolname = 'radar_taxonomy_curator'
    `);

    const role = roleResult.rows[0];

    if (
      !role ||
      role.rolcanlogin ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls ||
      role.app_is_member ||
      role.worker_is_member
    ) {
      throw new Error(
        'Taxonomy curator role does not match least-privilege policy.',
      );
    }

    const updateNoDelete = await readPrivileges(
      pool,
      UPDATE_NO_DELETE_TABLES,
    );

    if (
      updateNoDelete.length !== UPDATE_NO_DELETE_TABLES.length ||
      updateNoDelete.some(
        (row) =>
          !row.can_select ||
          !row.can_insert ||
          !row.can_update ||
          row.can_delete,
      )
    ) {
      throw new Error(
        'Curator identity/release privileges are invalid.',
      );
    }

    const draftMutable = await readPrivileges(
      pool,
      DRAFT_MUTABLE_TABLES,
    );

    if (
      draftMutable.length !== DRAFT_MUTABLE_TABLES.length ||
      draftMutable.some(
        (row) =>
          !row.can_select ||
          !row.can_insert ||
          !row.can_update ||
          !row.can_delete,
      )
    ) {
      throw new Error(
        'Curator draft membership privileges are invalid.',
      );
    }

    const appendOnly = await readPrivileges(
      pool,
      APPEND_ONLY_TABLES,
    );

    if (
      appendOnly.length !== APPEND_ONLY_TABLES.length ||
      appendOnly.some(
        (row) =>
          !row.can_select ||
          !row.can_insert ||
          row.can_update ||
          row.can_delete,
      )
    ) {
      throw new Error(
        'Curator append-only privileges are invalid.',
      );
    }

    const audit = await pool.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      select_policy: boolean;
      insert_policy: boolean;
    }>(`
      SELECT
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.audit_log',
          'SELECT'
        ) AS can_select,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.audit_log',
          'INSERT'
        ) AS can_insert,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.audit_log',
          'UPDATE'
        ) AS can_update,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.audit_log',
          'DELETE'
        ) AS can_delete,
        EXISTS (
          SELECT 1
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'audit_log'
            AND policyname =
              'audit_log_taxonomy_curator_select'
        ) AS select_policy,
        EXISTS (
          SELECT 1
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'audit_log'
            AND policyname =
              'audit_log_taxonomy_curator_insert'
        ) AS insert_policy
    `);

    const policy = audit.rows[0];

    if (
      !policy ||
      !policy.can_select ||
      !policy.can_insert ||
      policy.can_update ||
      policy.can_delete ||
      !policy.select_policy ||
      !policy.insert_policy
    ) {
      throw new Error(
        'Taxonomy curator audit privileges/policies are invalid.',
      );
    }

    console.log(
      'Database taxonomy curator security verified.',
    );
  } finally {
    await pool.end();
  }
}

run().catch((error: unknown) => {
  console.error(
    'Database taxonomy curator security verification failed.',
    error,
  );
  process.exit(1);
});
