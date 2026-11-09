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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { BudgetRefused, RequestBudget } from './request-budget.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';
import { prepareRfbRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { consultOfficial, validateRfbJson, type FetchLike, type ManifestAct } from './fetch-official-core.js';
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
/** Grant E9-P2c-G1 caps (#116 c.6708512598 §3): the run plans exactly these per type; nothing is transferred between types. */
export const G1_PLAN: Record<string, number> = { resolucao: 3, portaria: 3, adi: 2, ade: 4, sc: 4 };
/** Option (b) for ADE/SC: year filter before 2026. The API's filter format is not documented: the response is checked,
 * and if any 2026 act still comes back the filter is treated as NOT applied and the type stops (no extra attempt). */
export const YEAR_FILTER: Record<string, { refino: Record<string, string[]> }> = {
  ade: { refino: { anoAtoFacet: ['2025', '2024', '2023', '2022', '2021'] } }, sc: { refino: { anoAtoFacet: ['2025', '2024', '2023', '2022', '2021'] } } };

interface Act { idAto: number; numeroAto: string; anoAto: string; tipoAto: { nomeTipoAto: string }; ementa: string | null; internet: string }
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
export const reservedKey = (key: string, a: Pick<Act, 'numeroAto' | 'anoAto'>) => `${key} ${Number(a.numeroAto.replace(/\D/gu, ''))}/${a.anoAto.slice(2)}`;
export const isReserved = (key: string, a: Pick<Act, 'idAto' | 'numeroAto' | 'anoAto'>) =>
  (RESERVED_ACT_KEYS as readonly string[]).includes(reservedKey(key, a)) || (RESERVED_SOURCE_IDS as readonly string[]).includes(String(a.idAto)) || a.anoAto === '2026';

/**
 * R2 of #303 (c.6708499687): budget control moved to request-budget.ts — FAIL CLOSED, exact grant (id, owner, package,
 * caps, expiry), debit persisted BEFORE every send (search, capture and each redirect hop), outcome settled after,
 * local lease against concurrent/re-entrant runs. The historical 28/25 ledger (ledger-combined.json) and the first
 * inventory (inventory.json) are records only: they are never read as a budget and never overwritten.
 */
export const BUDGET_FILE = join(P2C_DIR, 'budget-state.json');
export const P2C_PACKAGE = 'E9-P2-c';
type Log = { n: number; type: string; kind: 'search' | 'capture'; url: string; outcome: string; at: string };

export async function run(doFetch: typeof fetch, opts: { grantId: string; owner: string; budgetFile?: string; outDir?: string; only?: string[];
  termo?: Record<string, string>; plan?: Record<string, number>; now?: () => Date }) {
  const types = P2C_TYPES.filter((t) => !opts.only || opts.only.includes(t.key));
  const perType = Object.fromEntries(types.map((t) => [t.type, opts.plan?.[t.key] ?? G1_PLAN[t.key] ?? LIMITS.perType]));
  const budget = RequestBudget.open(opts.budgetFile ?? BUDGET_FILE, { grantId: opts.grantId, owner: opts.owner, package: P2C_PACKAGE,
    requested: { total: Object.values(perType).reduce((a, b) => a + b, 0), perType } }, opts.now);
  const outDir = opts.outDir ?? P2C_DIR;
  const log: Log[] = []; const decisions: Record<string, unknown>[] = []; let acts = 0;
  try {
    mkdirSync(outDir, { recursive: true });
    // R4 (found before any request, #303): acts already stored in this folder (earlier sessions) are never captured
    // again — that would spend a request and then fail the exclusive write. Checked offline, before any send.
    const stored = new Set(readdirSync(outDir).filter((f) => /^\d+\.json$/u.test(f)).map((f) => Number(f.slice(0, -5))));
    for (const t0 of types) {
      const t = { ...t0, termo: opts.termo?.[t0.key] ?? t0.termo };
      const searchFetch = budget.fetcher(t.type, 'search', doFetch);
      const captureFetch = budget.fetcher(t.type, 'capture', doFetch) as unknown as FetchLike;
      let found: Act[] = [];
      try {
        const res = await searchFetch(SEARCH, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TriBusca-ANAT-OFFICIAL-01 (consulta pontual)' },
          body: JSON.stringify({ termo: t.termo, refino: YEAR_FILTER[t.key]?.refino ?? {}, paginacaoPaginaAtual: 1, paginacaoQuantidadePorPagina: 50, internet: true }), signal: AbortSignal.timeout(30_000) });
        log.push({ n: log.length + 1, type: t.type, kind: 'search', url: SEARCH, outcome: `HTTP ${res.status}`, at: new Date().toISOString() });
        if (res.status !== 200) { decisions.push({ type: t.type, outcome: `search HTTP ${res.status} (redirects are never followed)` }); continue; }
        const body = Buffer.from(await res.arrayBuffer());
        writeFileSync(join(outDir, `search-${t.key}-${opts.grantId}.json`), body, { flag: 'wx' });
        const all = (JSON.parse(body.toString('utf8')) as { atos: Act[] }).atos;
        if (YEAR_FILTER[t.key] && all.some((a) => a.anoAto === '2026')) { decisions.push({ type: t.type, outcome: 'year filter NOT applied by the API (2026 acts returned): type stopped, no extra attempt' }); continue; }
        found = all.filter((a) => norm(a.tipoAto.nomeTipoAto) === norm(t.type) && a.internet === '1');
      } catch (e) {
        decisions.push({ type: t.type, outcome: e instanceof BudgetRefused ? `budget: ${e.message}` : `search failed: ${(e as Error).message} — debited, not read as absence` });
        if (e instanceof BudgetRefused && budget.remaining() === 0) break; continue;
      }
      const alreadyStored = found.filter((a) => stored.has(a.idAto)).map((a) => a.idAto);
      const eligible = found.filter((a) => !isReserved(t.key, a) && !stored.has(a.idAto));
      const byLen = [...eligible].sort((a, b) => (b.ementa?.length ?? 0) - (a.ementa?.length ?? 0));
      const order = [byLen[0], byLen[Math.floor(byLen.length / 2)], byLen[byLen.length - 1], byLen[1], byLen[byLen.length - 2]].filter((x, i, arr): x is Act => !!x && arr.findIndex((y) => y?.idAto === x.idAto) === i);
      const kept = new Map<Size, number>(); const tried: Record<string, unknown>[] = [];
      for (const a of order) {
        if (budget.remaining(t.type) === 0 || budget.remaining() === 0 || acts >= LIMITS.acts || kept.size === 3) break;
        const m: ManifestAct = { id: String(a.idAto), source: 'RFB', act: `${t.type} ${a.numeroAto}/${a.anoAto}`, url: `https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/${a.idAto}/visao/multivigente`,
          urlStatus: 'candidate', reason: `E9 P2-c (${t.type}, grant ${opts.grantId})` };
        const r = await consultOfficial(m, OFFICIAL_HOSTS.RFB, captureFetch).catch((e: Error) => ({ ok: false as const, failure: { code: e instanceof BudgetRefused ? 'budget' : 'error', detail: e.message } }));
        if (!r.ok) { tried.push({ idAto: a.idAto, outcome: `failed: ${r.failure.code} ${'detail' in r.failure ? r.failure.detail : ''}` }); continue; }
        let chars: number;
        try {
          const p = prepareRfbRepresentation({ resourceId: `rfb:${a.idAto}`, bytes: new Uint8Array(r.body) }, a.idAto);
          chars = analyzeAnatomy({ publicationVersionId: `rfb:${a.idAto}`, referenceDate: '2026-11-07', ruleSet: { id: 'p2c', version: '1' },
            input: { source: 'RFB', representationId: `rfb:${a.idAto}`, html: p.html }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;
        } catch (e) { tried.push({ idAto: a.idAto, outcome: `captured but not preparable/readable: ${(e as Error).message.slice(0, 160)} (bytes not stored)` }); continue; }
        const size = sizeOf(chars);
        if (kept.has(size)) { tried.push({ idAto: a.idAto, chars, size, outcome: `captured but discarded: size ${size} already kept (bytes not stored)` }); continue; }
        if (existsSync(join(outDir, `${a.idAto}.json`))) { tried.push({ idAto: a.idAto, outcome: 'captured but already stored (bytes not overwritten)' }); continue; }
        writeFileSync(join(outDir, `${a.idAto}.json`), r.body, { flag: 'wx' });
        writeFileSync(join(outDir, `${a.idAto}.meta.json`), `${JSON.stringify({ ...r.meta, origin: `automated fetch via consultOfficial (E9 P2-c, grant ${opts.grantId})`, promoted: false,
          p2c: { type: t.type, termo: t.termo, grantId: opts.grantId, measuredChars: chars, size } }, null, 2)}\n`, { flag: 'wx' });
        kept.set(size, a.idAto); acts++; tried.push({ idAto: a.idAto, chars, size, outcome: 'kept' });
      }
      decisions.push({ type: t.type, termo: t.termo, remainingForType: budget.remaining(t.type), searchResultsOfType: found.length, alreadyStored, eligibleAfterReservedCheck: eligible.length,
        tried, kept: Object.fromEntries(kept), sizesNotFound: (['pequeno', 'médio', 'grande'] as const).filter((s) => !kept.has(s)) });
    }
  } finally { budget.close(); }
  const inventory = { grantId: opts.grantId, owner: opts.owner, remainingTotal: budget.remaining(), actsKept: acts, decisions, requests: log,
    note: 'the per-attempt debit record (sent/settled, outcome) is the budget state file; a size not found is never read as nonexistent' };
  writeFileSync(join(outDir, `inventory-${opts.grantId}.json`), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

/**
 * E9-ACERVO-01 R3 (tribusca-control#116, decisions D1–D3): DIRECT capture by idAto — no search. Targets come from the
 * offline plan (ops/anatomy/e9-acervo/plan-rfb-captures.mts over the read-only Acervo SQL) and are DATA, re-validated
 * here before any request:
 * - idAto: canonical positive integer (digits, no sign/leading zero, ≤ 10 digits); the URL is BUILT from it, never taken
 *   from the plan. type: one of P2C_TYPES. numeroAto: digits. anoAto: a year strictly before 2026.
 * - Skipped BEFORE any request: an idAto already stored in any RFB lot folder, a reserved act (key, source id, 2026
 *   margin), a duplicate target, a target beyond its type cap.
 * - After the capture (debited, like every hop): the RFB JSON must carry the requested idAto (consultOfficial), and the
 *   returned type, number and act date must match the target, with the act date before 2026. Any divergence ⇒ refused,
 *   bytes NOT stored.
 * - D3: the size is the one MEASURED on the multivigente vision (engine canonical text); the Acervo size only ordered
 *   the selection. One act kept per measured size per type; a capture whose size is already kept is discarded.
 */
export interface DirectTarget { type: string; idAto: string; numeroAto: string; anoAto: string; acervoSize?: string }
export const RFB_LOT_DIRS = ['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c']
  .map((d) => fileURLToPath(new URL(`./official-identification/${d}/`, import.meta.url)));
export const multivigenteUrl = (idAto: number) => `https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/${idAto}/visao/multivigente`;
export function directTargetProblem(t: DirectTarget): string | null {
  if (!P2C_TYPES.some((x) => x.type === t.type)) return `type "${t.type}" is not a P2-c type`;
  if (typeof t.idAto !== 'string' || !/^[1-9]\d{0,9}$/u.test(t.idAto)) return `idAto "${String(t.idAto)}" is not a canonical positive integer`;
  if (typeof t.numeroAto !== 'string' || !/^\d{1,9}$/u.test(t.numeroAto)) return `numeroAto "${String(t.numeroAto)}" is not digits`;
  if (typeof t.anoAto !== 'string' || !/^\d{4}$/u.test(t.anoAto) || t.anoAto >= '2026') return `anoAto "${String(t.anoAto)}" is not a year before 2026`;
  return null;
}
export async function runDirect(doFetch: typeof fetch, opts: { grantId: string; owner: string; targets: DirectTarget[]; budgetFile?: string; outDir?: string;
  lotDirs?: string[]; plan?: Record<string, number>; now?: () => Date }) {
  const perType = Object.fromEntries(P2C_TYPES.map((t) => [t.type, opts.plan?.[t.key] ?? G1_PLAN[t.key]!]));
  const outDir = opts.outDir ?? P2C_DIR;
  const stored = new Set((opts.lotDirs ?? RFB_LOT_DIRS).filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => /^\d+\.json$/u.test(f)).map((f) => f.slice(0, -5))));
  // Offline screening: nothing below sends a request.
  const decisions: Record<string, unknown>[] = []; const queue: Array<DirectTarget & { key: string; id: number }> = []; const seen = new Set<string>();
  const planned: Record<string, number> = {};
  for (const t of opts.targets) {
    const problem = directTargetProblem(t);
    if (problem) { decisions.push({ target: t, outcome: `refused before request: ${problem}` }); continue; }
    const key = P2C_TYPES.find((x) => x.type === t.type)!.key; const id = Number(t.idAto);
    const why = seen.has(t.idAto) ? 'duplicate target' : stored.has(t.idAto) ? 'already stored (bytes kept by an earlier session)'
      : isReserved(key, { idAto: id, numeroAto: t.numeroAto, anoAto: t.anoAto }) ? `reserved (${reservedKey(key, { numeroAto: t.numeroAto, anoAto: t.anoAto })} / idAto / 2026)`
      : (planned[t.type] ?? 0) >= perType[t.type]! ? `beyond the ${t.type} cap of ${perType[t.type]}` : null;
    seen.add(t.idAto);
    if (why) { decisions.push({ target: t, outcome: `skipped before request: ${why}` }); continue; }
    planned[t.type] = (planned[t.type] ?? 0) + 1; queue.push({ ...t, key, id });
  }
  const requestedTotal = Object.values(planned).reduce((a, b) => a + b, 0);
  if (requestedTotal === 0) return { grantId: opts.grantId, owner: opts.owner, requests: 0, actsKept: 0, decisions, note: 'nothing to capture: no request sent, budget not opened' };
  const budget = RequestBudget.open(opts.budgetFile ?? BUDGET_FILE, { grantId: opts.grantId, owner: opts.owner, package: P2C_PACKAGE,
    requested: { total: requestedTotal, perType: planned } }, opts.now);
  const kept = new Map<string, Map<Size, number>>(); let acts = 0;
  try {
    mkdirSync(outDir, { recursive: true });
    for (const t of queue) {
      const capture = budget.fetcher(t.type, 'capture', doFetch) as unknown as FetchLike;
      const m: ManifestAct = { id: String(t.id), source: 'RFB', act: `${t.type} ${t.numeroAto}/${t.anoAto}`, url: multivigenteUrl(t.id), urlStatus: 'candidate',
        reason: `E9 P2-c direct (${t.type}, grant ${opts.grantId})` };
      const r = await consultOfficial(m, OFFICIAL_HOSTS.RFB, capture).catch((e: Error) => ({ ok: false as const, failure: { code: e instanceof BudgetRefused ? 'budget' : 'error', detail: e.message } }));
      if (!r.ok) { decisions.push({ target: t, outcome: `failed (debited): ${r.failure.code} ${'detail' in r.failure ? r.failure.detail : ''}` }); continue; }
      const v = validateRfbJson(r.body, t.id);
      if ('problem' in v) { decisions.push({ target: t, outcome: `refused after capture (debited, not stored): ${v.problem}` }); continue; }
      const root = JSON.parse(r.body.toString('utf8')) as { epigrafe?: { tipoAto?: { nomeTipoAto?: unknown } } };
      const gotType = typeof root.epigrafe?.tipoAto?.nomeTipoAto === 'string' ? root.epigrafe.tipoAto.nomeTipoAto : null;
      const gotNumber = v.identification.numeroAto?.replace(/\D/gu, '') ?? null; const gotDate = v.identification.dataAto;
      const divergence = [gotType === null || norm(gotType) !== norm(t.type) ? `type ${String(gotType)}` : null,
        gotNumber === null || Number(gotNumber) !== Number(t.numeroAto) ? `number ${String(v.identification.numeroAto)}` : null,
        !gotDate || !/^\d{4}-\d{2}-\d{2}$/u.test(gotDate) || gotDate.slice(0, 4) !== t.anoAto ? `act date ${String(gotDate)}` : null,
        gotDate && gotDate >= '2026-01-01' ? 'act dated 2026 or later' : null].filter(Boolean);
      if (divergence.length) { decisions.push({ target: t, outcome: `refused after capture (debited, not stored): identity diverges from the target — ${divergence.join('; ')}` }); continue; }
      let chars: number;
      try {
        const p = prepareRfbRepresentation({ resourceId: `rfb:${t.id}`, bytes: new Uint8Array(r.body) }, t.id);
        chars = analyzeAnatomy({ publicationVersionId: `rfb:${t.id}`, referenceDate: '2026-11-09', ruleSet: { id: 'p2c-direct', version: '1' },
          input: { source: 'RFB', representationId: `rfb:${t.id}`, html: p.html }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;
      } catch (e) { decisions.push({ target: t, outcome: `captured but not readable (debited, not stored): ${(e as Error).message.slice(0, 160)}` }); continue; }
      const size = sizeOf(chars); const byType = kept.get(t.type) ?? new Map<Size, number>(); kept.set(t.type, byType);
      if (byType.has(size)) { decisions.push({ target: t, chars, size, outcome: `captured but discarded: measured size ${size} already kept for ${t.type} (bytes not stored)` }); continue; }
      if (existsSync(join(outDir, `${t.id}.json`))) { decisions.push({ target: t, outcome: 'captured but already stored (bytes not overwritten)' }); continue; }
      writeFileSync(join(outDir, `${t.id}.json`), r.body, { flag: 'wx' });
      writeFileSync(join(outDir, `${t.id}.meta.json`), `${JSON.stringify({ ...r.meta, origin: `automated fetch via consultOfficial (E9 P2-c direct, grant ${opts.grantId})`, promoted: false,
        identification: v.identification, p2c: { type: t.type, mode: 'direct-by-idAto', grantId: opts.grantId, acervoSize: t.acervoSize ?? null, measuredChars: chars, size } }, null, 2)}\n`, { flag: 'wx' });
      byType.set(size, t.id); acts++;
      decisions.push({ target: t, chars, size, outcome: t.acervoSize && t.acervoSize.replace('medio', 'médio') !== size ? `kept for the MEASURED size ${size} (Acervo said ${t.acervoSize}; D3)` : 'kept' });
    }
  } finally { budget.close(); }
  const inventory = { grantId: opts.grantId, owner: opts.owner, mode: 'direct-by-idAto', searches: 0, remainingTotal: budget.remaining(), actsKept: acts, decisions,
    kept: Object.fromEntries([...kept].map(([k, v]) => [k, Object.fromEntries(v)])), note: 'per-attempt debit record = budget-state.json; a size not found is never read as nonexistent' };
  writeFileSync(join(outDir, `inventory-direct-${opts.grantId}.json`), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
  const grantId = arg('--grant'); const owner = arg('--owner');
  if (!grantId || !owner) { console.error('usage: collect-p2c.ts --grant <grantId> --owner <owner> [--targets <plan-targets.json>]  (refused without an active grant in budget-state.json)'); process.exit(2); }
  const targetsFile = arg('--targets');
  if (targetsFile) {
    const { readFileSync } = await import('node:fs');
    const inv = await runDirect(fetch, { grantId, owner, targets: JSON.parse(readFileSync(targetsFile, 'utf8')) as DirectTarget[] });
    for (const d of inv.decisions) console.log(JSON.stringify(d));
    console.log(`acts kept ${inv.actsKept}; searches 0`); process.exit(0);
  }
  const inv = await run(fetch, { grantId, owner });
  for (const d of inv.decisions) console.log(JSON.stringify(d));
  console.log(`acts kept ${inv.actsKept}; remaining ${inv.remainingTotal}`);
}
