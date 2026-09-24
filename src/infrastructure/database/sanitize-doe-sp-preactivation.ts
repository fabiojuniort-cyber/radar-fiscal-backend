import 'dotenv/config';

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

type Plan = {
  sourceId: string;
  sourceCode: string;
  scheduleCron: string | null;
  activeRuns: Array<{ id: string; status: string }>;
  counts: {
    publications: number;
    publicationVersions: number;
    publicationFiles: number;
    publicationOrigins: number;
    collectionRunPublications: number;
    collectionItemsReferencing: number;
    companyPublications: number;
    publicationMatches: number;
    checkpoints: number;
    runsPreserved: number;
    attemptsPreserved: number;
    itemsPreserved: number;
  };
  sharedWithOtherSources: Array<{ publicationId: string; otherSourceIds: string[] }>;
  foreignRunLinks: number;
  blockers: string[];
  confirmationToken: string;
};

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');

const execute = process.env.DOE_SP_SANITIZE_EXECUTE === '1';
const providedToken = process.env.DOE_SP_SANITIZE_CONFIRM;

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function plan(client: import('pg').PoolClient): Promise<Plan> {
  const source = (await client.query<{ id: string; code: string; schedule_cron: string | null }>(
    `SELECT id, code, schedule_cron FROM sources WHERE code = 'doe-sp'`,
  )).rows[0];
  if (!source) throw new Error('DOE-SP source not found.');

  const ids = `SELECT DISTINCT publication_id FROM publication_origins WHERE source_id = $1`;
  const one = async (sql: string): Promise<number> =>
    Number((await client.query<{ count: number }>(sql, [source.id])).rows[0]?.count ?? 0);

  const activeRuns = (await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM collection_runs
     WHERE source_id = $1 AND status IN ('PENDING','RUNNING')
     ORDER BY created_at`,
    [source.id],
  )).rows;

  const shared = (await client.query<{ publication_id: string; other_sources: string[] }>(`
    SELECT po.publication_id, array_agg(DISTINCT other.source_id::text) AS other_sources
    FROM publication_origins po
    JOIN publication_origins other
      ON other.publication_id = po.publication_id
     AND other.source_id <> $1
    WHERE po.source_id = $1
    GROUP BY po.publication_id
  `, [source.id])).rows;

  const counts = {
    publications: await one(`SELECT count(*)::int AS count FROM (${ids}) t`),
    publicationVersions: await one(`SELECT count(*)::int AS count FROM publication_versions WHERE publication_id IN (${ids})`),
    publicationFiles: await one(`
      SELECT count(*)::int AS count FROM publication_files pf
      JOIN publication_versions pv ON pv.id = pf.publication_version_id
      WHERE pv.publication_id IN (${ids})`),
    publicationOrigins: await one(`SELECT count(*)::int AS count FROM publication_origins WHERE source_id = $1`),
    collectionRunPublications: await one(`SELECT count(*)::int AS count FROM collection_run_publications WHERE publication_id IN (${ids})`),
    collectionItemsReferencing: await one(`SELECT count(*)::int AS count FROM collection_items WHERE publication_id IN (${ids})`),
    companyPublications: await one(`SELECT count(*)::int AS count FROM company_publications WHERE publication_id IN (${ids})`),
    publicationMatches: await one(`
      SELECT count(*)::int AS count FROM publication_matches pm
      JOIN company_publications cp ON cp.id = pm.company_publication_id
      WHERE cp.publication_id IN (${ids})`),
    checkpoints: await one(`SELECT count(*)::int AS count FROM collection_checkpoints WHERE source_id = $1`),
    runsPreserved: await one(`SELECT count(*)::int AS count FROM collection_runs WHERE source_id = $1`),
    attemptsPreserved: await one(`
      SELECT count(*)::int AS count FROM collection_attempts ca
      JOIN collection_runs cr ON cr.id = ca.collection_run_id
      WHERE cr.source_id = $1`),
    itemsPreserved: await one(`
      SELECT count(*)::int AS count FROM collection_items ci
      JOIN collection_runs cr ON cr.id = ci.collection_run_id
      WHERE cr.source_id = $1`),
  };

  const foreignRunLinks = await one(`
    SELECT count(*)::int AS count FROM collection_run_publications crp
    JOIN collection_runs cr ON cr.id = crp.collection_run_id
    WHERE crp.publication_id IN (${ids}) AND cr.source_id <> $1`);

  const blockers: string[] = [];
  if (source.schedule_cron !== null) blockers.push('schedule_cron must be NULL during sanitization');
  if (activeRuns.length) blockers.push('DOE-SP has PENDING/RUNNING runs');
  if (shared.length) blockers.push('DOE-SP publications are shared with other sources');
  if (foreignRunLinks > 0) blockers.push('DOE-SP publications are linked to runs from other sources');
  if (counts.companyPublications > 0 || counts.publicationMatches > 0) {
    blockers.push('DOE-SP publications already have company relevance records');
  }

  const basis = JSON.stringify({
    sourceId: source.id,
    counts,
    shared: shared.map((row) => [row.publication_id, row.other_sources]),
    foreignRunLinks,
  });
  const confirmationToken = createHash('sha256').update(basis).digest('hex').slice(0, 16);

  return {
    sourceId: source.id,
    sourceCode: source.code,
    scheduleCron: source.schedule_cron,
    activeRuns,
    counts,
    sharedWithOtherSources: shared.map((row) => ({
      publicationId: row.publication_id,
      otherSourceIds: row.other_sources,
    })),
    foreignRunLinks,
    blockers,
    confirmationToken,
  };
}

const client = await pool.connect();
try {
  if (!execute) {
    console.log('DOE_SP_SANITIZE_DRY_RUN=' + JSON.stringify(await plan(client)));
  } else {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await client.query(`SELECT id FROM sources WHERE code = 'doe-sp' FOR UPDATE`);
      const before = await plan(client);
      if (before.blockers.length) throw new Error('Sanitization blocked: ' + before.blockers.join('; '));
      if (!providedToken || providedToken !== before.confirmationToken) {
        throw new Error('DOE_SP_SANITIZE_CONFIRM mismatch; expected ' + before.confirmationToken);
      }

      await client.query(`
        CREATE TEMP TABLE doe_sp_sanitize_targets ON COMMIT DROP AS
        SELECT DISTINCT publication_id AS id
        FROM publication_origins
        WHERE source_id = $1
      `, [before.sourceId]);

      const unlinked = await client.query(`
        UPDATE collection_items
        SET publication_id = NULL
        WHERE publication_id IN (SELECT id FROM doe_sp_sanitize_targets)
      `);
      const origins = await client.query(`
        DELETE FROM publication_origins WHERE source_id = $1
      `, [before.sourceId]);
      const publications = await client.query(`
        DELETE FROM publications WHERE id IN (SELECT id FROM doe_sp_sanitize_targets)
      `);
      const checkpoints = await client.query(`
        DELETE FROM collection_checkpoints WHERE source_id = $1
      `, [before.sourceId]);

      const after = await plan(client);
      if (after.counts.publications !== 0 || after.counts.publicationOrigins !== 0 || after.counts.checkpoints !== 0) {
        throw new Error('Post-condition failed: DOE-SP domain data/checkpoints remain.');
      }
      if (
        after.counts.runsPreserved !== before.counts.runsPreserved ||
        after.counts.attemptsPreserved !== before.counts.attemptsPreserved ||
        after.counts.itemsPreserved !== before.counts.itemsPreserved
      ) {
        throw new Error('Post-condition failed: runs/attempts/items must be preserved.');
      }

      await client.query('COMMIT');
      console.log('DOE_SP_SANITIZE_EXECUTED=' + JSON.stringify({
        removed: {
          publications: publications.rowCount ?? 0,
          origins: origins.rowCount ?? 0,
          checkpoints: checkpoints.rowCount ?? 0,
          itemsUnlinked: unlinked.rowCount ?? 0,
        },
        preserved: {
          runs: before.counts.runsPreserved,
          attempts: before.counts.attemptsPreserved,
          items: before.counts.itemsPreserved,
        },
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
