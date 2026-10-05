import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { canonicalJson } from '../../modules/taxonomy/baseline/baseline.canonical-json.js';
import { assertCuratorSession, requireOpenDraft, withCuratorTransaction } from '../../modules/taxonomy/curation/curation.draft.js';
import { findLatestPublishedRelease, loadReleaseView, pgRunner, type ReleaseView } from '../../modules/taxonomy/curation/curation.read.js';
import { exactCnaes, loadSegmentPackage, verifySegmentPackage } from '../../modules/taxonomy/curation/curation.segment-load.js';
import { parseSegmentPackage } from '../../modules/taxonomy/curation/curation.segment-package.js';
import { resolveCuratorDatabaseUrl } from './curator-url.js';

const arg = (name: string) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode = arg('mode') ?? 'preflight';
if (!['preflight', 'dry-run', 'apply', 'verify'].includes(mode) || (mode === 'apply' && !process.argv.includes('--confirm'))) throw new Error('Valid mode and --confirm for apply required');
const raw = readFileSync(arg('file') ?? 'ops/taxonomy/loads/trifaros-cnae-2.3.json', 'utf8').replace(/\r\n/g, '\n');
const sha256 = createHash('sha256').update(raw).digest('hex');
if (sha256 !== 'c6d2b14bdd6e7f023ca56e6a67c3749434d357a68035b5bb4ae7f178da8b5298') throw new Error('Package hash mismatch');
const data = parseSegmentPackage(raw);
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
  if (!view) throw new Error('DRAFT missing');
  const published = await findLatestPublishedRelease(runner);
  if (!published) throw new Error('Published release missing');
  const publishedView = await loadReleaseView(runner, published.id, { includeRetired: true });
  const settings = await client.query('SELECT * FROM taxonomy_runtime_settings ORDER BY key');
  return { view, published: hash(publishedView), otherDimensions: hash(otherDimensions(view)), settings: hash(settings.rows) };
}

async function readOnly<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await assertCuratorSession(client);
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL ROLE radar_taxonomy_curator');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

class DryRunRollback extends Error {}
let report: Record<string, unknown> = { mode, saved: false, sha256 };
try {
  const before = await readOnly(readState);
  exactCnaes(before.view);
  report = { ...report, draft: before.view.release.version, draftId: before.view.release.id,
    sectorItemsBefore: before.view.concepts.filter(c => c.dimensionCode === 'sector').length };
  if (mode === 'verify') {
    verifySegmentPackage(before.view, data);
    report = { ...report, verified: true, cnaes: data.rows.length, segments: data.segments.length,
      subsegments: data.subsegments.length, synonyms: data.rows.reduce((n, row) => n + row.synonyms.length, 0) };
  } else if (mode !== 'preflight') {
    try {
      await withCuratorTransaction(pool, async client => {
        await client.query("SET LOCAL lock_timeout = '15s'");
        const live = await readState(client);
        if (hash(live.view) !== hash(before.view)) throw new Error('DRAFT changed after preflight');
        const summary = await loadSegmentPackage(client, {
          userId: 'ops:segments-cnae-issue-70',
          justification: 'Carga autorizada pelo Product Owner no Railway: planilha TriFaros, segmentos, subsegmentos, CNAEs e descritores IBGE; issue 70.',
        }, live.view, data);
        const after = await readState(client);
        if (after.published !== before.published || after.otherDimensions !== before.otherDimensions || after.settings !== before.settings) throw new Error('Unrelated data changed');
        const finalByCode = new Map(after.view.concepts.map(c => [c.code, c]));
        for (const legacy of before.view.concepts.filter(c => c.dimensionCode === 'sector' && !c.officialCodes.some(v => /^\d{7}$/.test(v)))) {
          if (hash(finalByCode.get(legacy.code)) !== hash(legacy)) throw new Error(`Legacy item changed: ${legacy.code}`);
        }
        report = { ...report, ...summary, verified: true, publishedUnchanged: true, otherDimensionsUnchanged: true, settingsUnchanged: true,
          sectorItemsAfter: after.view.concepts.filter(c => c.dimensionCode === 'sector').length };
        if (mode === 'dry-run') throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    const persisted = await readOnly(readState);
    if (mode === 'dry-run') {
      if (hash(persisted.view) !== hash(before.view)) throw new Error('Rollback mismatch');
      report.rollbackVerified = true;
    } else {
      verifySegmentPackage(persisted.view, data);
      report.saved = true;
    }
  }
  console.log('SEGMENT_LOAD_REPORT=' + JSON.stringify(report));
} catch (error) {
  // Never print pg error objects or connection strings.
  console.error('SEGMENT_LOAD_FAILED=' + (error instanceof Error ? error.message : 'unknown'));
  process.exitCode = 1;
} finally {
  await pool.end();
}
