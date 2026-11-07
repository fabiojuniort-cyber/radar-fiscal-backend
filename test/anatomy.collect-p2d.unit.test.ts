import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISCOVERY, DiscoveryRefused, discoverOfficial, JOURNAL, P2D_BUDGET_FILE, P2D_PACKAGE, SECTION, actKey, P2D_TYPES, run } from '../ops/anatomy/collect-p2d.js';
import { DOE_SP_JOURNAL, DOE_SP_SECTION } from '../src/modules/collection/doe-sp.connector.js';
import type { BudgetState } from '../ops/anatomy/request-budget.js';

// E9 P2-d collector — simulated transport only, no request. The repository budget is SUSPENDED (layout pending decision).
const NOW = () => new Date('2026-11-07T12:00:00Z');
const HOST = 'https://do-api-web-search.doe.sp.gov.br/';
const G = (n: number) => `0b9b4578-91be-4da4-aaa8-${String(n).padStart(12, '0')}`;
const J = G(900); const S = G(901);
const budgetFile = (perType: Record<string, number> = { Decreto: 5, Resolução: 5, 'Portaria CAT': 5 }) => { const d = mkdtempSync(join(tmpdir(), 'p2d-')); const f = join(d, 'budget-state.json');
  writeFileSync(f, JSON.stringify({ schema: 'request-budget/1', grant: { grantId: 'G-D', owner: 'exec-304', package: P2D_PACKAGE, approvedBy: 'test', status: 'active', expiresAt: '2026-11-08T00:00:00Z',
    total: Object.values(perType).reduce((a, b) => a + b, 0), perType }, used: { total: 0, perType: {} }, attempts: [] })); return f; };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const item = (n: number, title: string, excerpt = 'x', date = '2025-03-10T00:00:00') => ({ id: G(n), title, slug: `s-${n}`, hierarchy: 'Executivo > Atos Normativos', date, excerpt });
const pub = (n: number, title: string, words: number) => ({ id: G(n), title, slug: `s-${n}`, date: '2025-03-10', journal: 'Executivo', content: `<p>Artigo 1º ${'texto '.repeat(words)}</p>` });
function transport(list: unknown[], pubs: Record<string, unknown>) {
  const urls: string[] = [];
  const f = (async (u: string | URL) => { const url = String(u); urls.push(url);
    if (url.includes('/v2/journals')) return json({ count: 1, items: [{ id: J, name: 'Executivo' }] });
    if (url.includes('/v2/sections')) return json({ count: 1, items: [{ id: S, name: 'Atos Normativos' }] });
    if (url.includes('/v2/summary/list')) return json({ pages: 1, pageSize: 100, publications: list });
    const id = /publications\/([0-9a-f-]{36})/u.exec(url)?.[1]; return id && pubs[id] ? json(pubs[id]) : json({ status: 404, error: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
  return { f, urls };
}

test('P2-d: catalogue names equal the versioned connector; the repository budget is SUSPENDED and refuses with zero requests', async () => {
  assert.deepEqual([JOURNAL, SECTION], [DOE_SP_JOURNAL, DOE_SP_SECTION]);
  const g = (JSON.parse(readFileSync(P2D_BUDGET_FILE, 'utf8')) as BudgetState).grant!;
  assert.deepEqual([g.grantId, g.status, g.total, Object.values(g.perType).reduce((a, b) => a + b, 0)], ['E9-P2d-G1', 'suspended', 15, 15]);
  let calls = 0; const spy = (async () => { calls++; throw new Error('must not be called'); }) as unknown as typeof fetch;
  await assert.rejects(run(spy, { grantId: 'E9-P2d-G1', owner: g.owner, date: '2025-03-10' }), /suspended/u);
  assert.equal(calls, 0); assert.equal(existsSync(`${P2D_BUDGET_FILE}.lock`), false);
  await assert.rejects(run(spy, { grantId: 'E9-P2d-G1', owner: g.owner, date: '2026-01-10' }), /before 2026/u, '2026 margin on the list date');
});

test('P2-d discovery is a LISTING path: publication URLs, other hosts, redirects and non-JSON are refused', async () => {
  const ok = (async () => json([])) as unknown as typeof fetch;
  for (const u of [`${HOST}v2/publications/${G(1)}`, 'https://evil.example/v2/journals', `${HOST}v2/authentication/download/x`, `http://do-api-web-search.doe.sp.gov.br/v2/journals`])
    await assert.rejects(discoverOfficial(u, ok), DiscoveryRefused, u);
  await assert.rejects(discoverOfficial(`${HOST}v2/journals`, (async () => new Response(null, { status: 302, headers: { location: `${HOST}v2/sections` } })) as unknown as typeof fetch), /redirect 302 refused/u);
  await assert.rejects(discoverOfficial(`${HOST}v2/journals`, (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch), /not JSON/u);
});

test('P2-d run: discovery debited in its own bucket; reserved, 2026 and stored acts skipped before capture; 1 per size; every request debited', async () => {
  const f = budgetFile(); const out = mkdtempSync(join(tmpdir(), 'p2d-out-'));
  writeFileSync(join(out, `${G(5)}.json`), '{"stored":true}');
  const list = [item(1, 'DECRETO Nº 69.000, DE 10 DE MARÇO DE 2025', 'a'.repeat(50)), item(2, 'DECRETO Nº 70.843, DE 1º DE JANEIRO DE 2026', 'b', '2026-01-02T00:00:00'),
    item(3, 'DECRETO Nº 69.001, DE 10 DE MARÇO DE 2025', 'c'), item(4, 'PORTARIA CAT Nº 12, DE 10 DE MARÇO DE 2025'), item(5, 'RESOLUÇÃO SFP Nº 7, DE 10 DE MARÇO DE 2025'),
    item(6, 'COMUNICADO Nº 1')];
  const pubs = { [G(1)]: pub(1, 'DECRETO Nº 69.000', 3), [G(3)]: pub(3, 'DECRETO Nº 69.001', 4), [G(4)]: pub(4, 'PORTARIA CAT Nº 12', 2000) };
  const t = transport(list, pubs);
  const inv = await run(t.f, { grantId: 'G-D', owner: 'exec-304', date: '2025-03-10', budgetFile: f, outDir: out, now: NOW });
  const s = JSON.parse(readFileSync(f, 'utf8')) as BudgetState;
  assert.equal(s.used.total, t.urls.length, 'every request sent was debited');
  assert.deepEqual(s.attempts.filter((a) => a.kind === DISCOVERY).map((a) => a.type), ['Decreto', 'Decreto', 'Decreto'], 'discovery debited on the declared type, recorded as discovery');
  assert.ok(s.used.perType.Decreto! <= 5 && s.used.total <= 15);
  assert.ok(!t.urls.some((u) => u.includes(G(2))), '2026 act never requested'); assert.ok(!t.urls.some((u) => u.includes(`publications/${G(5)}`)), 'stored act never requested');
  const dec = inv.decisions.find((d) => d.type === 'Decreto') as { kept: Record<string, string>; tried: { outcome: string }[]; reserved: string[] };
  assert.ok(dec.reserved.includes(G(2)));
  assert.equal(Object.keys(dec.kept).length, 1, 'both small decrees are pequeno: only one kept'); assert.match(dec.tried.map((x) => x.outcome).join('|'), /already kept/u);
  assert.equal(inv.actsKept, 2); assert.ok(existsSync(join(out, `${G(4)}.json`)));
  assert.equal(actKey(P2D_TYPES[0].key, P2D_TYPES[0].title, item(9, 'DECRETO Nº 70.843, DE 1º DE JANEIRO DE 2026', '', '2026-01-02T00:00:00')), 'decreto 70843/26');
});

test('P2-d: a discovery failure is debited and recorded, never read as absence; nothing captured', async () => {
  const f = budgetFile(); const out = mkdtempSync(join(tmpdir(), 'p2d-out-'));
  const t = (async () => json({ status: 500, error: 'x' }, 500)) as unknown as typeof fetch;
  const inv = await run(t, { grantId: 'G-D', owner: 'exec-304', date: '2025-03-10', budgetFile: f, outDir: out, now: NOW });
  assert.match(String(inv.discovery.outcome), /discovery failed: discovery HTTP 500 — debited, not read as absence/u);
  assert.equal(inv.actsKept, 0); assert.equal((JSON.parse(readFileSync(f, 'utf8')) as BudgetState).used.total, 1);
});
