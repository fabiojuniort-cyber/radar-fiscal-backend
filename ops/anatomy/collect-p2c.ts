/**
 * E9 / P2-c — finite collection of RFB act types still absent from the coverage grid (authorized by COORD,
 * tribusca-control#116 c.6701950134): Portaria, ADI, ADE, Solução de Consulta and Resolução.
 * Limits (hard, enforced by a request counter): up to 5 requests per type — search, capture, redirect and retry all
 * count — and 25 in the whole package; at most 1 act per available size (pequeno/médio/grande), 15 acts overall.
 * Reserved acts (corpus/gold/reserve) are checked BEFORE any capture; acts of 2026 are skipped as an extra margin.
 * Captures go through consultOfficial (official hosts, validated redirects, RFB JSON validated). A failure or a size
 * not found is recorded, never read as "does not exist". Nothing is promoted; no production write.
 *   NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=… npx tsx ops/anatomy/collect-p2c.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';
import { prepareRfbRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { consultOfficial, type FetchLike, type ManifestAct } from './fetch-official-core.js';
import { sizeOf, type Size } from './official-coverage-matrix.js';

export const P2C_DIR = fileURLToPath(new URL('./official-identification/rfb-p2c/', import.meta.url));
const SEARCH = 'https://normas.receita.fazenda.gov.br/api/indexacao/ato/pesquisar';
export const P2C_TYPES = [
  { type: 'Portaria', termo: 'Portaria RFB', key: 'portaria' },
  { type: 'Ato Declaratório Interpretativo', termo: 'Ato Declaratório Interpretativo', key: 'adi' },
  { type: 'Ato Declaratório Executivo', termo: 'Ato Declaratório Executivo', key: 'ade' },
  { type: 'Solução de Consulta', termo: 'Solução de Consulta Cosit', key: 'sc' },
  { type: 'Resolução', termo: 'Resolução CGSN', key: 'resolucao' },
] as const;
export const LIMITS = Object.freeze({ perType: 5, total: 25, perSize: 1, acts: 15 });

interface Act { idAto: number; numeroAto: string; anoAto: string; tipoAto: { nomeTipoAto: string }; ementa: string | null; internet: string }
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
export const reservedKey = (key: string, a: Pick<Act, 'numeroAto' | 'anoAto'>) => `${key} ${Number(a.numeroAto.replace(/\D/gu, ''))}/${a.anoAto.slice(2)}`;
export const isReserved = (key: string, a: Pick<Act, 'idAto' | 'numeroAto' | 'anoAto'>) =>
  (RESERVED_ACT_KEYS as readonly string[]).includes(reservedKey(key, a)) || (RESERVED_SOURCE_IDS as readonly string[]).includes(String(a.idAto)) || a.anoAto === '2026';

/**
 * Prevention after the 28/25 overrun (#303 c.6702168770): the combined ledger is the ONLY source of the balance. A run
 * needs a prior reservation recorded in it (quantity, purpose, owner) that fits the balance; otherwise nothing is sent.
 */
export const LEDGER_FILE = 'ledger-combined.json';
export class BudgetRefused extends Error {}
export function assertReservation(dir = P2C_DIR, requested = LIMITS.total): void {
  let ledger: { available?: number; status?: string; reservation?: { quantity: number; owner: string; purpose: string } };
  try { ledger = JSON.parse(readFileSync(join(dir, LEDGER_FILE), 'utf8')); } catch { return; }
  if ((ledger.available ?? 0) <= 0 || /SUSPENS/u.test(ledger.status ?? '')) throw new BudgetRefused(`P2-c refused: combined balance ${ledger.available ?? 0}, status ${ledger.status ?? '?'}`);
  if (!ledger.reservation || ledger.reservation.quantity > (ledger.available ?? 0) || ledger.reservation.quantity < Math.min(requested, 1))
    throw new BudgetRefused('P2-c refused: no prior reservation that fits the combined balance');
}
type Log = { n: number; type: string; kind: 'search' | 'capture'; url: string; status: number | string; at: string; round?: number };
/** Round 2 re-uses the counters of round 1 (read from the inventory): limits are per type and per package, not per run. */
export async function run(doFetch: typeof fetch = fetch, opts: { round?: number; only?: string[]; termo?: Record<string, string>; prior?: { requests: Log[]; decisions: Record<string, unknown>[]; actsKept: number } } = {}) {
  assertReservation();
  mkdirSync(P2C_DIR, { recursive: true });
  const log: Log[] = [...(opts.prior?.requests ?? [])];
  const decisions: Record<string, unknown>[] = [...(opts.prior?.decisions ?? [])]; let total = log.length; let acts = opts.prior?.actsKept ?? 0;
  for (const t0 of P2C_TYPES) {
    if (opts.only && !opts.only.includes(t0.key)) continue;
    const t = { ...t0, termo: opts.termo?.[t0.key] ?? t0.termo };
    let used = log.filter((x) => x.type === t.type).length;
    const budget = () => used < LIMITS.perType && total < LIMITS.total;
    const counted: FetchLike = async (url, init) => {
      if (!budget()) throw new Error('request budget exhausted');
      used++; total++;
      const r = await doFetch(url, init as RequestInit);
      log.push({ n: total, type: t.type, kind: 'capture', url, status: r.status, at: new Date().toISOString(), round: opts.round ?? 1 });
      return r as unknown as Awaited<ReturnType<FetchLike>>;
    };
    if (!budget()) { decisions.push({ type: t.type, outcome: 'not attempted: package budget exhausted' }); continue; }
    used++; total++;
    let found: Act[] = [];
    try {
      const res = await doFetch(SEARCH, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TriBusca-ANAT-OFFICIAL-01 (consulta pontual)' },
        body: JSON.stringify({ termo: t.termo, refino: {}, paginacaoPaginaAtual: 1, paginacaoQuantidadePorPagina: 50, internet: true }), signal: AbortSignal.timeout(30_000) });
      log.push({ n: total, type: t.type, kind: 'search', url: SEARCH, status: res.status, at: new Date().toISOString(), round: opts.round ?? 1 });
      const body = Buffer.from(await res.arrayBuffer());
      writeFileSync(join(P2C_DIR, `search-${t.key}${opts.round && opts.round > 1 ? `-r${opts.round}` : ''}.json`), body);
      if (res.status !== 200) { decisions.push({ type: t.type, outcome: `search HTTP ${res.status}` }); continue; }
      found = (JSON.parse(body.toString('utf8')) as { atos: Act[] }).atos.filter((a) => norm(a.tipoAto.nomeTipoAto) === norm(t.type) && a.internet === '1');
    } catch (e) { log.push({ n: total, type: t.type, kind: 'search', url: SEARCH, status: `network: ${(e as Error).message}`, at: new Date().toISOString(), round: opts.round ?? 1 });
      decisions.push({ type: t.type, outcome: 'search failed (network); not read as absence' }); continue; }
    const eligible = found.filter((a) => !isReserved(t.key, a));
    // Size is only known after capture: try the longest, the median and the shortest ementa, then (one spare request)
    // the next candidate aimed at a size still missing.
    const byLen = [...eligible].sort((a, b) => (b.ementa?.length ?? 0) - (a.ementa?.length ?? 0));
    const order = [byLen[0], byLen[Math.floor(byLen.length / 2)], byLen[byLen.length - 1], byLen[1], byLen[byLen.length - 2]].filter((x, i, arr): x is Act => !!x && arr.findIndex((y) => y?.idAto === x.idAto) === i);
    const kept = new Map<Size, number>(); const tried: Record<string, unknown>[] = [];
    for (const a of order) {
      if (!budget() || acts >= LIMITS.acts || kept.size === 3) break;
      const m: ManifestAct = { id: String(a.idAto), source: 'RFB', act: `${t.type} ${a.numeroAto}/${a.anoAto}`, url: `https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/${a.idAto}/visao/multivigente`,
        urlStatus: 'candidate', reason: `E9 P2-c (${t.type})` };
      const r = await consultOfficial(m, OFFICIAL_HOSTS.RFB, counted).catch((e: Error) => ({ ok: false as const, failure: { code: 'budget', detail: e.message } }));
      if (!r.ok) { tried.push({ idAto: a.idAto, outcome: `failed: ${r.failure.code} ${'detail' in r.failure ? r.failure.detail : ''}` }); continue; }
      let chars: number;
      try {
        const p = prepareRfbRepresentation({ resourceId: `rfb:${a.idAto}`, bytes: new Uint8Array(r.body) }, a.idAto);
        chars = analyzeAnatomy({ publicationVersionId: `rfb:${a.idAto}`, referenceDate: '2026-11-07', ruleSet: { id: 'p2c', version: '1' },
          input: { source: 'RFB', representationId: `rfb:${a.idAto}`, html: p.html }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;
      } catch (e) { tried.push({ idAto: a.idAto, outcome: `captured but not preparable/readable: ${(e as Error).message.slice(0, 160)} (bytes not stored)` }); continue; }
      const size = sizeOf(chars);
      if (kept.has(size)) { tried.push({ idAto: a.idAto, chars, size, outcome: `captured but discarded: size ${size} already kept (bytes not stored)` }); continue; }
      writeFileSync(join(P2C_DIR, `${a.idAto}.json`), r.body);
      writeFileSync(join(P2C_DIR, `${a.idAto}.meta.json`), `${JSON.stringify({ ...r.meta, origin: 'automated fetch via consultOfficial (E9 P2-c)', promoted: false,
        p2c: { type: t.type, termo: t.termo, round: opts.round ?? 1, searchFile: `search-${t.key}${opts.round && opts.round > 1 ? `-r${opts.round}` : ''}.json`, measuredChars: chars, size } }, null, 2)}\n`);
      kept.set(size, a.idAto); acts++; tried.push({ idAto: a.idAto, chars, size, outcome: 'kept' });
    }
    decisions.push({ type: t.type, round: opts.round ?? 1, termo: t.termo, requestsUsedTotalForType: used, searchResultsOfType: found.length, eligibleAfterReservedCheck: eligible.length, tried,
      kept: Object.fromEntries(kept), sizesNotFound: (['pequeno', 'médio', 'grande'] as const).filter((s) => !kept.has(s)) });
  }
  const inventory = { authorization: 'tribusca-control#116 c.6701950134 (P2-c)', limits: LIMITS, requestsTotal: total, actsKept: acts, requests: log, decisions,
    note: 'a size not found within the budget is recorded as not found — never as nonexistent' };
  writeFileSync(join(P2C_DIR, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const round2 = process.argv.includes('--round2');
  const prior = round2 ? JSON.parse(readFileSync(join(P2C_DIR, 'inventory.json'), 'utf8')) : undefined;
  const inv = await run(fetch, round2 ? { round: 2, only: ['ade', 'sc'], termo: { ade: 'Ato Declaratório Executivo 2022', sc: 'Solução de Consulta Cosit 2022' }, prior } : {});
  for (const d of inv.decisions) console.log(JSON.stringify(d));
  console.log(`requests ${inv.requestsTotal}/${LIMITS.total}; acts kept ${inv.actsKept}/${LIMITS.acts}`);
}
