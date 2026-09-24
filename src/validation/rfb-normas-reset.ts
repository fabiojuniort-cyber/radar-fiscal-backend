import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const sourceResult = await client.query(
    `SELECT id, code, connector_key, schedule_cron, schedule_timezone, is_active
       FROM sources
      WHERE code = 'rfb-normas'
      FOR UPDATE`,
  );
  if (sourceResult.rowCount !== 1) throw new Error('Expected exactly one rfb-normas source.');
  const source = sourceResult.rows[0];

  if (source.connector_key !== 'rfb-normas') {
    throw new Error('Safety gate failed: connector_key is not rfb-normas.');
  }
  if (source.schedule_cron !== null) {
    throw new Error('Safety gate failed: RFB cron must be NULL before reset.');
  }

  const active = await client.query(
    `SELECT id, status
       FROM collection_runs
      WHERE source_id = $1
        AND status IN ('PENDING','RUNNING')
      ORDER BY created_at`,
    [source.id],
  );
  if (active.rowCount) {
    throw new Error('Safety gate failed: active RFB collection run exists.');
  }

  const publicationIdsResult = await client.query(
    `SELECT DISTINCT publication_id
       FROM publication_origins
      WHERE source_id = $1`,
    [source.id],
  );
  const publicationIds = publicationIdsResult.rows.map((row) => row.publication_id as string);

  const crossSource = await client.query(
    `SELECT po.publication_id,
            count(DISTINCT po.source_id)::int AS source_count,
            array_agg(DISTINCT s.code ORDER BY s.code) AS sources
       FROM publication_origins po
       JOIN sources s ON s.id = po.source_id
      WHERE po.publication_id = ANY($1::uuid[])
      GROUP BY po.publication_id
      HAVING count(DISTINCT po.source_id) > 1
      LIMIT 20`,
    [publicationIds],
  );
  if (crossSource.rowCount) {
    throw new Error('Safety gate failed: RFB publications are already shared with another source: ' + JSON.stringify(crossSource.rows));
  }

  const companyLinks = publicationIds.length
    ? await client.query(
        `SELECT count(*)::int AS count
           FROM company_publications
          WHERE publication_id = ANY($1::uuid[])`,
        [publicationIds],
      )
    : { rows: [{ count: 0 }] };
  if (Number(companyLinks.rows[0]?.count ?? 0) > 0) {
    throw new Error('Safety gate failed: RFB publications already have company relevance links.');
  }

  const stats = await client.query(
    `SELECT
       (SELECT count(*)::int FROM collection_runs WHERE source_id = $1) AS runs,
       (SELECT count(*)::int FROM collection_checkpoints WHERE source_id = $1 AND connector_key = 'rfb-normas') AS checkpoints,
       (SELECT count(*)::int FROM publication_origins WHERE source_id = $1) AS origins,
       (SELECT count(DISTINCT publication_id)::int FROM publication_origins WHERE source_id = $1) AS publications,
       (SELECT count(*)::int
          FROM publication_versions pv
          WHERE pv.publication_id IN (
            SELECT publication_id FROM publication_origins WHERE source_id = $1
          )) AS versions`,
    [source.id],
  );

  if (!apply) {
    await client.query('ROLLBACK');
    console.log('RFB_NORMAS_RESET=' + JSON.stringify({
      apply: false,
      state: 'DRY_RUN_OK',
      source,
      stats: stats.rows[0],
      crossSourceCount: 0,
      companyLinks: 0,
    }));
    process.exit(0);
  }

  await client.query(
    `DELETE FROM collection_checkpoints
      WHERE source_id = $1 AND connector_key = 'rfb-normas'`,
    [source.id],
  );
  await client.query(
    `DELETE FROM collection_runs WHERE source_id = $1`,
    [source.id],
  );
  await client.query(
    `DELETE FROM publication_origins WHERE source_id = $1`,
    [source.id],
  );

  if (publicationIds.length) {
    await client.query(
      `DELETE FROM publications p
        WHERE p.id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM publication_origins po WHERE po.publication_id = p.id
          )`,
      [publicationIds],
    );
  }

  const after = await client.query(
    `SELECT
       (SELECT count(*)::int FROM collection_runs WHERE source_id = $1) AS runs,
       (SELECT count(*)::int FROM collection_checkpoints WHERE source_id = $1 AND connector_key = 'rfb-normas') AS checkpoints,
       (SELECT count(*)::int FROM publication_origins WHERE source_id = $1) AS origins,
       (SELECT count(*)::int FROM publications p
          WHERE p.id = ANY($2::uuid[])) AS prior_publications_remaining`,
    [source.id, publicationIds],
  );

  await client.query('COMMIT');
  console.log('RFB_NORMAS_RESET=' + JSON.stringify({
    apply: true,
    state: 'APPLIED',
    before: stats.rows[0],
    after: after.rows[0],
  }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
