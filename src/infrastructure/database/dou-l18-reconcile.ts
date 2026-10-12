import 'dotenv/config';

import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';

interface Original {
  date: string; section: string; title: string; actNumber: string; officialUrl: string;
}
interface Manifest {
  version: number; dates: string[]; sections: string[]; items: Original[];
}
interface Stored {
  publication_id: string; title: string; published_on: string;
  is_hidden: boolean; official_url: string | null;
}
function getArg(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
/** Compare publication titles even when diacritics/case/whitespace differ.
 * Never count ambiguous matches as restored: false positives are worse than missing ones.
 */
export function l18TitleKey(input: string): string {
  return input.replace(/[º°]/g, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function l18Reconcile(manifest: Manifest, items: Stored[]) {
  const candidates = new Map<string, Set<string>>();
  const titleById = new Map<string, Stored>();
  for (const item of items) {
    if (item.is_hidden) continue;
    const key = item.published_on.slice(0, 10) + '|' + l18TitleKey(item.title);
    const ids = candidates.get(key) ?? new Set<string>();
    ids.add(item.publication_id);
    candidates.set(key, ids);
    titleById.set(item.publication_id, item);
  }
  const matched = new Set<string>();
  const originals = manifest.items.map(row => {
    const key = row.date + '|' + l18TitleKey(row.title);
    const ids = [...(candidates.get(key) ?? [])];
    const status = ids.length === 1 ? 'RECOVERED' : ids.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND';
    if (status === 'RECOVERED') matched.add(ids[0]!);
    return { date: row.date, section: row.section, title: row.title, officialUrl: row.officialUrl,
      status, ...(status === 'RECOVERED' ? { publicationId: ids[0]! } : {}) };
  });
  const recovered = originals.filter(x => x.status === 'RECOVERED').length;
  const ambiguous = originals.filter(x => x.status === 'AMBIGUOUS').length;
  const retainedIds = new Set(items.filter(x => !x.is_hidden).map(x => x.publication_id));
  return {
    expectedOriginals: manifest.items.length, recovered, ambiguous,
    missing: manifest.items.length - recovered - ambiguous,
    additionalRetained: [...retainedIds].filter(id => !matched.has(id)).length,
    originals,
  };
}
async function main() {
  const path = getArg('manifest') ?? 'ops/l18/recovery-manifest-81.json';
  const ids = (getArg('run-ids') ?? '').split(',').filter(Boolean);
  if (!ids.length || ids.some(x => !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x))) {
    throw new Error('Pass explicit --run-ids=<comma-separated valid UUIDs>; no default global reconciliation.');
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  const uniqueDates = new Set(manifest.items.map(x => x.date));
  if (manifest.version !== 1 || manifest.items.length !== 81 || uniqueDates.size !== 26
    || manifest.dates.length !== 26 || manifest.sections.join(',') !== 'DO1,DO1E,DO3') {
    throw new Error('Manifest does not match the approved 81 publications, 26 dates, 3 sections.');
  }
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required.');
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const sources = await pool.query<{ id: string; trigger_type: string; code: string }>(
      `SELECT cr.id, cr.trigger_type, s.code FROM collection_runs cr
        JOIN sources s ON s.id=cr.source_id WHERE cr.id=ANY($1::uuid[])`, [ids]);
    if (sources.rowCount !== new Set(ids).size ||
      sources.rows.some(r => r.code !== 'dou' || r.trigger_type !== 'BACKFILL')) {
      throw new Error('Every run id must identify a DOU BACKFILL run.');
    }
    const data = await pool.query<Stored>(
      `SELECT DISTINCT ci.publication_id, p.title,
        to_char(p.published_on, 'YYYY-MM-DD') AS published_on,
        p.is_hidden, po.official_url
      FROM collection_items ci
      JOIN publications p ON p.id=ci.publication_id
      JOIN publication_origins po ON po.publication_id=p.id
      JOIN sources s ON s.id=po.source_id AND s.code='dou'
      WHERE ci.collection_run_id=ANY($1::uuid[])
      AND ci.status IN ('PROCESSED_NEW','PROCESSED_EXISTING','NEW_VERSION')
      AND p.published_on IS NOT NULL`, [ids]);
    const filters = await pool.query<{ discard_count: number }>(
      `SELECT discard_count FROM collection_filter_discard_run_stats
       WHERE collection_run_id=ANY($1::uuid[])`, [ids]);
    const result = l18Reconcile(manifest, data.rows);
    const report = {
      ...result, runIds: ids,
      discardedByCollectionFilter: filters.rows.reduce((n, r) => n + r.discard_count, 0),
      runsMissingDiscardStats: ids.length - filters.rows.length,
      note: 'Counts only distinct accepted publications associated with the supplied replay runs. Connector-level ignored items are separate from collection filter discards.',
    };
    const out = getArg('out');
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log('DOU_L18_RECONCILIATION=' + JSON.stringify(report));
  } finally { await pool.end(); }
}
if (process.argv[1]?.endsWith('dou-l18-reconcile.js')) {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}
