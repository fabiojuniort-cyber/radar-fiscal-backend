import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ATT_BUDGET, ATT_PACKAGE, cli, pdfIdentityProblem, routeProblem, runAttachment, TARGET, targetProblem } from '../ops/anatomy/collect-p2c-attachment.js';
import type { BudgetState } from '../ops/anatomy/request-budget.js';
import { buildSyntheticPdf } from './support/synthetic-pdf.js';

// E9 P2-c, COORD decision C (tribusca-control#116): exact one-shot route for the PDF 83325 of SC Cosit 258/2025.
// Simulated transport only: no request leaves this test.
const NOW = () => new Date('2026-11-11T12:00:00Z');
const ACT = readFileSync(TARGET.actJson);
const budget = (status = 'active', total = 1) => {
  const d = mkdtempSync(join(tmpdir(), 'p2c-att-')); const f = join(d, 'budget-state.json');
  writeFileSync(f, JSON.stringify({ schema: 'request-budget/1', grant: { grantId: 'G-PDF', owner: 'exec-303', package: ATT_PACKAGE, approvedBy: 'test', status,
    expiresAt: '2026-11-21T23:59:59Z', total, perType: { 'Solução de Consulta': total } }, used: { total: 0, perType: {} }, attempts: [] }));
  return f;
};
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as BudgetState;
const transport = (handler: (url: string, n: number) => Response) => {
  const urls: string[] = []; const f = (async (u: string | URL) => { const url = String(u); urls.push(url); return handler(url, urls.length); }) as unknown as typeof fetch; return { f, urls };
};
const never = () => transport(() => { throw new Error('must not be called'); });
const PDF_OK = buildSyntheticPdf([[{ text: 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', y: 760 }, { text: 'Data 26 de dezembro de 2025', y: 740 }, { text: 'Relatório', y: 720 }]]);
const pdfResp = (b: Uint8Array, status = 200) => new Response(b, { status, headers: { 'content-type': 'application/pdf' } });
const opts = (f: string, extra: Record<string, unknown> = {}) => ({ grantId: 'G-PDF', owner: 'exec-303', budgetFile: f, outDir: mkdtempSync(join(tmpdir(), 'p2c-att-out-')), now: NOW, ...extra });

test('C1: the committed grant is SUSPENDED with its own ledger (1 request, SC 1) — the real run is refused before any request', async () => {
  const s = read(ATT_BUDGET);
  assert.deepEqual([s.grant!.grantId, s.grant!.status, s.grant!.total, s.grant!.perType, s.used.total, s.attempts.length, s.grant!.package],
    ['E9-P2c-PDF83325-G1', 'suspended', 1, { 'Solução de Consulta': 1 }, 0, 0, ATT_PACKAGE]);
  const t = never();
  await assert.rejects(runAttachment(t.f, { grantId: s.grant!.grantId, owner: s.grant!.owner, outDir: mkdtempSync(join(tmpdir(), 'x-')) }), /suspended|not active/u);
  assert.equal(t.urls.length, 0);
});

test('C2: route guard — only the pinned URL; target identity from the preserved act; the struck PDF 82416 is never requested', () => {
  assert.equal(routeProblem(TARGET.url), null);
  for (const bad of ['http://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325',
    'https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=82416',
    'https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325&x=1',
    'https://normas.receita.fazenda.gov.br:8443/sijut2consulta/anexoOutros.action?idArquivoBinario=83325',
    'https://u:p@normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325',
    'https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325#f',
    'https://normasinternet2.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325',
    'https://www.gov.br/receitafederal'])
    assert.ok(routeProblem(bad), bad);
  assert.equal(targetProblem(ACT), null, 'the preserved act references 83325 in a live type-6 segment');
  assert.match(targetProblem(ACT, TARGET.historicalId)!, /struck \(tachado\)/u, 'the earlier PDF is history');
  assert.match(targetProblem(Buffer.concat([ACT, Buffer.from(' ')]))!, /differs from the pinned sha256/u);
});

test('C3: success — exactly 1 request, debited BEFORE the send, PDF named in its text layer, stored once with provenance', async () => {
  const f = budget(); const t = transport(() => pdfResp(PDF_OK)); const o = opts(f);
  const r = await runAttachment(t.f, o);
  assert.deepEqual([r.requests, r.stored, r.outcome, t.urls], [1, true, 'stored', [TARGET.url]]);
  const s = read(f); assert.deepEqual([s.used.total, s.attempts.length, s.attempts[0]!.kind, s.attempts[0]!.outcome], [1, 1, 'capture', 'HTTP 200']);
  const meta = JSON.parse(readFileSync(join(o.outDir, '148681-83325.meta.json'), 'utf8'));
  assert.deepEqual([meta.resourceId, meta.idArquivoBinario, meta.historicalAttachment.idArquivoBinario, meta.promoted], ['rfb:148681:anexo:83325', 83325, 82416, false]);
  assert.deepEqual(new Uint8Array(readFileSync(join(o.outDir, '148681-83325.pdf'))), PDF_OK, 'bytes verbatim');
  // a second run is refused before any request (already stored), and the budget stays at 1
  const t2 = never(); const again = await runAttachment(t2.f, { ...o, budgetFile: budget() });
  assert.deepEqual([again.requests, again.stored, t2.urls.length], [0, false, 0]); assert.match(again.outcome, /already stored/u);
});

test('C4: fail closed — redirect never followed, non-PDF, wrong identity, HTTP error and network error: 1 debited, nothing stored', async () => {
  const cases: [string, (u: string, n: number) => Response, RegExp][] = [
    ['302 to the same id', () => new Response(null, { status: 302, headers: { location: TARGET.url } }), /redirect 302 .* not followed/u],
    ['302 elsewhere', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.pdf' } }), /redirect 302/u],
    ['HTML error page', () => new Response('<html>erro</html>', { status: 200, headers: { 'content-type': 'text/html' } }), /not a PDF/u],
    ['another act', () => pdfResp(buildSyntheticPdf([[{ text: 'SOLUÇÃO DE CONSULTA Nº 259 - COSIT', y: 760 }]])), /does not name the act \(nº 258/u],
    ['HTTP 500', () => new Response('x', { status: 500 }), /HTTP 500/u],
    ['network error', () => { throw new TypeError('fetch failed'); }, /failed/u],
  ];
  for (const [why, h, re] of cases) {
    const f = budget(); const t = transport(h); const o = opts(f);
    const r = await runAttachment(t.f, o);
    assert.equal(t.urls.length, 1, `${why}: exactly one request sent`); assert.equal(r.stored, false, why); assert.match(r.outcome, re, why);
    assert.equal(read(f).used.total, 1, `${why}: the one request is debited`);
    assert.equal(existsSync(join(o.outDir, '148681-83325.pdf')), false, `${why}: nothing stored`);
  }
});

test('C5: the CLI requires --stop-after 1 and refuses before opening the budget; the grant total caps a second attempt', async () => {
  for (const argv of [[], ['--grant', 'G'], ['--grant', 'G', '--owner', 'o'], ['--grant', 'G', '--owner', 'o', '--stop-after', '2']]) {
    const t = never(); assert.equal(await cli(argv, t.f), 2); assert.equal(t.urls.length, 0);
  }
  const f = budget('active', 1); await runAttachment(transport(() => new Response('x', { status: 500 })).f, opts(f));
  const t = never(); await assert.rejects(runAttachment(t.f, opts(f)), /remaining|exceeds|exhausted|more than/u, 'the single request is spent');
  assert.equal(t.urls.length, 0);
  assert.equal(pdfIdentityProblem([{ text: 'Solução de Consulta Cosit nº 258' }]), null);
});
