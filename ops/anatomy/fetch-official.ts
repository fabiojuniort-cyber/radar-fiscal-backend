/**
 * ANAT-OFFICIAL-01: consult the official acts of ops/anatomy/official-manifest.json, one by one, and keep an exact
 * snapshot of each page with its provenance. Only the official hosts of OFFICIAL_HOSTS are contacted; nothing is read
 * from the corpus, gold files or the reserve. A blocked host is reported as such and nothing is invented in its place.
 *
 *   npx tsx ops/anatomy/fetch-official.ts [--only <id>] [--out <dir>]
 *
 * Output per act: <out>/<id>.html (bytes as served) and <out>/<id>.meta.json (url, final url, HTTP status, content type,
 * SHA-256, consultedAt). Exit code 0 when every act with a URL was fetched, 2 when any host was unreachable.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';

interface Act { id: string; source: keyof typeof OFFICIAL_HOSTS; act: string; host: string; url: string | null; urlStatus: string; reason: string }

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out') ?? 'ops/anatomy/official-snapshots';
const only = arg('--only');

const manifest = JSON.parse(await readFile(new URL('./official-manifest.json', import.meta.url), 'utf8')) as { acts: Act[] };
await mkdir(out, { recursive: true });
let blocked = 0;
for (const a of manifest.acts.filter((x) => !only || x.id === only)) {
  if (!a.url) { console.log(`SKIP ${a.id}: URL ainda não localizada (${a.urlStatus}).`); continue; }
  const url = new URL(a.url);
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS[a.source].includes(url.hostname)) throw new Error(`${a.id}: host fora da lista oficial (${url.hostname})`);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'TriBusca-ANAT-OFFICIAL-01 (consulta pontual)' } });
    const finalUrl = new URL(res.url);
    if (!OFFICIAL_HOSTS[a.source].includes(finalUrl.hostname)) throw new Error(`redirecionou para fora da fonte oficial (${finalUrl.hostname})`);
    const body = Buffer.from(await res.arrayBuffer());
    const meta = { id: a.id, act: a.act, url: a.url, finalUrl: res.url, status: res.status, contentType: res.headers.get('content-type'),
      lastModified: res.headers.get('last-modified'), sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length,
      consultedAt: new Date().toISOString(), reason: a.reason };
    await writeFile(join(out, `${a.id}.html`), body);
    await writeFile(join(out, `${a.id}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`${res.ok ? 'OK  ' : 'HTTP'} ${a.id}: ${res.status} ${meta.bytes} bytes sha256=${meta.sha256.slice(0, 12)}…`);
    if (!res.ok) blocked++;
  } catch (e) {
    blocked++;
    console.log(`BLOCKED ${a.id} (${url.hostname}): ${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}`);
  }
}
process.exitCode = blocked ? 2 : 0;
