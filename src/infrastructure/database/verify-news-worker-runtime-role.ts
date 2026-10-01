import { Pool } from 'pg';
import { z } from 'zod';

const schema = z.object({
  DATABASE_ADMIN_URL: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid NEWS worker role verification configuration.', parsed.error.issues);
  process.exit(1);
}

const pool = new Pool({ connectionString: parsed.data.DATABASE_ADMIN_URL, max: 1 });

try {
  const result = await pool.query<{
    item_select: boolean;
    item_insert: boolean;
    item_update: boolean;
    item_delete: boolean;
    version_select: boolean;
    version_insert: boolean;
    version_update: boolean;
    version_delete: boolean;
    app_item_select: boolean;
    app_version_select: boolean;
    app_version_insert: boolean;
  }>(`
    SELECT
      has_table_privilege('radar_worker_runtime','public.news_items','SELECT') AS item_select,
      has_table_privilege('radar_worker_runtime','public.news_items','INSERT') AS item_insert,
      has_table_privilege('radar_worker_runtime','public.news_items','UPDATE') AS item_update,
      has_table_privilege('radar_worker_runtime','public.news_items','DELETE') AS item_delete,
      has_table_privilege('radar_worker_runtime','public.news_item_versions','SELECT') AS version_select,
      has_table_privilege('radar_worker_runtime','public.news_item_versions','INSERT') AS version_insert,
      has_table_privilege('radar_worker_runtime','public.news_item_versions','UPDATE') AS version_update,
      has_table_privilege('radar_worker_runtime','public.news_item_versions','DELETE') AS version_delete,
      has_table_privilege('radar_app_runtime','public.news_items','SELECT') AS app_item_select,
      has_table_privilege('radar_app_runtime','public.news_item_versions','SELECT') AS app_version_select,
      has_table_privilege('radar_app_runtime','public.news_item_versions','INSERT') AS app_version_insert
  `);

  const p = result.rows[0];
  if (
    !p ||
    !p.item_select ||
    !p.item_insert ||
    !p.item_update ||
    p.item_delete ||
    !p.version_select ||
    !p.version_insert ||
    p.version_update ||
    p.version_delete ||
    !p.app_item_select ||
    !p.app_version_select ||
    p.app_version_insert
  ) {
    throw new Error('NEWS runtime privileges do not match the immutable-version policy.');
  }

  console.log('Database NEWS worker runtime security verified.');
} finally {
  await pool.end();
}
