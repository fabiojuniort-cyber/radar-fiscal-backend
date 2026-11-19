import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRefused, RequestBudget, type BudgetState } from '../ops/anatomy/request-budget.js';
import { BUDGET_FILE, P2C_PACKAGE, run as runP2c } from '../ops/anatomy/collect-p2c.js';
import { consultOfficial, type FetchLike } from '../ops/anatomy/fetch-official-core.js';

// R2 of #303 (c.6708499687): the request budget fails closed, debits before every send and never reuses balance.
// Simulated transport only — no real request.
const NOW = () => new Date('2026-11-07T12:00:00Z');
const grant = (over: Record<string, unknown> = {}) => ({ grantId: 'G-1', owner: 'exec-303', package: P2C_PACKAGE, approvedBy: '#116 c.x', status: 'active',
  expiresAt: '2026-11-08T00:00:00Z', total: 3, perType: { Portaria: 2, 'Solução de Consulta': 1 }, ...over });
const state = (g: unknown = grant(), used = { total: 0, perType: {} }, attempts: unknown[] = []) => ({ schema: 'request-budget/1', grant: g, used, attempts });
const fileWith = (content: unknown | string) => { const d = mkdtempSync(join(tmpdir(), 'budget-')); const f = join(d, 'budget-state.json');
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); return f; };
const who = (requested = 1, over: Record<string, unknown> = {}) => ({ grantId: 'G-1', owner: 'exec-303', package: P2C_PACKAGE, requested: { total: requested }, ...over });
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as BudgetState;
const fakeFetch = (impl: (n: number) => Response | Promise<Response>) => { let calls = 0; const f = (async () => impl(++calls)) as unknown as typeof fetch; return { f, calls: () => calls }; };

test('budget refuses (fail closed) when the state is missing, not JSON or schema-invalid', () => {
  const d = mkdtempSync(join(tmpdir(), 'budget-'));
  assert.throws(() => RequestBudget.open(join(d, 'nope.json'), who(), NOW), /missing/u);
  assert.throws(() => RequestBudget.open(fileWith('{not json'), who(), NOW), /not valid JSON/u);
  for (const bad of [{ ...state(), schema: 'x' }, state(grant(), { total: Number.NaN, perType: {} }), state(grant(), { total: 1, perType: {} }, []),
    state(grant({ total: '3' })), state(grant({ perType: {} })), state(grant({ expiresAt: 'soon' })), state(grant({ status: 'open' })), [] as unknown])
    assert.throws(() => RequestBudget.open(fileWith(bad), who(), NOW), /invalid/u);
});

test('budget refuses without an exact active grant: none, suspended, closed, expired, other owner/grant/package', () => {
  assert.throws(() => RequestBudget.open(fileWith(state(null)), who(), NOW), /no grant/u);
  assert.throws(() => RequestBudget.open(fileWith(state(grant({ status: 'suspended' }))), who(), NOW), /suspended/u);
  assert.throws(() => RequestBudget.open(fileWith(state(grant({ status: 'closed' }))), who(), NOW), /closed/u);
  assert.throws(() => RequestBudget.open(fileWith(state(grant({ expiresAt: '2026-11-07T11:59:59Z' }))), who(), NOW), /expired/u);
  for (const over of [{ owner: 'other' }, { grantId: 'G-2' }, { package: 'other' }]) assert.throws(() => RequestBudget.open(fileWith(state()), who(1, over), NOW), /differs/u);
});

test('budget refuses a request larger than the remaining balance (25 requested on a grant of 3 / per-type cap)', () => {
  assert.throws(() => RequestBudget.open(fileWith(state()), who(25), NOW), /exceeds the remaining 3/u);
  assert.throws(() => RequestBudget.open(fileWith(state()), { ...who(2), requested: { total: 2, perType: { 'Solução de Consulta': 2 } } }, NOW), /exceeds its remaining cap/u);
  assert.throws(() => RequestBudget.open(fileWith(state()), { ...who(1), requested: { total: 1, perType: { ADE: 1 } } }, NOW), /not in grant/u);
  assert.throws(() => RequestBudget.open(fileWith(state()), who(0), NOW), /positive integer/u);
});

test('every attempt is debited and persisted BEFORE it is sent; a failing fetch stays debited with its outcome', async () => {
  const f = fileWith(state()); const b = RequestBudget.open(f, who(2), NOW);
  let seenBefore = -1;
  const failing = (async () => { seenBefore = read(f).used.total; throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  await assert.rejects(b.fetcher('Portaria', 'capture', failing)('https://x/1'), /ECONNRESET/u);
  assert.equal(seenBefore, 1, 'the debit was on disk before the send');
  const timeout = (async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;
  await assert.rejects(b.fetcher('Portaria', 'capture', timeout)('https://x/2'));
  b.close();
  const s = read(f);
  assert.deepEqual([s.used.total, s.used.perType.Portaria], [2, 2]);
  assert.deepEqual(s.attempts.map((a) => [a.state, a.outcome!.split(':')[0]]), [['settled', 'error'], ['settled', 'timeout']]);
});

test('a second run never reuses balance; counters are monotonic; the per-type cap holds inside a run', async () => {
  const f = fileWith(state()); const ok = fakeFetch(() => new Response('{}', { status: 200 }));
  const b1 = RequestBudget.open(f, who(2), NOW);
  await b1.fetcher('Portaria', 'search', ok.f)('https://x/s'); await b1.fetcher('Portaria', 'capture', ok.f)('https://x/c');
  await assert.rejects(b1.fetcher('Portaria', 'capture', ok.f)('https://x/c2'), BudgetRefused, 'per-type cap 2');
  b1.close(); assert.equal(ok.calls(), 2, 'the refused attempt was never sent');
  assert.throws(() => RequestBudget.open(f, who(2), NOW), /exceeds the remaining 1/u, 'run 2 cannot take the same balance');
  const b2 = RequestBudget.open(f, { ...who(1), requested: { total: 1, perType: { 'Solução de Consulta': 1 } } }, NOW);
  await b2.fetcher('Solução de Consulta', 'search', ok.f)('https://x/sc'); b2.close();
  const s = read(f); assert.deepEqual([s.used.total, s.attempts.map((a) => a.n)], [3, [1, 2, 3]]);
  assert.throws(() => RequestBudget.open(f, who(1), NOW), /exceeds the remaining 0/u);
});

test('redirects are counted hop by hop and never followed implicitly', async () => {
  const f = fileWith(state(grant({ total: 3, perType: { Portaria: 3 } })));
  const b = RequestBudget.open(f, { ...who(3), requested: { total: 3, perType: { Portaria: 3 } } }, NOW);
  const json = JSON.stringify({ idAto: 1, epigrafeCompleta: 'x', ementas: [], outrosSegmentos: [] });
  const t = fakeFetch((n) => (n === 1 ? new Response(null, { status: 302, headers: { location: 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/1/visao/multivigente' } })
    : new Response(json, { status: 200, headers: { 'content-type': 'application/json' } })));
  const seen: string[] = [];
  const spy = (async (url: string, init: RequestInit) => { seen.push(String(init.redirect)); return t.f(url, init); }) as unknown as typeof fetch;
  await consultOfficial({ id: '1', source: 'RFB', act: 'x', url: 'https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/1/visao/original', urlStatus: 'candidate', reason: 't' },
    ['normasinternet2.receita.fazenda.gov.br'], b.fetcher('Portaria', 'capture', spy) as unknown as FetchLike);
  b.close();
  const s = read(f);
  assert.equal(t.calls(), 2); assert.equal(s.used.total, 2, 'each hop is one debited attempt');
  assert.match(s.attempts[0]!.outcome!, /^redirect 302 → \S+ \(not followed/u); assert.deepEqual(seen, ['manual', 'manual']);
});

test('lease: a concurrent/re-entrant open is refused; a crash leaves the lock and the debited attempt until a person inspects', async () => {
  const f = fileWith(state()); const b = RequestBudget.open(f, who(1), NOW);
  assert.throws(() => RequestBudget.open(f, who(1), NOW), /lease/u, 're-entrant open refused');
  b.debit('Portaria', 'capture', 'https://x/crash'); // crash simulated: no settle, no close
  assert.throws(() => RequestBudget.open(f, who(1), NOW), /lease/u, 'stale lock is never broken automatically');
  unlinkSync(`${f}.lock`);
  const s = read(f); assert.deepEqual([s.used.total, s.attempts[0]!.state], [1, 'sent'], 'the crashed attempt stays counted');
  assert.throws(() => RequestBudget.open(f, who(3), NOW), /exceeds the remaining 2/u);
});

test('the P2-c collector, with the repository budget (grant G1 of 16, SUSPENDED until the independent PASS), refuses before any request — the 28/25 ledger is not a budget', async () => {
  const g = read(BUDGET_FILE).grant!; assert.deepEqual([g.grantId, g.status, g.total, Object.values(g.perType).reduce((a, b) => a + b, 0)], ['E9-P2c-G1', 'suspended', 16, 16]);
  let calls = 0; const spy = (async () => { calls++; throw new Error('must not be called'); }) as unknown as typeof fetch;
  await assert.rejects(runP2c(spy, { grantId: 'E9-P2c-G1', owner: g.owner }), /suspended/u);
  assert.equal(calls, 0); assert.equal(existsSync(`${BUDGET_FILE}.lock`), false);
});

test('year filter (option b): if the API still returns 2026 acts the type stops without another attempt', async () => {
  const f = fileWith(state(grant({ total: 4, perType: { 'Ato Declaratório Executivo': 4 } })));
  const t = fakeFetch(() => new Response(JSON.stringify({ atos: [{ idAto: 9, numeroAto: '1', anoAto: '2026', tipoAto: { nomeTipoAto: 'Ato Declaratório Executivo' }, ementa: 'x', internet: '1' }] }), { status: 200 }));
  const out = mkdtempSync(join(tmpdir(), 'p2c-'));
  const inv = await runP2c(t.f, { grantId: 'G-1', owner: 'exec-303', budgetFile: f, outDir: out, only: ['ade'], plan: { ade: 4 }, now: NOW });
  assert.equal(t.calls(), 1, 'only the search was sent'); assert.match(String(inv.decisions[0]!.outcome), /year filter NOT applied/u);
  assert.equal(read(f).used.total, 1);
});

// R3 of #303 (c.6709334225): lease before read; refused open releases its lease; closed instance; re-validation per send.
test('R3: the lease is taken BEFORE the state is read — a concurrent open is refused and the run decides on the fresh state', () => {
  const f = fileWith(state());
  let inside = false;
  const b = RequestBudget.open(f, who(1), NOW, () => {
    inside = true;
    assert.equal(existsSync(`${f}.lock`), true, 'lease held before the read');
    assert.throws(() => RequestBudget.open(f, who(1), NOW), /lease/u, 'a concurrent open during the read is refused');
    // A run that consumed balance just before this read (simulated write): the open must see it, never a stale snapshot.
    const s = read(f); s.used = { total: 2, perType: { Portaria: 2 } };
    s.attempts = [1, 2].map((n) => ({ n, type: 'Portaria', kind: 'capture', url: `https://x/${n}`, debitedAt: NOW().toISOString(), state: 'settled', outcome: 'HTTP 200', settledAt: NOW().toISOString() }));
    writeFileSync(f, JSON.stringify(s));
  });
  assert.ok(inside); assert.equal(b.remaining(), 1, 'remaining computed from the state read under the lease');
  assert.throws(() => b.debit('Portaria', 'capture', 'https://x/3'), /cap for Portaria exhausted/u, 'per-type cap from the fresh state');
  b.close();
});

test('R3: a refused open releases the lease it took, and never removes a lease it did not take', () => {
  const f = fileWith(state());
  assert.throws(() => RequestBudget.open(f, who(25), NOW), /exceeds the remaining 3/u);
  assert.equal(existsSync(`${f}.lock`), false, 'no lock left by a refused open');
  const g = fileWith(state(grant({ status: 'suspended' })));
  assert.throws(() => RequestBudget.open(g, who(1), NOW), /suspended/u); assert.equal(existsSync(`${g}.lock`), false);
  writeFileSync(`${f}.lock`, '{"owner":"someone else"}');
  assert.throws(() => RequestBudget.open(f, who(1), NOW), /lease/u); assert.equal(existsSync(`${f}.lock`), true, 'a foreign lock is kept');
  unlinkSync(`${f}.lock`);
  RequestBudget.open(f, who(1), NOW).close();
});

test('R3: a closed budget refuses every later debit, settle and send — zero network, ledger preserved', async () => {
  const f = fileWith(state()); const b = RequestBudget.open(f, who(2), NOW);
  const ok = fakeFetch(() => new Response('{}', { status: 200 }));
  const send = b.fetcher('Portaria', 'capture', ok.f);
  await send('https://x/1'); b.close();
  const before = readFileSync(f, 'utf8');
  assert.throws(() => b.debit('Portaria', 'capture', 'https://x/2'), /closed/u);
  assert.throws(() => b.settle(1, 'HTTP 200'), /closed/u);
  assert.throws(() => b.fetcher('Portaria', 'capture', ok.f), /closed/u);
  await assert.rejects(send('https://x/3'), /closed/u, 'a fetcher obtained before close cannot send either');
  assert.equal(ok.calls(), 1); assert.equal(readFileSync(f, 'utf8'), before, 'ledger unchanged after close');
});

test('R3: before every send the grant is re-validated on disk — suspended, expired or externally changed state refuses with zero network', async () => {
  const ok = fakeFetch(() => new Response('{}', { status: 200 }));
  const f = fileWith(state()); const b = RequestBudget.open(f, who(2), NOW);
  const s = read(f); s.grant!.status = 'suspended'; writeFileSync(f, JSON.stringify(s));
  await assert.rejects(b.fetcher('Portaria', 'capture', ok.f)('https://x/1'), /suspended/u); b.close();
  let t = NOW(); const clock = () => t;
  const g = fileWith(state()); const c = RequestBudget.open(g, who(2), clock);
  t = new Date('2026-11-08T00:00:01Z');
  await assert.rejects(c.fetcher('Portaria', 'capture', ok.f)('https://x/2'), /expired/u); c.close();
  const h = fileWith(state()); const d = RequestBudget.open(h, who(2), NOW);
  const x = read(h); x.used = { total: 1, perType: { Portaria: 1 } }; x.attempts = [{ n: 1, type: 'Portaria', kind: 'capture', url: 'https://x/z', debitedAt: NOW().toISOString(), state: 'sent', outcome: null, settledAt: null }]; writeFileSync(h, JSON.stringify(x));
  await assert.rejects(d.fetcher('Portaria', 'capture', ok.f)('https://x/3'), /changed outside this run/u); d.close();
  assert.equal(ok.calls(), 0, 'nothing was sent');
});

test('R4: acts already stored by an earlier session are skipped BEFORE any capture (no wasted request, no failed exclusive write)', async () => {
  const f = fileWith(state(grant({ total: 3, perType: { Portaria: 3 } })));
  const out = mkdtempSync(join(tmpdir(), 'p2c-'));
  writeFileSync(join(out, '142967.json'), '{"stored":"earlier session"}');
  const act = (idAto: number, ementa: string) => ({ idAto, numeroAto: String(idAto), anoAto: '2025', tipoAto: { nomeTipoAto: 'Portaria' }, ementa, internet: '1' });
  const urls: string[] = [];
  const t = (async (url: string) => { urls.push(String(url));
    return String(url).includes('/indexacao/') ? new Response(JSON.stringify({ atos: [act(142967, 'x'.repeat(300)), act(5, 'y')] }), { status: 200 }) : new Response('{}', { status: 404 }); }) as unknown as typeof fetch;
  const inv = await runP2c(t, { grantId: 'G-1', owner: 'exec-303', budgetFile: f, outDir: out, only: ['portaria'], plan: { portaria: 3 }, now: NOW });
  assert.ok(!urls.some((u) => u.includes('/ato/142967/')), 'the stored act was never requested');
  assert.deepEqual((inv.decisions[0] as { alreadyStored: number[] }).alreadyStored, [142967]);
  assert.equal(readFileSync(join(out, '142967.json'), 'utf8'), '{"stored":"earlier session"}', 'stored bytes untouched');
  assert.equal(read(f).used.total, urls.length, 'every request sent was debited');
});
