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

const { DATABASE_ADMIN_URL } = parsed.data;


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
] as const;

async function run(): Promise<void> {
  const pool = new Pool({
    connectionString: DATABASE_ADMIN_URL,
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
      can_read_checkpoints: boolean;
      can_insert_checkpoints: boolean;
      can_delete_checkpoints: boolean;
      can_update_checkpoints: boolean;
      can_insert_capacity: boolean;
      can_update_capacity: boolean;
      can_delete_capacity: boolean;
      is_monitor_member: boolean;
      is_read_all_stats_member: boolean;
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
        ) AS can_read_migrations,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_checkpoints',
          'SELECT'
        ) AS can_read_checkpoints,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_checkpoints',
          'INSERT'
        ) AS can_insert_checkpoints,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_checkpoints',
          'DELETE'
        ) AS can_delete_checkpoints,
        has_table_privilege(
          'radar_worker_runtime',
          'public.collection_checkpoints',
          'UPDATE'
        ) AS can_update_checkpoints,
        has_table_privilege(
          'radar_worker_runtime',
          'public.db_capacity_snapshots',
          'INSERT'
        ) AS can_insert_capacity,
        has_table_privilege(
          'radar_worker_runtime',
          'public.db_capacity_snapshots',
          'UPDATE'
        ) AS can_update_capacity,
        has_table_privilege(
          'radar_worker_runtime',
          'public.db_capacity_snapshots',
          'DELETE'
        ) AS can_delete_capacity,
        pg_has_role(
          'radar_worker_runtime',
          'pg_monitor',
          'MEMBER'
        ) AS is_monitor_member,
        pg_has_role(
          'radar_worker_runtime',
          'pg_read_all_stats',
          'MEMBER'
        ) AS is_read_all_stats_member
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
      privilege.can_read_migrations ||
      !privilege.can_read_checkpoints ||
      !privilege.can_insert_checkpoints ||
      !privilege.can_delete_checkpoints ||
      // Checkpoint generations are immutable.
      privilege.can_update_checkpoints ||
      !privilege.can_insert_capacity ||
      privilege.can_update_capacity ||
      privilege.can_delete_capacity ||
      // WAL telemetry needs pg_monitor: only a dedicated monitoring role.
      privilege.is_monitor_member ||
      privilege.is_read_all_stats_member
    ) {
      throw new Error(
        'Worker runtime privileges do not match the expected policy.',
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
            'radar_worker_runtime',
            format('public.%I', table_name),
            'SELECT'
          ) AS can_select,
          has_table_privilege(
            'radar_worker_runtime',
            format('public.%I', table_name),
            'INSERT'
          ) AS can_insert,
          has_table_privilege(
            'radar_worker_runtime',
            format('public.%I', table_name),
            'UPDATE'
          ) AS can_update,
          has_table_privilege(
            'radar_worker_runtime',
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
        'Worker runtime taxonomy privileges do not match read-only policy.',
      );
    }

    const classificationPrivileges = await pool.query<{
      run_select: boolean;
      run_insert: boolean;
      run_table_update: boolean;
      run_status_update: boolean;
      run_engine_update: boolean;
      run_delete: boolean;
      assertion_select: boolean;
      assertion_insert: boolean;
      assertion_update: boolean;
      span_select: boolean;
      span_insert: boolean;
      span_update: boolean;
      review_select: boolean;
      review_insert: boolean;
      effective_select: boolean;
    }>(`
      SELECT
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_runs','SELECT') AS run_select,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_runs','INSERT') AS run_insert,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_runs','UPDATE') AS run_table_update,
        has_column_privilege('radar_worker_runtime','public.publication_taxonomy_runs','status','UPDATE') AS run_status_update,
        has_column_privilege('radar_worker_runtime','public.publication_taxonomy_runs','engine_version','UPDATE') AS run_engine_update,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_runs','DELETE') AS run_delete,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_assertions','SELECT') AS assertion_select,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_assertions','INSERT') AS assertion_insert,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_assertions','UPDATE') AS assertion_update,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_spans','SELECT') AS span_select,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_spans','INSERT') AS span_insert,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_spans','UPDATE') AS span_update,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_reviews','SELECT') AS review_select,
        has_table_privilege('radar_worker_runtime','public.publication_taxonomy_reviews','INSERT') AS review_insert,
        has_table_privilege('radar_worker_runtime','public.v_publication_taxonomy_effective_assertions','SELECT') AS effective_select
    `);

    const cp = classificationPrivileges.rows[0];
    if (
      !cp ||
      !cp.run_select || !cp.run_insert || cp.run_table_update ||
      !cp.run_status_update || cp.run_engine_update || cp.run_delete ||
      !cp.assertion_select || !cp.assertion_insert || cp.assertion_update ||
      !cp.span_select || !cp.span_insert || cp.span_update ||
      cp.review_select || cp.review_insert ||
      !cp.effective_select
    ) {
      throw new Error(
        'Worker classification privileges do not match the expected policy.',
      );
    }

    const curatorMembership = await pool.query<{
      is_curator_member: boolean;
    }>(`
      SELECT pg_has_role(
        'radar_worker_runtime',
        'radar_taxonomy_curator',
        'MEMBER'
      ) AS is_curator_member
    `);

    if (curatorMembership.rows[0]?.is_curator_member) {
      throw new Error(
        'Worker runtime must not inherit taxonomy curator privileges.',
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
