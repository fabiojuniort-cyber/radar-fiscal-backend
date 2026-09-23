import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

/**
 * Controlled clean-up of SPED domain data produced by a defective activation.
 *
 * Removes ONLY publications whose every origin belongs to the SPED source,
 * together with their dependent versions, files and run links (FK cascade).
 * Never removes collection_runs, collection_attempts or collection_items: the
 * incident telemetry is preserved (collection_items.publication_id is set to
 * NULL so items keep documenting what happened).
 *
 * Refuses to act when any safety precondition fails.
 */
export interface SpedSanitizationPlan {
  sourceId: string;
  sourceCode: string;
  scheduleCron: string | null;
  activeRuns: Array<{ id: string; status: string }>;
  runs: Array<{ id: string; status: string; triggerType: string; startedAt: string | null; finishedAt: string | null; dispositions: Record<string, number> }>;
  counts: {
    publications: number;
    publicationVersions: number;
    publicationFiles: number;
    publicationOrigins: number;
    collectionRunPublications: number;
    collectionItemsReferencing: number;
    companyPublications: number;
    publicationMatches: number;
    runsPreserved: number;
    attemptsPreserved: number;
    itemsPreserved: number;
  };
  sharedWithOtherSources: Array<{ publicationId: string; otherSourceIds: string[] }>;
  foreignRunLinks: number;
  blockers: string[];
  confirmationToken: string;
}

function token(plan: Omit<SpedSanitizationPlan, 'confirmationToken'>): string {
  const basis = JSON.stringify({ sourceId: plan.sourceId, counts: plan.counts, runs: plan.runs.map((run) => run.id) });
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export async function planSpedSanitization(client: PoolClient, sourceCode = 'sped'): Promise<SpedSanitizationPlan> {
  const source = (await client.query<{ id: string; code: string; schedule_cron: string | null }>(
    `SELECT id, code, schedule_cron FROM sources WHERE code = $1`,
    [sourceCode],
  )).rows[0];
  if (!source) throw new Error('Source not found: ' + sourceCode);

  const ids = `SELECT DISTINCT publication_id FROM publication_origins WHERE source_id = $1`;
  const one = async (sql: string): Promise<number> =>
    Number((await client.query<{ count: number }>(sql, [source.id])).rows[0]?.count ?? 0);

  const shared = (await client.query<{ publication_id: string; other_sources: string[] }>(`
    SELECT po.publication_id, array_agg(DISTINCT other.source_id::text) AS other_sources
    FROM publication_origins po
    JOIN publication_origins other ON other.publication_id = po.publication_id AND other.source_id <> $1
    WHERE po.source_id = $1
    GROUP BY po.publication_id
  `, [source.id])).rows;

  const activeRuns = (await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM collection_runs WHERE source_id = $1 AND status IN ('PENDING','RUNNING') ORDER BY created_at`,
    [source.id],
  )).rows;

  const runs = (await client.query<{
    id: string; status: string; trigger_type: string; started_at: Date | null; finished_at: Date | null; dispositions: Record<string, number>;
  }>(`
    SELECT cr.id, cr.status, cr.trigger_type, cr.started_at, cr.finished_at,
           COALESCE((
             SELECT jsonb_object_agg(disposition, count) FROM (
               SELECT disposition, count(*)::int AS count
               FROM collection_run_publications crp WHERE crp.collection_run_id = cr.id
               GROUP BY disposition
             ) d
           ), '{}'::jsonb) AS dispositions
    FROM collection_runs cr WHERE cr.source_id = $1 ORDER BY cr.created_at
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
    runsPreserved: await one(`SELECT count(*)::int AS count FROM collection_runs WHERE source_id = $1`),
    attemptsPreserved: await one(`
      SELECT count(*)::int AS count FROM collection_attempts ca
      JOIN collection_runs cr ON cr.id = ca.collection_run_id WHERE cr.source_id = $1`),
    itemsPreserved: await one(`
      SELECT count(*)::int AS count FROM collection_items ci
      JOIN collection_runs cr ON cr.id = ci.collection_run_id WHERE cr.source_id = $1`),
  };

  // Every run link to these publications must come from a SPED run.
  const foreignRunLinks = await one(`
    SELECT count(*)::int AS count FROM collection_run_publications crp
    JOIN collection_runs cr ON cr.id = crp.collection_run_id
    WHERE crp.publication_id IN (${ids}) AND cr.source_id <> $1`);

  const blockers: string[] = [];
  if (source.schedule_cron !== null) blockers.push('schedule_cron must be NULL during sanitization');
  if (activeRuns.length) blockers.push('SPED has PENDING/RUNNING runs');
  if (shared.length) blockers.push('publications shared with other sources');
  if (foreignRunLinks > 0) blockers.push('publications linked to runs of other sources');
  if (counts.companyPublications > 0 || counts.publicationMatches > 0) {
    blockers.push('publications already related to companies (company_publications/publication_matches)');
  }

  const plan = {
    sourceId: source.id,
    sourceCode: source.code,
    scheduleCron: source.schedule_cron,
    activeRuns,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      triggerType: run.trigger_type,
      startedAt: run.started_at?.toISOString() ?? null,
      finishedAt: run.finished_at?.toISOString() ?? null,
      dispositions: run.dispositions,
    })),
    counts,
    sharedWithOtherSources: shared.map((row) => ({ publicationId: row.publication_id, otherSourceIds: row.other_sources })),
    foreignRunLinks,
    blockers,
  };
  return { ...plan, confirmationToken: token(plan) };
}

export interface SpedSanitizationResult {
  plan: SpedSanitizationPlan;
  removed: { publications: number; origins: number; itemsUnlinked: number };
  after: SpedSanitizationPlan['counts'];
}

export async function executeSpedSanitization(
  client: PoolClient,
  confirmationToken: string,
  sourceCode = 'sped',
): Promise<SpedSanitizationResult> {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query(`SELECT id FROM sources WHERE code = $1 FOR UPDATE`, [sourceCode]);
    const plan = await planSpedSanitization(client, sourceCode);
    if (plan.blockers.length) throw new Error('Sanitization blocked: ' + plan.blockers.join('; '));
    if (plan.confirmationToken !== confirmationToken) {
      throw new Error('Confirmation token mismatch: data changed since the dry-run (expected ' + plan.confirmationToken + ').');
    }

    await client.query(`CREATE TEMP TABLE sped_sanitize_targets ON COMMIT DROP AS
      SELECT DISTINCT publication_id AS id FROM publication_origins WHERE source_id = $1`, [plan.sourceId]);
    const unlinked = await client.query(
      `UPDATE collection_items SET publication_id = NULL WHERE publication_id IN (SELECT id FROM sped_sanitize_targets)`,
    );
    const origins = await client.query(`DELETE FROM publication_origins WHERE source_id = $1`, [plan.sourceId]);
    const publications = await client.query(
      `DELETE FROM publications WHERE id IN (SELECT id FROM sped_sanitize_targets)`,
    );

    const after = (await planSpedSanitization(client, sourceCode)).counts;
    if (after.publications !== 0 || after.publicationOrigins !== 0) throw new Error('Post-condition failed: SPED data remains.');
    if (after.runsPreserved !== plan.counts.runsPreserved || after.attemptsPreserved !== plan.counts.attemptsPreserved || after.itemsPreserved !== plan.counts.itemsPreserved) {
      throw new Error('Post-condition failed: runs/attempts/items must be preserved.');
    }

    await client.query('COMMIT');
    return {
      plan,
      removed: {
        publications: publications.rowCount ?? 0,
        origins: origins.rowCount ?? 0,
        itemsUnlinked: unlinked.rowCount ?? 0,
      },
      after,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
