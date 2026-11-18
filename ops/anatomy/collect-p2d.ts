/**
 * E9 / P2-d — finite collection of DOE-SP acts (Decreto, Resolução, Portaria CAT) through the approved API gate
 * (#304 c.6710099357) and the approved budget barrier (#303 c.6710098997). OFFLINE-REVIEWED CODE: it runs only with an
 * ACTIVE grant in doesp-p2d/budget-state.json, which stays SUSPENDED until the COORD decides the grant layout and
 * rechecks this collector (material delta).
 *
 * - DISCOVERY is not an act capture: journals, sections and the day list (`v2/summary/list`) go through
 *   discoverOfficial — exact API host, listing endpoints only, JSON only, no redirect followed — and EVERY discovery
 *   request is debited before it is sent. Layout decided by the COORD (#116 c.6710109715 §3): 5 per type
 *   (Decreto/Resolução/Portaria CAT) = 15, so discovery has no bucket of its own: it is debited, with kind
 *   'discovery', against ONE declared type (`discoveryType`, default Decreto), which then has fewer captures left.
 * - CAPTURE goes through consultOfficial with apiSources ['DOE-SP']: publication by id only, identity pinned across
 *   redirects, publication JSON validated against the URL id. Every hop is debited.
 * - Before any capture: reserved acts (corpus/gold/reserve, by act key and by publication id), acts not dated before 2026
 *   (real-date check on the listing AND on the returned act; 2026, 2027+, invalid or missing dates are refused)
 *   and acts already stored are skipped. At most 1 act per size per type, at most 9 acts. A size not found, a failure
 *   or a type absent from the day list is recorded, never read as "does not exist". Nothing promoted; no production write.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialApiEndpoint, OFFICIAL_HOSTS } from '../../src/modules/anatomy/config/official-provenance.js';
import { RESERVED_ACT_KEYS, RESERVED_SOURCE_IDS } from '../../src/modules/anatomy/config/reserved-act-keys.js';
import { prepareDoeSpRepresentation } from '../../src/modules/anatomy/json-preparation.js';
import { analyzeAnatomy } from '../../src/modules/anatomy/engine.js';
import { findDoeSpNamed, parseDoeSpList, parseDoeSpNamedItems, type DoeSpListItem } from '../../src/modules/collection/doe-sp.parser.js';
import { BudgetRefused, RequestBudget } from './request-budget.js';
import { consultOfficial, type FetchLike, type ManifestAct } from './fetch-official-core.js';
import { sizeOf, type Size } from './official-coverage-matrix.js';

export const P2D_DIR = fileURLToPath(new URL('./official-identification/doesp-p2d/', import.meta.url));
export const P2D_BUDGET_FILE = join(P2D_DIR, 'budget-state.json');
export const P2D_PACKAGE = 'E9-P2-d';
/** Attempt kind recorded for discovery debits (listing ≠ capture). */
export const DISCOVERY = 'discovery';
const API = 'https://do-api-web-search.doe.sp.gov.br/';
/** Same catalogue names as the versioned connector (doe-sp.connector.ts DOE_SP_JOURNAL / DOE_SP_SECTION; checked in test). */
export const JOURNAL = 'Executivo'; export const SECTION = 'Atos Normativos';
export const P2D_TYPES = [
  { type: 'Decreto', key: 'decreto', title: /^DECRETO\s+N[º°o.]*\s*([\d.]+)/iu },
  { type: 'Resolução', key: 'resolucao', title: /^RESOLU[ÇC][ÃA]O\s+(?:[A-Z]+\s+)*N[º°o.]*\s*([\d.]+)/iu },
  { type: 'Portaria CAT', key: 'portaria', title: /^PORTARIA\s+CAT\s+N[º°o.]*\s*([\d.]+)/iu },
] as const;
export const P2D_LIMITS = Object.freeze({ acts: 9, perSize: 1 });

export class DiscoveryRefused extends Error {}
/**
 * Discovery request (listing, not act capture): exact DOE-SP API host and a LISTING endpoint (no publication id), JSON
 * only; a redirect is never followed (refused). The fetcher passed in is the budget's, so the request is debited first.
 */
export async function discoverOfficial(url: string, doFetch: typeof fetch): Promise<unknown> {
  const api = officialApiEndpoint(new URL(url));
  if (!api || api.source !== 'DOE-SP' || api.publicationId !== null) throw new DiscoveryRefused(`not an authorized DOE-SP discovery endpoint: ${url}`);
  const res = await doFetch(url, { redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'TriBusca-ANAT-OFFICIAL-01 (consulta pontual)' }, signal: AbortSignal.timeout(30_000) });
  if (res.status >= 300 && res.status < 400) throw new DiscoveryRefused(`discovery redirect ${res.status} refused (never followed)`);
  if (res.status !== 200) throw new DiscoveryRefused(`discovery HTTP ${res.status}`);
  if (!/^application\/(?:[\w.+-]+\+)?json\b/iu.test(res.headers.get('content-type') ?? '')) throw new DiscoveryRefused('discovery response is not JSON');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await res.arrayBuffer()));
}

export const actKey = (key: string, title: RegExp, item: Pick<DoeSpListItem, 'title' | 'date'>): string | null => {
  const m = title.exec(item.title.trim()); if (!m) return null;
  return `${key} ${Number(m[1]!.replace(/\D/gu, ''))}/${item.date.slice(2, 4)}`;
};
/**
 * 2026 margin (#116 c.6708512598 §5, recheck R3): a date is accepted only if it is a REAL calendar date strictly before
 * 2026-01-01. Not a prefix test: 2027, 2099, an invalid date or a missing date are all refused (fail closed). The listing
 * and the API publication carry `YYYY-MM-DD` optionally followed by a time; only the date part is read.
 */
export const MARGIN = '2026-01-01';
export function beforeMargin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/u.exec(value); if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return false;
  return `${m[1]}-${m[2]}-${m[3]}` < MARGIN;
}
export const isReservedDoeSp = (k: string, item: Pick<DoeSpListItem, 'id' | 'date'>) =>
  RESERVED_ACT_KEYS.includes(k) || RESERVED_SOURCE_IDS.includes(item.id.toLowerCase()) || !beforeMargin(item.date);

export async function run(doFetch: typeof fetch, opts: { grantId: string; owner: string; date: string; budgetFile?: string; outDir?: string;
  plan?: Record<string, number>; discoveryType?: string; now?: () => Date;
  /** E9-ACERVO-01 R3: stop the WHOLE run after this many acts kept (1 = the first suitable sample, for the JSON × Acervo test). */
  stopAfter?: number }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(opts.date) || !beforeMargin(opts.date)) throw new DiscoveryRefused('the day list date must be a valid YYYY-MM-DD before 2026 (margin)');
  const actLimit = Math.min(P2D_LIMITS.acts, opts.stopAfter ?? P2D_LIMITS.acts);
  if (!Number.isInteger(actLimit) || actLimit < 1) throw new DiscoveryRefused('stopAfter must be a positive integer');
  const perType = opts.plan ?? { Decreto: 5, Resolução: 5, 'Portaria CAT': 5 };
  const discoveryType = opts.discoveryType ?? 'Decreto';
  if (!(discoveryType in perType)) throw new DiscoveryRefused(`discovery type ${discoveryType} is not in the plan`);
  const budget = RequestBudget.open(opts.budgetFile ?? P2D_BUDGET_FILE, { grantId: opts.grantId, owner: opts.owner, package: P2D_PACKAGE,
    requested: { total: Object.values(perType).reduce((a, b) => a + b, 0), perType } }, opts.now);
  const outDir = opts.outDir ?? P2D_DIR;
  const decisions: Record<string, unknown>[] = []; let acts = 0; let discovery: Record<string, unknown> = {};
  try {
    mkdirSync(outDir, { recursive: true });
    const stored = new Set(readdirSync(outDir).filter((f) => /^[0-9a-f-]{36}\.json$/u.test(f)).map((f) => f.slice(0, -5)));
    const disc = budget.fetcher(discoveryType, DISCOVERY, doFetch);
    let items: DoeSpListItem[];
    try {
      const journal = findDoeSpNamed(parseDoeSpNamedItems(await discoverOfficial(`${API}v2/journals`, disc), 'DOE_SP_INVALID_JOURNALS'), JOURNAL);
      if (!journal) throw new DiscoveryRefused(`journal "${JOURNAL}" not in the catalogue`);
      const section = findDoeSpNamed(parseDoeSpNamedItems(await discoverOfficial(`${API}v2/sections?JournalId=${encodeURIComponent(journal.id)}`, disc), 'DOE_SP_INVALID_SECTIONS'), SECTION);
      if (!section) throw new DiscoveryRefused(`section "${SECTION}" not in the catalogue`);
      const list = parseDoeSpList(await discoverOfficial(`${API}v2/summary/list?Date=${opts.date}&JournalId=${encodeURIComponent(journal.id)}&SectionId=${encodeURIComponent(section.id)}`, disc));
      items = list.items; discovery = { date: opts.date, debitedTo: discoveryType, journal: journal.id, section: section.id, listed: list.items.length, malformed: list.malformed.length };
      writeFileSync(join(outDir, `list-${opts.date}-${opts.grantId}.json`), `${JSON.stringify(list, null, 2)}\n`, { flag: 'wx' });
    } catch (e) {
      discovery = { date: opts.date, outcome: `${e instanceof BudgetRefused ? 'budget' : 'discovery failed'}: ${(e as Error).message} — debited, not read as absence` };
      return finish();
    }
    for (const t of P2D_TYPES) {
      if (acts >= actLimit) { decisions.push({ type: t.type, outcome: `not attempted: run stopped after ${actLimit} act(s) kept (stopAfter)` }); continue; }
      const capture = budget.fetcher(t.type, 'capture', doFetch) as unknown as FetchLike;
      const ofType = items.filter((i) => actKey(t.key, t.title, i) !== null);
      const reserved = ofType.filter((i) => isReservedDoeSp(actKey(t.key, t.title, i)!, i)).map((i) => i.id);
      const alreadyStored = ofType.filter((i) => stored.has(i.id)).map((i) => i.id);
      const eligible = ofType.filter((i) => !reserved.includes(i.id) && !stored.has(i.id));
      const byLen = [...eligible].sort((a, b) => b.excerpt.length - a.excerpt.length || a.id.localeCompare(b.id));
      const order = [byLen[0], byLen[Math.floor(byLen.length / 2)], byLen[byLen.length - 1], byLen[1], byLen[byLen.length - 2]].filter((x, i, arr): x is DoeSpListItem => !!x && arr.findIndex((y) => y?.id === x.id) === i);
      const kept = new Map<Size, string>(); const tried: Record<string, unknown>[] = [];
      for (const i of order) {
        if (budget.remaining(t.type) === 0 || acts >= actLimit || kept.size === 3) break;
        const m: ManifestAct = { id: i.id, source: 'DOE-SP', act: i.title.slice(0, 120), url: `${API}v2/publications/${i.id}`, urlStatus: 'candidate', reason: `E9 P2-d (${t.type}, grant ${opts.grantId})` };
        const r = await consultOfficial(m, OFFICIAL_HOSTS['DOE-SP'], capture, undefined, ['DOE-SP'])
          .catch((e: Error) => ({ ok: false as const, failure: { code: e instanceof BudgetRefused ? 'budget' : 'error', detail: e.message } }));
        if (!r.ok) { tried.push({ id: i.id, outcome: `failed: ${r.failure.code} ${'detail' in r.failure ? r.failure.detail : ''}` }); continue; }
        let chars: number;
        try {
          const p = prepareDoeSpRepresentation({ resourceId: `doe-sp:${i.id}`, bytes: new Uint8Array(r.body) }, i.id);
          // The act RETURNED by the API must also be before 2026 (the listing date alone is not trusted).
          if (!beforeMargin(p.metadata?.date)) { tried.push({ id: i.id, outcome: `captured but refused: returned act date ${String(p.metadata?.date)} is not a valid date before 2026 (bytes not stored)` }); continue; }
          chars = analyzeAnatomy({ publicationVersionId: `doe-sp:${i.id}`, referenceDate: '2026-11-07', ruleSet: { id: 'p2d', version: '1' },
            input: { source: 'DOE-SP', representationId: `doe-sp:${i.id}`, html: p.html }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;
        } catch (e) { tried.push({ id: i.id, outcome: `captured but not preparable/readable: ${(e as Error).message.slice(0, 160)} (bytes not stored)` }); continue; }
        const size = sizeOf(chars);
        if (kept.has(size)) { tried.push({ id: i.id, chars, size, outcome: `captured but discarded: size ${size} already kept (bytes not stored)` }); continue; }
        if (existsSync(join(outDir, `${i.id}.json`))) { tried.push({ id: i.id, outcome: 'captured but already stored (bytes not overwritten)' }); continue; }
        writeFileSync(join(outDir, `${i.id}.json`), r.body, { flag: 'wx' });
        writeFileSync(join(outDir, `${i.id}.meta.json`), `${JSON.stringify({ ...r.meta, origin: `automated fetch via consultOfficial (E9 P2-d, grant ${opts.grantId})`, promoted: false,
          p2d: { type: t.type, actKey: actKey(t.key, t.title, i), listDate: opts.date, grantId: opts.grantId, measuredChars: chars, size } }, null, 2)}\n`, { flag: 'wx' });
        kept.set(size, i.id); acts++; tried.push({ id: i.id, chars, size, outcome: 'kept' });
      }
      decisions.push({ type: t.type, listedOfType: ofType.length, reserved, alreadyStored, eligible: eligible.length, tried, kept: Object.fromEntries(kept),
        sizesNotFound: (['pequeno', 'médio', 'grande'] as const).filter((s) => !kept.has(s)), remainingForType: budget.remaining(t.type) });
    }
    return finish();
  } finally { budget.close(); }
  function finish() {
    const inventory = { grantId: opts.grantId, owner: opts.owner, discovery, stopAfter: actLimit, actsKept: acts, decisions, remainingTotal: budget.remaining(),
      note: 'per-attempt debit record = budget-state.json; a type or size not found in the day list is never read as nonexistent' };
    writeFileSync(join(outDir, `inventory-${opts.grantId}.json`), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    return inventory;
  }
}

/**
 * R5.1 (COORD E9-ACERVO-01 R5.1): DIRECT diagnostic capture of ONE DOE-SP act already identified in a PRESERVED day list
 * (no discovery). Offline before any request: the id must be in the list file, its title must be a Decreto/Resolução/
 * Portaria CAT title, its listing date a real date before 2026, it must not be reserved (act key or id) nor already
 * stored. The budget is opened for exactly 1 request of that type. The fetch is ONE-SHOT: only
 * `<API>v2/publications/<id>` may be sent, once; a redirect hop (or any second call) is refused before it is sent, so at
 * most one request is sent and debited whatever the outcome. After the capture: id (prepareDoeSpRepresentation), the
 * returned title equal to the listed one, and the returned date before 2026 — else refused and not stored. Output files
 * are this run's own (`direct-<id>-<grant>…`); earlier list/inventory/diagnostic files are never touched.
 */
export class OneRequestRefused extends Error {}
export const oneShot = (allowedUrl: string, inner: FetchLike): FetchLike => {
  let sent = false;
  return (async (url: string, init?: RequestInit) => {
    if (sent) throw new OneRequestRefused(`one_request: a second request (${url}) was refused before it was sent (not debited)`);
    if (url !== allowedUrl) throw new OneRequestRefused(`one_request: ${url} is not the pinned publication URL (not sent)`);
    sent = true; return inner(url, init);
  }) as FetchLike;
};
export async function runDirectOne(doFetch: typeof fetch, opts: { grantId: string; owner: string; id: string; listFile: string; budgetFile?: string; outDir?: string; now?: () => Date }) {
  const id = opts.id.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new DiscoveryRefused(`id ${opts.id} is not a GUID`);
  const list = JSON.parse(readFileSync(opts.listFile, 'utf8')) as { items?: DoeSpListItem[] };
  const item = (list.items ?? []).find((i) => typeof i.id === 'string' && i.id.toLowerCase() === id);
  if (!item) throw new DiscoveryRefused(`id ${id} is not in the preserved list ${opts.listFile}`);
  const t = P2D_TYPES.find((x) => actKey(x.key, x.title, item) !== null);
  if (!t) throw new DiscoveryRefused(`listed title "${item.title}" is not a Decreto / Resolução / Portaria CAT`);
  const key = actKey(t.key, t.title, item)!;
  if (!beforeMargin(item.date)) throw new DiscoveryRefused(`listed date ${item.date} is not a valid date before 2026`);
  if (isReservedDoeSp(key, item)) throw new DiscoveryRefused(`reserved act (${key} / ${id})`);
  const outDir = opts.outDir ?? P2D_DIR;
  if (existsSync(join(outDir, `${id}.json`))) throw new DiscoveryRefused(`act ${id} already stored (bytes kept)`);
  const invFile = join(outDir, `direct-${id}-${opts.grantId}.inventory.json`);
  if (existsSync(invFile)) throw new DiscoveryRefused(`this direct run already has an inventory (${invFile}); never overwritten`);
  const budget = RequestBudget.open(opts.budgetFile ?? P2D_BUDGET_FILE, { grantId: opts.grantId, owner: opts.owner, package: P2D_PACKAGE,
    requested: { total: 1, perType: { [t.type]: 1 } } }, opts.now);
  const url = `${API}v2/publications/${id}`;
  let outcome: Record<string, unknown>;
  try {
    mkdirSync(outDir, { recursive: true });
    const capture = oneShot(url, budget.fetcher(t.type, 'capture', doFetch) as unknown as FetchLike);
    const m: ManifestAct = { id, source: 'DOE-SP', act: item.title.slice(0, 120), url, urlStatus: 'candidate', reason: `E9 P2-d direct diagnostic (${t.type}, grant ${opts.grantId})` };
    const r = await consultOfficial(m, OFFICIAL_HOSTS['DOE-SP'], capture, undefined, ['DOE-SP'])
      .catch((e: Error) => ({ ok: false as const, failure: { code: e instanceof BudgetRefused ? 'budget' : 'error', detail: e.message } }));
    if (!r.ok) outcome = { result: 'failed', detail: `${r.failure.code} ${'detail' in r.failure ? r.failure.detail : ''}` };
    else {
      const root = JSON.parse(r.body.toString('utf8')) as { title?: unknown };
      let p; try { p = prepareDoeSpRepresentation({ resourceId: `doe-sp:${id}`, bytes: new Uint8Array(r.body) }, id); } catch (e) { p = null; outcome = { result: 'refused', detail: `not preparable: ${(e as Error).message.slice(0, 160)}` }; }
      if (p) {
        const problems = [typeof root.title !== 'string' || root.title.trim() !== item.title.trim() ? `returned title ${JSON.stringify(root.title)} differs from the listed one` : null,
          !beforeMargin(p.metadata?.date) ? `returned date ${String(p.metadata?.date)} is not a valid date before 2026` : null].filter(Boolean);
        if (problems.length) outcome = { result: 'refused', detail: problems.join('; ') };
        else {
          const chars = analyzeAnatomy({ publicationVersionId: `doe-sp:${id}`, referenceDate: '2026-11-09', ruleSet: { id: 'p2d-direct', version: '1' },
            input: { source: 'DOE-SP', representationId: `doe-sp:${id}`, html: p.html }, catalog: { edition: 'none', codes: [] } }).canonicalText.length;
          writeFileSync(join(outDir, `${id}.json`), r.body, { flag: 'wx' });
          writeFileSync(join(outDir, `${id}.meta.json`), `${JSON.stringify({ ...r.meta, origin: `automated fetch via consultOfficial (E9 P2-d DIRECT diagnostic, grant ${opts.grantId})`, promoted: false,
            p2d: { type: t.type, actKey: key, listFile: opts.listFile.split('/').pop(), grantId: opts.grantId, mode: 'direct-one', measuredChars: chars, size: sizeOf(chars) } }, null, 2)}\n`, { flag: 'wx' });
          outcome = { result: 'kept', chars, size: sizeOf(chars), sha256: r.meta.sha256, bytes: r.meta.bytes };
        }
      }
    }
  } finally { budget.close(); }
  const inventory = { grantId: opts.grantId, owner: opts.owner, mode: 'direct-one', discovery: 'skipped (preserved list)', id, title: item.title, type: t.type, actKey: key,
    listedDate: item.date, url, outcome: outcome!, remainingForType: budget.remaining(t.type), remainingTotal: budget.remaining(),
    note: 'at most one request sent and debited (one-shot fetch); per-attempt record = budget-state.json' };
  writeFileSync(invFile, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

/**
 * R4 (COORD E9-ACERVO-01 R4): the command line is the DIAGNOSTIC collection — it REQUIRES `--stop-after 1` (the first
 * suitable sample for the JSON × Acervo comparison) and passes it to run(). A missing or invalid limit (absent, 0, 2,
 * non-integer) is refused before the budget is opened and before any request. Exported for tests (simulated transport).
 */
export const DIAGNOSTIC_STOP_AFTER = 1;
export async function cli(argv: readonly string[], doFetch: typeof fetch, extra: { budgetFile?: string; outDir?: string; now?: () => Date } = {}):
  Promise<{ code: 0 | 2; error?: string; inventory?: Awaited<ReturnType<typeof run>>; direct?: Awaited<ReturnType<typeof runDirectOne>> }> {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const grantId = arg('--grant'); const owner = arg('--owner'); const date = arg('--date'); const stop = arg('--stop-after');
  const usage = 'usage: collect-p2d.ts --grant <grantId> --owner <owner> --date <YYYY-MM-DD before 2026> --stop-after 1  (refused without an active grant)';
  const directId = arg('--id'); const listFile = arg('--list');
  if (directId !== undefined || listFile !== undefined) {
    const usageDirect = 'usage: collect-p2d.ts --grant <grantId> --owner <owner> --id <guid> --list <preserved list json> --stop-after 1  (direct: no discovery, at most 1 request)';
    if (!grantId || !owner || !directId || !listFile || date !== undefined) return { code: 2, error: usageDirect };
    if (stop === undefined || !/^\d+$/u.test(stop) || Number(stop) !== DIAGNOSTIC_STOP_AFTER) return { code: 2, error: `--stop-after must be exactly ${DIAGNOSTIC_STOP_AFTER}; nothing was sent. ${usageDirect}` };
    return { code: 0, direct: await runDirectOne(doFetch, { grantId, owner, id: directId, listFile, ...extra }) };
  }
  if (!grantId || !owner || !date) return { code: 2, error: usage };
  if (stop === undefined || !/^\d+$/u.test(stop) || Number(stop) !== DIAGNOSTIC_STOP_AFTER)
    return { code: 2, error: `--stop-after must be exactly ${DIAGNOSTIC_STOP_AFTER} for the diagnostic collection (got ${stop === undefined ? 'nothing' : JSON.stringify(stop)}); nothing was sent. ${usage}` };
  const inventory = await run(doFetch, { grantId, owner, date, stopAfter: DIAGNOSTIC_STOP_AFTER, ...extra });
  return { code: 0, inventory };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await cli(process.argv, fetch);
  if (r.code !== 0) { console.error(r.error); process.exit(r.code); }
  if (r.direct) { console.log(JSON.stringify(r.direct, null, 1)); process.exit(0); }
  const inv = r.inventory!;
  console.log(JSON.stringify(inv.discovery)); for (const d of inv.decisions) console.log(JSON.stringify(d));
  console.log(`acts kept ${inv.actsKept} (stopAfter ${inv.stopAfter}); remaining ${inv.remainingTotal}`);
}
