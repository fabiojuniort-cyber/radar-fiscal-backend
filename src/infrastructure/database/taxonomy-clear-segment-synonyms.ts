import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { canonicalJson } from '../../modules/taxonomy/baseline/baseline.canonical-json.js';
import { clearSectorAliases, sectorAliases, sectorStateWithoutAliases } from '../../modules/taxonomy/curation/curation.clear-sector-aliases.js';
import { assertCuratorSession, requireOpenDraft, withCuratorTransaction } from '../../modules/taxonomy/curation/curation.draft.js';
import { findLatestPublishedRelease, loadReleaseView, pgRunner, type ReleaseView } from '../../modules/taxonomy/curation/curation.read.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

const arg = (name: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = arg('mode') ?? 'preflight';
if (!['preflight', 'dry-run', 'apply', 'verify'].includes(mode) || (mode === 'apply' && !process.argv.includes('--confirm'))) throw new Error('Valid mode and --confirm for apply required');
const expectedDraft = arg('expected-draft') ?? 'v1.3.0';
const url = resolveCuratorDatabaseUrl({ DATABASE_URL: process.env.DATABASE_URL ?? '', DB_CURATOR_RUNTIME_PASSWORD: process.env.DB_CURATOR_RUNTIME_PASSWORD });
if (!url) throw new Error('Curator connection is required');
const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15000, options: '-c lock_timeout=15000' });
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const otherDimensions = (view: ReleaseView) => ({
  dimensions: view.dimensions.filter(d => d.code !== 'sector'),
  concepts: view.concepts.filter(c => c.dimensionCode !== 'sector'),
  groups: view.groups.filter(g => g.dimensionCode !== 'sector'),
});
async function readState(client: PoolClient) {
  const draft = await requireOpenDraft(client);
  if (draft.version !== expectedDraft) throw new Error('Unexpected draft version');
  const runner = pgRunner(client);
  const view = await loadReleaseView(runner, draft.id, { includeRetired: true });
  if (!view?.dimensions.some(d => d.code === 'sector')) throw new Error('Segmento missing');
  const published = await findLatestPublishedRelease(runner);
  if (!published) throw new Error('Published release missing');
  const publishedView = await loadReleaseView(runner, published.id, { includeRetired: true });
  const settings = await client.query('SELECT * FROM taxonomy_runtime_settings ORDER BY key');
  return { view, published: hash(publishedView), otherDimensions: hash(otherDimensions(view)), settings: hash(settings.rows), sector: hash(sectorStateWithoutAliases(view)) };
}
async function readOnly<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await assertCuratorSession(client);
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    return await fn(client);
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
class DryRunRollback extends Error {}
let report: Record<string, unknown> = { mode, saved: false };
try {
  const before = await readOnly(readState);
  report = { ...report, draft: before.view.release.version, draftId: before.view.release.id,
    sectorItems: before.view.concepts.filter(c => c.dimensionCode === 'sector').length, synonymsBefore: sectorAliases(before.view) };
  if (mode === 'verify') {
    if (sectorAliases(before.view)) throw new Error('Sector still has synonyms');
    report.verified = true;
    report.synonymsAfter = 0;
  } else if (mode !== 'preflight') {
    try {
      await withCuratorTransaction(pool, async client => {
        const live = await readState(client);
        if (hash(live.view) !== hash(before.view)) throw new Error('DRAFT changed after preflight');
        const result = await clearSectorAliases(client, {
          userId: 'ops:clear-sector-synonyms-issue-71',
          justification: 'Pedido explícito do Product Owner: retirar todos os sinônimos da tabela Segmento; issue 71.',
        }, live.view);
        const after = await readState(client);
        if (after.published !== before.published || after.otherDimensions !== before.otherDimensions ||
          after.settings !== before.settings || after.sector !== before.sector || sectorAliases(after.view)) throw new Error('Read-back mismatch');
        report = { ...report, ...result, synonymsAfter: 0, verified: true, sectorPreserved: true,
          publishedUnchanged: true, otherDimensionsUnchanged: true, settingsUnchanged: true };
        if (mode === 'dry-run') throw new DryRunRollback();
      });
    } catch (error) { if (!(error instanceof DryRunRollback)) throw error; }
    const persisted = await readOnly(readState);
    if (mode === 'dry-run') {
      if (hash(persisted.view) !== hash(before.view)) throw new Error('Rollback mismatch');
      report.rollbackVerified = true;
      report.recoveryAuditId = null;
    } else {
      if (sectorAliases(persisted.view) || persisted.sector !== before.sector || persisted.published !== before.published ||
        persisted.otherDimensions !== before.otherDimensions || persisted.settings !== before.settings) throw new Error('Post-COMMIT mismatch');
      report.saved = true;
    }
  }
  console.log('CLEAR_SYNONYMS_REPORT=' + JSON.stringify(report));
} catch (error) {
  console.error('CLEAR_SYNONYMS_FAILED=' + (error instanceof Error ? error.message : 'unknown'));
  process.exitCode = 1;
} finally { await pool.end(); }
