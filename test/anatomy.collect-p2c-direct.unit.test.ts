import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P2C_PACKAGE, runDirect, directTargetProblem, multivigenteUrl, BUDGET_FILE, pinnedRouteProblem, realIsoDate, type DirectTarget } from '../ops/anatomy/collect-p2c.js';
import type { BudgetState } from '../ops/anatomy/request-budget.js';

// E9-ACERVO-01 R3 (tribusca-control#116, D1–D3): P2-c direct capture by idAto. Simulated transport only — no request.
// The body served is the REAL multivigente JSON of Portaria RFB 514/2025 already versioned in the repository (idAto 142967).
const NOW = () => new Date('2026-11-09T12:00:00Z');
const REAL = readFileSync(new URL('../ops/anatomy/official-identification/rfb-p2c/142967.json', import.meta.url));
const budget = (perType: Record<string, number> = { Portaria: 3, Resolução: 3, 'Ato Declaratório Interpretativo': 2, 'Ato Declaratório Executivo': 4, 'Solução de Consulta': 4 }) => {
  const d = mkdtempSync(join(tmpdir(), 'p2c-direct-')); const f = join(d, 'budget-state.json');
  writeFileSync(f, JSON.stringify({ schema: 'request-budget/1', grant: { grantId: 'G-1', owner: 'exec-303', package: P2C_PACKAGE, approvedBy: 'test', status: 'active',
    expiresAt: '2026-11-10T00:00:00Z', total: Object.values(perType).reduce((a, b) => a + b, 0), perType }, used: { total: 0, perType: {} }, attempts: [] })); return f; };
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as BudgetState;
const portaria514: DirectTarget = { type: 'Portaria', idAto: '142967', numeroAto: '514', anoAto: '2025', acervoSize: 'medio' };
function transport(handler: (url: string, n: number) => Response) {
  const urls: string[] = []; const f = (async (u: string | URL) => { const url = String(u); urls.push(url); return handler(url, urls.length); }) as unknown as typeof fetch; return { f, urls };
}
const okReal = () => new Response(REAL, { status: 200, headers: { 'content-type': 'application/json' } });
const opts = (f: string, targets: DirectTarget[], extra: Record<string, unknown> = {}) =>
  ({ grantId: 'G-1', owner: 'exec-303', targets, budgetFile: f, outDir: mkdtempSync(join(tmpdir(), 'p2c-direct-out-')), lotDirs: [] as string[], now: NOW, ...extra });

test('direct: the URL is BUILT from a validated idAto; malformed targets are refused before any request', async () => {
  assert.equal(multivigenteUrl(142967), 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/142967/visao/multivigente');
  for (const bad of [{ idAto: '0142967' }, { idAto: '-1' }, { idAto: '1e3' }, { idAto: '142967/../1' }, { idAto: '12345678901' }, { numeroAto: '5a' }, { anoAto: '2026' }, { anoAto: '2027' }, { anoAto: '25' }, { type: 'Instrução Normativa' }])
    assert.ok(directTargetProblem({ ...portaria514, ...bad } as DirectTarget), JSON.stringify(bad));
  const t = transport(() => { throw new Error('must not be called'); });
  const inv = await runDirect(t.f, opts(budget(), [{ ...portaria514, idAto: '0142967' }, { ...portaria514, anoAto: '2027' }]));
  assert.equal(t.urls.length, 0); assert.equal(inv.actsKept, 0); assert.match(JSON.stringify(inv.decisions), /refused before request/u);
});

test('direct: an act already stored (in any RFB lot) and a reserved act are skipped BEFORE any request; the budget is not even opened', async () => {
  const f = budget(); const t = transport(() => { throw new Error('must not be called'); });
  // Default lot folders: 142967 is versioned in rfb-p2c. 153743 is a RESERVED_SOURCE_IDS entry.
  const inv = await runDirect(t.f, { ...opts(f, [portaria514, { type: 'Portaria', idAto: '153743', numeroAto: '77', anoAto: '2025' }]), lotDirs: undefined });
  assert.equal(t.urls.length, 0);
  assert.match(JSON.stringify(inv.decisions), /already stored/u); assert.match(JSON.stringify(inv.decisions), /reserved/u);
  assert.equal(read(f).used.total, 0); assert.equal(existsSync(`${f}.lock`), false);
});

test('direct: identity divergence (number, type, act date) is refused after the capture — debited, bytes NOT stored', async () => {
  for (const wrong of [{ numeroAto: '515' }, { type: 'Resolução' }, { anoAto: '2024' }]) {
    const f = budget(); const t = transport(okReal); const o = opts(f, [{ ...portaria514, ...wrong } as DirectTarget]);
    const inv = await runDirect(t.f, o);
    assert.equal(t.urls.length, 1); assert.equal(t.urls[0], multivigenteUrl(142967));
    assert.match(JSON.stringify(inv.decisions), /identity diverges from the target/u, JSON.stringify(wrong));
    assert.equal(existsSync(join(o.outDir, '142967.json')), false); assert.equal(read(f).used.total, 1, 'the refused capture stays debited');
  }
  // A body whose idAto differs from the URL is refused by consultOfficial/validateRfbJson.
  const f = budget(); const other = Buffer.from(REAL.toString('utf8').replace('"idAto":142967', '"idAto":142968'));
  const t = transport(() => new Response(other, { status: 200, headers: { 'content-type': 'application/json' } }));
  const o = opts(f, [portaria514]); const inv = await runDirect(t.f, o);
  assert.equal(inv.actsKept, 0); assert.equal(existsSync(join(o.outDir, '142967.json')), false); assert.equal(read(f).used.total, 1);
});

test('direct: every attempt is debited — redirect hop, HTTP failure and success; the size is the MEASURED multivigente one (D3)', async () => {
  const f = budget();
  const t = transport((url, n) => n === 1 ? new Response(null, { status: 302, headers: { location: url } }) : n === 2 ? okReal() : new Response('{}', { status: 500 }));
  const o = opts(f, [portaria514, { type: 'Solução de Consulta', idAto: '900001', numeroAto: '9', anoAto: '2025' }]);
  const inv = await runDirect(t.f, o);
  const s = read(f);
  assert.equal(s.used.total, t.urls.length, 'every request sent (redirect hop included) was debited');
  assert.equal(s.used.perType.Portaria, 2); assert.equal(s.used.perType['Solução de Consulta'], 1);
  assert.equal(inv.actsKept, 1); assert.ok(existsSync(join(o.outDir, '142967.json')));
  const meta = JSON.parse(readFileSync(join(o.outDir, '142967.meta.json'), 'utf8')) as { p2c: { size: string; acervoSize: string; mode: string } };
  assert.deepEqual([meta.p2c.mode, meta.p2c.size, meta.p2c.acervoSize], ['direct-by-idAto', 'pequeno', 'medio']);
  assert.match(JSON.stringify(inv.decisions), /kept for the MEASURED size pequeno \(Acervo said medio; D3\)/u);
  assert.match(JSON.stringify(inv.decisions), /failed \(every request sent was debited\)/u); assert.equal(inv.searches, 0);
});

test('direct: per-type caps hold (no transfer); duplicates are skipped; the repository grant is SUSPENDED and refuses with zero requests', async () => {
  const t = transport(okReal);
  const inv = await runDirect(t.f, opts(budget({ Portaria: 1 }), [portaria514, { ...portaria514 }, { ...portaria514, idAto: '900002' }], { plan: { portaria: 1 } }));
  assert.match(JSON.stringify(inv.decisions), /duplicate target/u); assert.match(JSON.stringify(inv.decisions), /beyond the Portaria cap of 1/u);
  assert.equal(t.urls.length, 1);
  const g = read(BUDGET_FILE).grant!; let calls = 0; const spy = (async () => { calls++; throw new Error('must not be called'); }) as unknown as typeof fetch;
  await assert.rejects(runDirect(spy, { grantId: g.grantId, owner: g.owner, targets: [{ type: 'Portaria', idAto: '900003', numeroAto: '1', anoAto: '2025' }], lotDirs: [], outDir: mkdtempSync(join(tmpdir(), 'x-')) }), /suspended/u);
  assert.equal(calls, 0); assert.equal(existsSync(`${BUDGET_FILE}.lock`), false);
});

// R4 (COORD E9-ACERVO-01 R4): host, idAto and the multivigente route are pinned on every hop; vision and real act date
// are confirmed before storing. Simulated transport only.
const json = (b: Buffer | string) => new Response(b, { status: 200, headers: { 'content-type': 'application/json' } });
const withField = (mutate: (root: Record<string, any>) => void) => { const root = JSON.parse(REAL.toString('utf8')) as Record<string, any>; mutate(root); return Buffer.from(JSON.stringify(root)); };

test('R4: a redirect to /visao/original of the SAME idAto is refused before the next request — 1 sent, 1 debited, nothing stored', async () => {
  const f = budget(); const t = transport((url) => url.endsWith('/visao/multivigente')
    ? new Response(null, { status: 302, headers: { location: 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/142967/visao/original' } }) : okReal());
  const o = opts(f, [portaria514]); const inv = await runDirect(t.f, o);
  assert.deepEqual(t.urls, [multivigenteUrl(142967)], 'the original route was never requested');
  assert.equal(read(f).used.total, 1, 'the request actually sent stays debited; the refused hop is not');
  assert.match(JSON.stringify(inv.decisions), /route_pinned: route changed to \/api\/consulta-externa\/ato\/142967\/visao\/original/u);
  assert.equal(inv.actsKept, 0); assert.equal(existsSync(join(o.outDir, '142967.json')), false);
});

test('R4: every other route change is refused before sending — other idAto, query, port, host, http', async () => {
  for (const location of ['https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/142968/visao/multivigente',
    'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/142967/visao/multivigente?x=1',
    'https://normasinternet2.receita.fazenda.gov.br:8443/api/consulta-externa/ato/142967/visao/multivigente',
    'https://normas.receita.fazenda.gov.br/api/consulta-externa/ato/142967/visao/multivigente',
    'http://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/142967/visao/multivigente']) {
    const f = budget(); const t = transport((url, n) => (n === 1 ? new Response(null, { status: 301, headers: { location } }) : okReal()));
    const o = opts(f, [portaria514]); const inv = await runDirect(t.f, o);
    assert.equal(t.urls.length, 1, location); assert.equal(read(f).used.total, 1, location);
    assert.equal(inv.actsKept, 0, location); assert.equal(existsSync(join(o.outDir, '142967.json')), false, location);
  }
  assert.equal(pinnedRouteProblem(multivigenteUrl(142967), 142967), null);
  // A redirect to the SAME pinned URL is followed and both requests are debited (covered with storage in the D3 test above).
});

test('R4: a response dated 2025-02-30, or a non-multivigente vision, is refused before storing — debited, nothing written', async () => {
  for (const [label, body] of [['2025-02-30', withField((r) => { r.epigrafe.dataAto = '2025-02-30'; })], ['visao original', withField((r) => { r.visao = 'original'; })]] as const) {
    const f = budget(); const t = transport(() => json(body)); const o = opts(f, [portaria514]);
    const inv = await runDirect(t.f, o);
    assert.equal(t.urls.length, 1, label); assert.equal(read(f).used.total, 1, `${label}: the request sent stays debited`);
    assert.match(JSON.stringify(inv.decisions), label === '2025-02-30' ? /act date 2025-02-30 \(not a real date/u : /vision original \(multivigente required\)/u, label);
    assert.equal(inv.actsKept, 0, label); assert.equal(existsSync(join(o.outDir, '142967.json')), false, label); assert.equal(existsSync(join(o.outDir, '142967.meta.json')), false, label);
  }
  assert.deepEqual(['2025-02-21', '2024-02-29', '2025-02-30', '2025-13-01', '2025-2-1', ''].map(realIsoDate), [true, true, false, false, false, false]);
});
