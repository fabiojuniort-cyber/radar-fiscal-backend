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

const IDENTITY_TABLES = [
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

    const identities = await readPrivileges(pool, IDENTITY_TABLES);

    if (
      identities.length !== IDENTITY_TABLES.length ||
      identities.some(
        (row) =>
          !row.can_select ||
          !row.can_insert ||
          row.can_update ||
          row.can_delete,
      )
    ) {
      throw new Error(
        'Curator identity tables must use column-level UPDATE only.',
      );
    }

    const columns = await pool.query<{
      release_status: boolean;
      release_id: boolean;
      release_created_at: boolean;
      release_created_by_actor: boolean;
      dimension_status: boolean;
      dimension_id: boolean;
      dimension_code: boolean;
      dimension_created_at: boolean;
      concept_status: boolean;
      concept_id: boolean;
      concept_code: boolean;
      concept_dimension_id: boolean;
      concept_created_at: boolean;
      edition_status: boolean;
      edition_valid_to: boolean;
      edition_id: boolean;
      edition_catalog_id: boolean;
      edition_code: boolean;
      edition_created_at: boolean;
    }>(`
      SELECT
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_releases',
          'status',
          'UPDATE'
        ) AS release_status,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_releases',
          'id',
          'UPDATE'
        ) AS release_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_releases',
          'created_at',
          'UPDATE'
        ) AS release_created_at,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_releases',
          'created_by_actor',
          'UPDATE'
        ) AS release_created_by_actor,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_dimensions',
          'identity_status',
          'UPDATE'
        ) AS dimension_status,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_dimensions',
          'id',
          'UPDATE'
        ) AS dimension_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_dimensions',
          'code',
          'UPDATE'
        ) AS dimension_code,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_dimensions',
          'created_at',
          'UPDATE'
        ) AS dimension_created_at,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_concepts',
          'identity_status',
          'UPDATE'
        ) AS concept_status,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_concepts',
          'id',
          'UPDATE'
        ) AS concept_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_concepts',
          'code',
          'UPDATE'
        ) AS concept_code,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_concepts',
          'dimension_id',
          'UPDATE'
        ) AS concept_dimension_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'taxonomy_concepts',
          'created_at',
          'UPDATE'
        ) AS concept_created_at,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'status',
          'UPDATE'
        ) AS edition_status,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'valid_to',
          'UPDATE'
        ) AS edition_valid_to,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'id',
          'UPDATE'
        ) AS edition_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'catalog_id',
          'UPDATE'
        ) AS edition_catalog_id,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'edition_code',
          'UPDATE'
        ) AS edition_code,
        has_column_privilege(
          'radar_taxonomy_curator',
          'official_catalog_editions',
          'created_at',
          'UPDATE'
        ) AS edition_created_at
    `);

    const columnPolicy = columns.rows[0];

    if (
      !columnPolicy ||
      !columnPolicy.release_status ||
      columnPolicy.release_id ||
      columnPolicy.release_created_at ||
      columnPolicy.release_created_by_actor ||
      !columnPolicy.dimension_status ||
      columnPolicy.dimension_id ||
      columnPolicy.dimension_code ||
      columnPolicy.dimension_created_at ||
      !columnPolicy.concept_status ||
      columnPolicy.concept_id ||
      columnPolicy.concept_code ||
      columnPolicy.concept_dimension_id ||
      columnPolicy.concept_created_at ||
      !columnPolicy.edition_status ||
      !columnPolicy.edition_valid_to ||
      columnPolicy.edition_id ||
      columnPolicy.edition_catalog_id ||
      columnPolicy.edition_code ||
      columnPolicy.edition_created_at
    ) {
      throw new Error(
        'Curator column-level UPDATE privileges are invalid.',
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

    const editionTable = await readPrivileges(
      pool,
      ['official_catalog_editions'],
    );

    if (
      editionTable.length !== 1 ||
      !editionTable[0]?.can_select ||
      !editionTable[0]?.can_insert ||
      editionTable[0]?.can_update ||
      editionTable[0]?.can_delete
    ) {
      throw new Error(
        'Catalog editions must use lifecycle column-level UPDATE only.',
      );
    }

    const classification = await pool.query<{
      run_select: boolean;
      run_insert: boolean;
      assertion_select: boolean;
      assertion_insert: boolean;
      span_select: boolean;
      span_insert: boolean;
      review_select: boolean;
      review_insert: boolean;
      review_update: boolean;
      review_delete: boolean;
      effective_select: boolean;
    }>(`
      SELECT
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_runs','SELECT') AS run_select,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_runs','INSERT') AS run_insert,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_assertions','SELECT') AS assertion_select,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_assertions','INSERT') AS assertion_insert,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_spans','SELECT') AS span_select,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_spans','INSERT') AS span_insert,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_reviews','SELECT') AS review_select,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_reviews','INSERT') AS review_insert,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_reviews','UPDATE') AS review_update,
        has_table_privilege('radar_taxonomy_curator','public.publication_taxonomy_reviews','DELETE') AS review_delete,
        has_table_privilege('radar_taxonomy_curator','public.v_publication_taxonomy_effective_assertions','SELECT') AS effective_select
    `);
    const classPolicy = classification.rows[0];
    if (
      !classPolicy ||
      !classPolicy.run_select || classPolicy.run_insert ||
      !classPolicy.assertion_select || classPolicy.assertion_insert ||
      !classPolicy.span_select || classPolicy.span_insert ||
      !classPolicy.review_select || !classPolicy.review_insert ||
      classPolicy.review_update || classPolicy.review_delete ||
      !classPolicy.effective_select
    ) {
      throw new Error(
        'Taxonomy curator classification privileges are invalid.',
      );
    }

    const candidatePrivileges = await pool.query<{
      occurrence_select: boolean;
      occurrence_insert: boolean;
      candidate_select: boolean;
      candidate_insert: boolean;
      candidate_table_update: boolean;
      candidate_status_update: boolean;
      candidate_key_update: boolean;
      candidate_delete: boolean;
      link_select: boolean;
      link_insert: boolean;
      link_table_update: boolean;
      link_status_update: boolean;
      link_occurrence_update: boolean;
      link_delete: boolean;
    }>(`
      SELECT
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_unmapped_occurrences',
          'SELECT'
        ) AS occurrence_select,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_unmapped_occurrences',
          'INSERT'
        ) AS occurrence_insert,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'SELECT'
        ) AS candidate_select,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'INSERT'
        ) AS candidate_insert,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'UPDATE'
        ) AS candidate_table_update,
        has_column_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'status',
          'UPDATE'
        ) AS candidate_status_update,
        has_column_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'normalized_key',
          'UPDATE'
        ) AS candidate_key_update,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidates',
          'DELETE'
        ) AS candidate_delete,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'SELECT'
        ) AS link_select,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'INSERT'
        ) AS link_insert,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'UPDATE'
        ) AS link_table_update,
        has_column_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'link_status',
          'UPDATE'
        ) AS link_status_update,
        has_column_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'occurrence_id',
          'UPDATE'
        ) AS link_occurrence_update,
        has_table_privilege(
          'radar_taxonomy_curator',
          'public.taxonomy_candidate_occurrence_links',
          'DELETE'
        ) AS link_delete
    `);

    const candidatePolicy =
      candidatePrivileges.rows[0];

    if (
      !candidatePolicy ||
      !candidatePolicy.occurrence_select ||
      candidatePolicy.occurrence_insert ||
      !candidatePolicy.candidate_select ||
      !candidatePolicy.candidate_insert ||
      candidatePolicy.candidate_table_update ||
      !candidatePolicy.candidate_status_update ||
      candidatePolicy.candidate_key_update ||
      candidatePolicy.candidate_delete ||
      !candidatePolicy.link_select ||
      !candidatePolicy.link_insert ||
      candidatePolicy.link_table_update ||
      !candidatePolicy.link_status_update ||
      candidatePolicy.link_occurrence_update ||
      candidatePolicy.link_delete
    ) {
      throw new Error(
        'Taxonomy curator candidate privileges are invalid.',
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
