/**
 * ANAT COLETA-02: finite collection of STATUS-MATRIX-02 §8 (authorized by COORD #293 c.6665613398 and by Fábio).
 * Each item goes through consultOfficial (official hosts only, validated redirects, RFB JSON validated by D03).
 * Writes <dir>/<id>.<ext> + <id>.meta.json with promoted:false. Never touches corpus, gold or the reserve.
 *   NODE_USE_ENV_PROXY=1 npx tsx ops/anatomy/collect-02.ts
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';
import { consultOfficial, type FetchLike, type ManifestAct } from './fetch-official-core.js';

const base = fileURLToPath(new URL('./official-identification/', import.meta.url));
const RFB = (id: number, act: string, reason: string) => ({ dir: 'rfb-normasinternet2-coleta02', source: 'RFB' as const, a: { id: String(id), source: 'RFB', act,
  url: `https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/${id}/visao/multivigente`, urlStatus: 'candidate' as const, reason } });
const SP = (page: string, act: string, reason: string) => ({ dir: 'doesp-ricms', source: 'DOE-SP' as const, a: { id: `ricms-${page}`, source: 'DOE-SP', act,
  url: `https://legislacao.fazenda.sp.gov.br/Paginas/${page}.aspx`, urlStatus: 'candidate' as const, reason } });
export const ITEMS = [
  RFB(104314, 'IN RFB 1.911/2019 (PIS/Cofins, consolidação anterior à 2.121)', 'COLETA-02 item 1 (L11): 2º ato com tipo parte declarado; item 3 (L13): JSON 2,29 MB'),
  RFB(116968, 'IN RFB 2.021/2021 (contribuições previdenciárias)', 'COLETA-02 item 2 (L20): 20 segmentos tipo 999 que começam com aspas'),
  SP('an1art041', 'RICMS/2000 (Decreto 45.490/2000), Anexo I, art. 41', 'COLETA-02 item 5 (L18): 25 p.revogado dentro de blockquote'),
  SP('an2art003', 'RICMS/2000 (Decreto 45.490/2000), Anexo II, art. 3º', 'COLETA-02 item 5 (L18): 7 p.revogado dentro de blockquote'),
  SP('art008', 'RICMS/2000 (Decreto 45.490/2000), art. 8º', 'COLETA-02 item 6 (L21/regressão L14–L17): artigo sem escolha dirigida'),
  SP('art009', 'RICMS/2000 (Decreto 45.490/2000), art. 9º', 'COLETA-02 item 6 (L21/regressão L14–L17): artigo sem escolha dirigida'),
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failures = 0; let captured = 0;
  for (const it of ITEMS) {
    const key = it.a.id.toLowerCase();
    if ((RESERVED_ACT_KEYS as readonly string[]).includes(key) || (RESERVED_SOURCE_IDS as readonly string[]).includes(key)) throw new Error(`${key} is reserved`);
    const r = await consultOfficial(it.a as ManifestAct, OFFICIAL_HOSTS[it.source], fetch as unknown as FetchLike);
    if (!r.ok) { failures++; console.log(`FAIL ${it.a.id}: ${r.failure.code} — ${r.failure.detail}`); continue; }
    const dir = join(base, it.dir); await mkdir(dir, { recursive: true });
    const ext = r.meta.representation === 'json' ? 'json' : 'html';
    await writeFile(join(dir, `${it.a.id}.${ext}`), r.body);
    await writeFile(join(dir, `${it.a.id}.meta.json`), `${JSON.stringify({ ...r.meta, origin: 'automated fetch via consultOfficial (COLETA-02)', promoted: false }, null, 2)}\n`);
    captured++;
    console.log(`OK   ${it.a.id}: ${r.meta.status} ${r.meta.bytes} bytes sha256=${r.meta.sha256.slice(0, 12)}…`);
  }
  // R1 (COORD #295): a run is complete only when EVERY target was captured; any failure makes the exit code non-zero.
  console.log(`captured ${captured}/${ITEMS.length}, failures ${failures}`);
  process.exitCode = failures === 0 && captured === ITEMS.length ? 0 : 2;
}
