import 'dotenv/config';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const BAD_RUN_ID = 'c4bda609-fb6c-4cb5-a333-8f1972e5de7f';
const EXPECTED_FALSE_VERSIONS = 12;

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const runResult = await client.query(
    `SELECT cr.id, cr.status, cr.error_summary, s.code AS source_code
       FROM collection_runs cr
       JOIN sources s ON s.id = cr.source_id
      WHERE cr.id = $1
      FOR UPDATE OF cr`,
    [BAD_RUN_ID],
  );
  if (runResult.rowCount !== 1) throw new Error('Expected the known partial CGIBS run.');
  const run = runResult.rows[0];
  if (run.source_code !== 'cgibs' || run.status !== 'PARTIAL_SUCCESS') {
    throw new Error(`Safety gate failed: run source/status is ${run.source_code}/${run.status}.`);
  }

  const falseRowsResult = await client.query(
    `SELECT
        crp.publication_id,
        crp.publication_version_id AS false_version_id,
        crp.disposition,
        p.act_type,
        p.act_number,
        p.title,
        false_pv.version_no AS false_version_no,
        false_pv.content_hash AS false_content_hash,
        false_pv.is_current AS false_is_current,
        current_pv.id AS current_version_id,
        current_pv.version_no AS current_version_no,
        current_pv.content_hash AS current_content_hash,
        ci.status AS item_status,
        ci.source_item_key
       FROM collection_run_publications crp
       JOIN publications p ON p.id = crp.publication_id
       JOIN publication_versions false_pv ON false_pv.id = crp.publication_version_id
       JOIN publication_versions current_pv
         ON current_pv.publication_id = crp.publication_id
        AND current_pv.is_current = TRUE
       LEFT JOIN collection_items ci
         ON ci.collection_run_id = crp.collection_run_id
        AND ci.publication_id = crp.publication_id
      WHERE crp.collection_run_id = $1
        AND crp.disposition = 'NEW_VERSION'
      ORDER BY p.act_type, p.act_number, p.title
      FOR UPDATE OF crp, false_pv, current_pv`,
    [BAD_RUN_ID],
  );

  const rows = falseRowsResult.rows;
  if (rows.length !== EXPECTED_FALSE_VERSIONS) {
    throw new Error(`Safety gate failed: expected ${EXPECTED_FALSE_VERSIONS} false versions, found ${rows.length}.`);
  }

  const publicationIds = new Set(rows.map((row) => row.publication_id as string));
  if (publicationIds.size !== EXPECTED_FALSE_VERSIONS) {
    throw new Error('Safety gate failed: false versions do not map 1:1 to publications.');
  }

  for (const row of rows) {
    if (row.false_is_current) {
      throw new Error(`Safety gate failed: false version ${row.false_version_id} is still current.`);
    }
    if (row.false_version_id === row.current_version_id) {
      throw new Error(`Safety gate failed: false/current version collision for ${row.publication_id}.`);
    }
    if (row.item_status !== 'NEW_VERSION') {
      throw new Error(`Safety gate failed: collection item for ${row.publication_id} has status ${row.item_status}.`);
    }
  }

  const before = rows.map((row) => ({
    publicationId: row.publication_id,
    actType: row.act_type,
    actNumber: row.act_number,
    title: row.title,
    sourceItemKey: row.source_item_key,
    falseVersionId: row.false_version_id,
    falseVersionNo: row.false_version_no,
    falseContentHash: row.false_content_hash,
    currentVersionId: row.current_version_id,
    currentVersionNo: row.current_version_no,
    currentContentHash: row.current_content_hash,
  }));

  if (!APPLY) {
    await client.query('ROLLBACK');
    console.log('CGIBS_FALSE_VERSION_CLEANUP=' + JSON.stringify({
      apply: false,
      state: 'DRY_RUN_OK',
      run,
      count: rows.length,
      rows: before,
    }));
    process.exit(0);
  }

  for (const row of rows) {
    await client.query(
      `UPDATE collection_run_publications
          SET publication_version_id = $3,
              disposition = 'EXISTING_PUBLICATION'
        WHERE collection_run_id = $1
          AND publication_id = $2
          AND publication_version_id = $4
          AND disposition = 'NEW_VERSION'`,
      [BAD_RUN_ID, row.publication_id, row.current_version_id, row.false_version_id],
    );

    await client.query(
      `UPDATE collection_items
          SET status = 'PROCESSED_EXISTING',
              updated_at = now()
        WHERE collection_run_id = $1
          AND publication_id = $2
          AND status = 'NEW_VERSION'`,
      [BAD_RUN_ID, row.publication_id],
    );
  }

  const falseVersionIds = rows.map((row) => row.false_version_id as string);
  const deleted = await client.query(
    `DELETE FROM publication_versions
      WHERE id = ANY($1::uuid[])
      RETURNING id`,
    [falseVersionIds],
  );
  if (deleted.rowCount !== EXPECTED_FALSE_VERSIONS) {
    throw new Error(`Safety gate failed: expected to delete ${EXPECTED_FALSE_VERSIONS} versions, deleted ${deleted.rowCount}.`);
  }

  const afterRun = await client.query(
    `SELECT
        count(*) FILTER (WHERE disposition = 'NEW_VERSION')::int AS new_versions,
        count(*) FILTER (WHERE disposition = 'EXISTING_PUBLICATION')::int AS existing_publications,
        count(*) FILTER (WHERE disposition = 'NEW_PUBLICATION')::int AS new_publications
       FROM collection_run_publications
      WHERE collection_run_id = $1`,
    [BAD_RUN_ID],
  );

  const afterVersions = await client.query(
    `SELECT
        count(DISTINCT po.publication_id)::int AS publications,
        count(pv.id)::int AS versions,
        count(*) FILTER (WHERE pv.is_current)::int AS current_versions,
        count(*) FILTER (WHERE NOT pv.is_current)::int AS historical_versions
       FROM publication_origins po
       JOIN sources s ON s.id = po.source_id
       JOIN publication_versions pv ON pv.publication_id = po.publication_id
      WHERE s.code = 'cgibs'`,
  );

  await client.query('COMMIT');
  console.log('CGIBS_FALSE_VERSION_CLEANUP=' + JSON.stringify({
    apply: true,
    state: 'APPLIED',
    deletedCount: deleted.rowCount,
    before,
    afterRun: afterRun.rows[0],
    afterVersions: afterVersions.rows[0],
  }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
