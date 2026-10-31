/**
 * ANAT-OFFICIAL-01: consult the acts of ops/anatomy/official-manifest.json, one by one, through consultOfficial
 * (validated redirect chain, 2xx HTML/PDF only). Writes <out>/<id>.html|.pdf + <id>.meta.json for accepted answers
 * and appends refusals to <out>/failures.json (no body). Nothing is read from corpus inputs, gold or the reserve.
 *   npx tsx ops/anatomy/fetch-official.ts [--only <id>] [--out <dir>]
 * Exit code 0 when every act with a URL produced a snapshot, 2 otherwise.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';
import { consultOfficial, type FetchLike, type ManifestAct } from './fetch-official-core.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out') ?? 'ops/anatomy/official-snapshots';
const only = arg('--only');
const manifest = JSON.parse(await readFile(new URL('./official-manifest.json', import.meta.url), 'utf8')) as { acts: ManifestAct[] };
await mkdir(out, { recursive: true });
const failures: unknown[] = [];
for (const a of manifest.acts.filter((x) => !only || x.id === only)) {
  const r = await consultOfficial(a, OFFICIAL_HOSTS[a.source as keyof typeof OFFICIAL_HOSTS] ?? [], fetch as unknown as FetchLike);
  if (r.ok) {
    const ext = /pdf/iu.test(r.meta.contentType) ? 'pdf' : 'html';
    await writeFile(join(out, `${a.id}.${ext}`), r.body);
    await writeFile(join(out, `${a.id}.meta.json`), `${JSON.stringify(r.meta, null, 2)}\n`);
    console.log(`OK   ${a.id}: ${r.meta.status} ${r.meta.bytes} bytes sha256=${r.meta.sha256.slice(0, 12)}… (${r.meta.verified ? 'URL verificada' : 'URL candidata, não promovível'})`);
  } else { failures.push(r.failure); console.log(`FAIL ${a.id}: ${r.failure.code} — ${r.failure.detail}`); }
}
if (failures.length) await writeFile(join(out, 'failures.json'), `${JSON.stringify(failures, null, 2)}\n`);
process.exitCode = failures.length ? 2 : 0;
