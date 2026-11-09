// E9-ACERVO-01 §2 (tribusca-control#116): minimal capture plan for the 12 pending RFB cells, OFFLINE. Input is the CSV
// export of query B of 01_candidates_readonly.sql (run by Fábio). Nothing here sends a request, changes the grant or
// writes a ledger: the output is a plan for the COORD decision. The capture itself stays with the #303 collector, the
// E9-P2c-G1 grant and its single owner.
//
// Usage: npx tsx ops/anatomy/e9-acervo/plan-rfb-captures.mts <candidates.csv> <checkout of #303>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type CellType = 'Portaria' | 'Ato Declaratório Interpretativo' | 'Ato Declaratório Executivo' | 'Solução de Consulta' | 'Resolução';
export type Size = 'pequeno' | 'medio' | 'grande';
/** Pending RFB cells of the E9 matrix at #305 d6d991ef (11/61). */
export const PENDING: ReadonlyArray<readonly [CellType, Size]> = [
  ['Portaria', 'medio'], ['Portaria', 'grande'], ['Ato Declaratório Interpretativo', 'medio'], ['Ato Declaratório Interpretativo', 'grande'],
  ['Resolução', 'medio'], ['Resolução', 'grande'], ['Ato Declaratório Executivo', 'pequeno'], ['Ato Declaratório Executivo', 'medio'],
  ['Ato Declaratório Executivo', 'grande'], ['Solução de Consulta', 'pequeno'], ['Solução de Consulta', 'medio'], ['Solução de Consulta', 'grande'],
];
export interface Row { source_code: string; act_type: string; size: string; external_id: string; act_number: string; published_on: string; official_url: string; chars: number; near_boundary: boolean }
export interface Rules { reservedActKeys: ReadonlySet<string>; reservedSourceIds: ReadonlySet<string>; alreadyCaptured: ReadonlySet<string>; actKey: (label: string) => string | null; perTypeCap: Record<CellType, number>; total: number }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function cellType(actType: string): CellType | null {
  const t = fold(actType);
  if (t.includes('interpretativo')) return 'Ato Declaratório Interpretativo';
  if (t.includes('executivo')) return 'Ato Declaratório Executivo';
  if (t.includes('solucao de consulta')) return 'Solução de Consulta';
  if (t.startsWith('portaria')) return 'Portaria';
  if (t.startsWith('resolucao')) return 'Resolução';
  return null;
}
/** Why a candidate cannot be captured, or null. Fail closed: no readable act key ⇒ refused (as the #303 guard). */
export function refusal(r: Row, rules: Rules): string | null {
  if (r.source_code !== 'rfb-normas') return 'not RFB';
  if (!/^\d+$/u.test(r.external_id)) return 'external_id is not an idAto';
  if (rules.alreadyCaptured.has(r.external_id)) return 'already captured (bytes kept by an earlier session)';
  if (rules.reservedSourceIds.has(r.external_id)) return 'reserved source id';
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(r.published_on) || r.published_on >= '2026-01-01') return '2026 margin / no date';
  const key = rules.actKey(`${r.act_type} ${r.act_number}/${r.published_on.slice(0, 4)}`);
  if (!key) return 'no readable act key';
  if (rules.reservedActKeys.has(key)) return `reserved act key ${key}`;
  // The Acervo keeps the ORIGINAL vision; the multivigente one is >= in size. A small cell needs margin below 10,000.
  if (r.size === 'pequeno' && r.near_boundary) return 'pequeno too close to 10,000 (multivigente may be médio)';
  return null;
}
export interface PlanCell { type: CellType; size: Size; pick: Row | null; fallbacks: Row[]; refused: Array<{ external_id: string; reason: string }>; state: string }
export function plan(rows: readonly Row[], rules: Rules) {
  const cells: PlanCell[] = PENDING.map(([type, size]) => {
    const mine = rows.filter((r) => cellType(r.act_type) === type && r.size === size);
    const refused = mine.map((r) => ({ external_id: r.external_id, reason: refusal(r, rules) })).filter((x): x is { external_id: string; reason: string } => !!x.reason);
    const ok = mine.filter((r) => !refusal(r, rules));
    return { type, size, pick: ok[0] ?? null, fallbacks: ok.slice(1), refused,
      state: ok[0] ? 'candidate' : mine.length ? 'only refused candidates in the Acervo' : 'not found in the Acervo (≠ nonexistent)' };
  });
  const perType = {} as Record<CellType, { planned: number; cap: number; spareForFallback: number }>;
  for (const t of Object.keys(rules.perTypeCap) as CellType[]) {
    const planned = cells.filter((c) => c.type === t && c.pick).length;
    perType[t] = { planned, cap: rules.perTypeCap[t], spareForFallback: rules.perTypeCap[t] - planned };
  }
  const planned = cells.filter((c) => c.pick).length;
  const overCap = (Object.keys(perType) as CellType[]).filter((t) => perType[t].planned > perType[t].cap);
  return { requestsPlanned: planned, total: rules.total, remainingAfterPlan: rules.total - planned, searches: 0, perType, overCap, cells };
}

export function parseCsv(text: string): Row[] {
  const lines: string[][] = []; let field = ''; let row: string[] = []; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((x) => x !== '')) lines.push(row); row = []; } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); lines.push(row); }
  const [head, ...body] = lines; if (!head) return [];
  const ix = (k: string) => { const i = head.indexOf(k); if (i < 0) throw new Error(`CSV lacks column ${k}`); return i; };
  return body.map((c) => ({ source_code: c[ix('source_code')]!, act_type: c[ix('act_type')]!, size: c[ix('size')]!, external_id: c[ix('external_id')]!,
    act_number: c[ix('act_number')]!, published_on: c[ix('published_on')]!, official_url: c[ix('official_url')]!, chars: Number(c[ix('chars')]),
    near_boundary: /^(t|true)$/iu.test(c[ix('near_boundary')]!) }));
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const [csv, chain] = process.argv.slice(2);
  if (!csv || !chain) throw new Error('usage: <candidates.csv> <checkout of #303>');
  const reserved = await import(join(chain, 'src/modules/anatomy/config/reserved-act-keys.ts'));
  const { actKey } = await import(join(chain, 'src/modules/anatomy/config/act-key.ts'));
  const p2c = join(chain, 'ops/anatomy/official-identification/rfb-p2c');
  const budget = JSON.parse(readFileSync(join(p2c, 'budget-state.json'), 'utf8'));
  if (budget.used.total !== 0 || budget.attempts.length !== 0) throw new Error('the grant was already used: re-plan from the real balance');
  const lots = ['rfb-normasinternet2', 'rfb-normasinternet2-coleta02', 'rfb-p2c'].map((d) => join(chain, 'ops/anatomy/official-identification', d)).filter(existsSync);
  const alreadyCaptured = new Set(lots.flatMap((d) => readdirSync(d).filter((f) => /^\d+\.json$/u.test(f)).map((f) => f.slice(0, -5))));
  const out = plan(parseCsv(readFileSync(csv, 'utf8')), { reservedActKeys: new Set(reserved.RESERVED_ACT_KEYS), reservedSourceIds: new Set(reserved.RESERVED_SOURCE_IDS),
    alreadyCaptured, actKey, perTypeCap: budget.grant.perType, total: budget.grant.total });
  console.log(JSON.stringify({ grant: budget.grant.grantId, status: budget.grant.status, ...out }, null, 1));
}
