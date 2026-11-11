import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ATT_BUDGET, ATT_PACKAGE, cli, pdfIdentityProblem, routeProblem, runAttachment, TARGET, targetProblem } from '../ops/anatomy/collect-p2c-attachment.js';
import type { BudgetState } from '../ops/anatomy/request-budget.js';
import { buildSyntheticPdf } from './support/synthetic-pdf.js';

// R4 C3-1: the injected preflight is a test seam honoured only under NODE_ENV=test (set here for this file's process).
process.env.NODE_ENV = 'test';
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
const opts = (f: string, extra: Record<string, unknown> = {}) => ({ grantId: 'G-PDF', owner: 'exec-303', budgetFile: f, outDir: mkdtempSync(join(tmpdir(), 'p2c-att-out-')), now: NOW, preflight: () => null, ...extra });

test('C1: the committed grant is SUSPENDED with its own ledger (1 request, SC 1) — the real run is refused before any request', async () => {
  const s = read(ATT_BUDGET);
  assert.deepEqual([s.grant!.grantId, s.grant!.status, s.grant!.total, s.grant!.perType, s.used.total, s.attempts.length, s.grant!.package],
    ['E9-P2c-PDF83325-G1', 'suspended', 1, { 'Solução de Consulta': 1 }, 0, 0, ATT_PACKAGE]);
  const t = never();
  await assert.rejects(runAttachment(t.f, { grantId: s.grant!.grantId, owner: s.grant!.owner, outDir: mkdtempSync(join(tmpdir(), 'x-')), preflight: () => null } as Parameters<typeof runAttachment>[1]), /suspended|not active/u);
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
    ['another act', () => pdfResp(buildSyntheticPdf([[{ text: 'SOLUÇÃO DE CONSULTA Nº 259 - COSIT', y: 760 }]])), /does not name the act \(heading is nº 259, not nº 258\)/u],
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
  assert.equal(pdfIdentityProblem([{ text: 'Solução de Consulta nº 258 - Cosit' }, { text: 'Data 26/12/2025' }]), null);
  assert.match(pdfIdentityProblem([{ text: 'Solução de Consulta Cosit nº 258' }])!, /first title line is not a Solução de Consulta Cosit heading/u, 'a mention without the heading form is not the act');
});

// ---- COORD correction before review (tribusca-control#116): hardening of the PDF route. These fail on 440bf24b. ----
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
const listen = (h: Parameters<typeof createServer>[1]) => new Promise<{ srv: Server; url: string; hits: () => number }>((ok) => {
  let n = 0; const srv = createServer((q, s) => { n++; h!(q, s); }); srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/`, hits: () => n }));
});
const close = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));

test('H1 (real transport, isolated): a 3xx to ANOTHER host is never followed — exactly 1 request, the other host gets 0, nothing stored', async () => {
  const other = await listen((_q, s) => { s.writeHead(200, { 'content-type': 'application/pdf' }); s.end(Buffer.from(PDF_OK)); });
  const first = await listen((_q, s) => { s.writeHead(302, { location: `${other.url}x.pdf` }); s.end(); });
  try {
    // the real (native) fetch, pointed at the local server instead of the Receita: no external contact
    const realToLocal = ((_u: string | URL, init?: RequestInit) => fetch(first.url, init)) as typeof fetch;
    const f = budget(); const o = opts(f);
    const r = await runAttachment(realToLocal, o);
    assert.deepEqual([first.hits(), other.hits(), r.requests, r.stored], [1, 0, 1, false]);
    assert.match(r.outcome, /redirect 302 .* not followed/u); assert.equal(read(f).used.total, 1);
    assert.equal(existsSync(join(o.outDir, '148681-83325.pdf')), false);
  } finally { await close(first.srv); await close(other.srv); }
});

test('H2: a transport that FOLLOWED a redirect by itself (response.redirected) is refused — the collector does not trust the transport', async () => {
  const f = budget(); const o = opts(f);
  const followed = transport(() => { const r = pdfResp(PDF_OK); Object.defineProperty(r, 'redirected', { value: true }); Object.defineProperty(r, 'url', { value: 'https://evil.example/x.pdf' }); return r; });
  const r = await runAttachment(followed.f, o);
  assert.equal(r.stored, false); assert.match(r.outcome, /followed a redirect/u);
  assert.equal(existsSync(join(o.outDir, '148681-83325.pdf')), false);
});

test('H3: the size limit is enforced WHILE reading — an endless body is cut just above the limit, never loaded whole', async () => {
  let pulled = 0; const MiB = 1024 * 1024; const chunk = new Uint8Array(MiB); chunk.set(Buffer.from('%PDF-1.7\n'));
  const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += MiB; if (pulled > 200 * MiB) { c.close(); return; } c.enqueue(chunk); } });
  const f = budget(); const t = transport(() => new Response(endless, { status: 200, headers: { 'content-type': 'application/pdf' } }));
  const r = await runAttachment(t.f, opts(f));
  assert.equal(r.stored, false); assert.match(r.outcome, /exceeds .* bytes while reading/u);
  assert.ok(pulled <= 20 * MiB + 2 * MiB, `pulled ${pulled / MiB} MiB (must stop near the 20 MiB limit)`);
});

test('H4: identity — another act that merely MENTIONS "Cosit" and "258" is refused; the heading must be SC nº 258 Cosit dated 26/12/2025', async () => {
  const mk = (lines: string[]) => buildSyntheticPdf([lines.map((text, i) => ({ text, y: 760 - i * 20 }))]);
  const bad: [string, string[]][] = [
    ['another SC citing 258', ['SOLUÇÃO DE CONSULTA Nº 259 - COSIT', 'Data 26 de dezembro de 2025', 'Conforme a Solução de Consulta Cosit nº 258, de 2025.']],
    ['right number, wrong date', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 2 de maio de 2024']],
    ['258 only in the body', ['PARECER NORMATIVO COSIT Nº 1', 'Data 26 de dezembro de 2025', 'Solução de Consulta 258 é citada aqui.']],
    ['another unit', ['SOLUÇÃO DE CONSULTA Nº 258 - SRRF08/DISIT', 'Data 26 de dezembro de 2025', 'COSIT mencionada']],
  ];
  for (const [why, lines] of bad) {
    const f = budget(); const t = transport(() => pdfResp(mk(lines))); const o = opts(f);
    const r = await runAttachment(t.f, o);
    assert.equal(r.stored, false, why); assert.match(r.outcome, /does not name the act/u, why);
  }
  const ok = await runAttachment(transport(() => pdfResp(mk(['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025', 'Assunto: IRRF']))).f, opts(budget()));
  assert.equal(ok.stored, true);
});

test('H5: a failure between the PDF and the meta writes leaves NO resource that looks valid; the next run refuses to treat it as stored', async () => {
  const f = budget(); const o = opts(f);
  mkdirSync(join(o.outDir, '148681-83325.meta.json')); // the meta write will fail (EISDIR) after the PDF write
  const r = await runAttachment(transport(() => pdfResp(PDF_OK)).f, o).catch((e: Error) => ({ requests: 1, stored: false, outcome: `threw: ${e.message}` }));
  assert.equal(r.stored, false);
  assert.equal(existsSync(join(o.outDir, '148681-83325.pdf')), false, 'no final PDF without its meta');
  const t2 = never(); const again = await runAttachment(t2.f, { ...o, budgetFile: budget() });
  assert.equal(t2.urls.length, 0); assert.doesNotMatch(again.outcome, /already stored/u, 'an incomplete write is never "already stored"');
  assert.match(again.outcome, /incomplete|inconsistent/u);
});

// ---- R2 (independent review c.6784793278, findings C-1…C-5). These reproduce the reviewer's counter-cases. ----
const mkPdf = (lines: string[]) => buildSyntheticPdf([lines.map((text, i) => ({ text, y: 760 - i * 20 }))]);
const runWith = async (lines: string[]) => runAttachment(transport(() => pdfResp(mkPdf(lines))).f, opts(budget()));

test('R2 C-1 (reviewer counter-cases): a document that is NOT the SC — but mentions it in its head — is refused', async () => {
  const cases: [string, string[]][] = [
    ['Solução de Divergência citing the SC', ['SOLUÇÃO DE DIVERGÊNCIA Nº 7 - COSIT', 'Data 26 de dezembro de 2025', 'Solução de Consulta nº 258 - Cosit, reformada por esta.']],
    ['Despacho citing the SC', ['DESPACHO', 'Data 26 de dezembro de 2025', 'Solução de Consulta nº 258 - Cosit']],
    ['SC heading, date only inside a publication note', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Publicada no DOU de 26/12/2025 a SC nº 1']],
    ['Parecer first', ['PARECER NORMATIVO Nº 3', 'Solução de Consulta nº 258 - Cosit', 'Data 26 de dezembro de 2025']],
    ['unknown first line', ['NOTA EXPLICATIVA', 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['correct title quoted as a reference', ['Conforme SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['year in title differs', ['SOLUÇÃO DE CONSULTA COSIT Nº 258, DE 26 DE DEZEMBRO DE 2024']],
  ];
  for (const [why, lines] of cases) { const r = await runWith(lines); assert.equal(r.stored, false, why); assert.match(r.outcome, /does not name the act/u, why); }
});

test('R2 C-2: legitimate, tested heading variants are accepted (the single request is not wasted)', async () => {
  const ok: [string, string[]][] = [
    ['date in title', ['SOLUÇÃO DE CONSULTA COSIT Nº 258, DE 26 DE DEZEMBRO DE 2025', 'Assunto: IRRF']],
    ['N.º', ['SOLUÇÃO DE CONSULTA N.º 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['institutional lines before the title', ['Receita Federal', 'Coordenação-Geral de Tributação', 'Solução de Consulta nº 258 - Cosit', 'Data 26 de dezembro de 2025']],
    ['Data: 26/12/2025', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data: 26/12/2025']],
  ];
  for (const [why, lines] of ok) { const r = await runWith(lines); assert.equal(r.stored, true, `${why}: ${r.outcome}`); }
});

test('R2 C-3: a final Response.url different from the pinned URL is refused even without redirected=true', async () => {
  const t = transport(() => { const r = pdfResp(PDF_OK); Object.defineProperty(r, 'url', { value: 'https://evil.example/x.pdf' }); return r; });
  const o = opts(budget()); const r = await runAttachment(t.f, o);
  assert.equal(r.stored, false); assert.match(r.outcome, /final URL .* differs from the pinned route/u);
  assert.equal(existsSync(join(o.outDir, '148681-83325.meta.json')), false);
});

test('R2 C-4: a stream error mid-body is an operational outcome (debited, nothing stored), never an unhandled rejection', async () => {
  const broken = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode('%PDF-1.7\n')); c.error(new Error('reset')); } });
  const f = budget(); const o = opts(f);
  const r = await runAttachment(transport(() => new Response(broken, { status: 200, headers: { 'content-type': 'application/pdf' } })).f, o);
  assert.equal(r.stored, false); assert.match(r.outcome, /stream error.*reset/u); assert.equal(read(f).used.total, 1);
});

test('R2 C-5: single-owner preflight — the local ledger must equal the pushed one, with no attempts, before the budget opens', async () => {
  const { ledgerPreflight } = await import('../ops/anatomy/collect-p2c-attachment.js');
  const clean = readFileSync(budget('active'), 'utf8');
  assert.equal(ledgerPreflight(clean, clean), null);
  assert.match(ledgerPreflight(clean, null)!, /cannot verify/u, 'no pushed copy → refuse');
  const used = JSON.stringify({ ...JSON.parse(clean), used: { total: 1, perType: { 'Solução de Consulta': 1 } } });
  assert.match(ledgerPreflight(clean, used)!, /differs from the pushed ledger/u, 'another copy consumed and pushed → refuse');
  assert.match(ledgerPreflight(used, used)!, /already has attempts|already used/u, 'a consumed grant is never reused');
  // the CLI runs the preflight BEFORE the budget opens (0 requests on refusal)
  const t = never();
  assert.equal(await cli(['--grant', 'G-PDF', '--owner', 'exec-303', '--stop-after', '1'], t.f, { preflight: () => 'ledger differs from the pushed ledger (test)' }), 3);
  assert.equal(t.urls.length, 0);
});

// ---- R3 (independent review R2 c.6785660153): C2-1 institutional lines, C2-2 split layouts, C-5 direct-call bypass ----
test('R3 C2-1: an institutional PREFIX mixed with another act title never precedes the SC title', async () => {
  const bad: [string, string[]][] = [
    ['Ministério + Despacho Decisório', ['MINISTÉRIO DA FAZENDA - DESPACHO DECISÓRIO Nº 1', 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['Coordenação + Solução de Divergência', ['Coordenação-Geral de Tributação — Solução de Divergência nº 7, que reforma a', 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['Secretaria + Parecer', ['Secretaria Especial da Receita Federal do Brasil - Parecer nº 3', 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['Receita Federal + número', ['Receita Federal Nº 9', 'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
  ];
  for (const [why, lines] of bad) { const r = await runWith(lines); assert.equal(r.stored, false, why); assert.match(r.outcome, /does not name the act/u, why); }
  // legitimate institutional head preserved
  const ok = await runWith(['MINISTÉRIO DA FAZENDA', 'Secretaria Especial da Receita Federal do Brasil', 'Subsecretaria de Tributação e Contencioso', 'Coordenação-Geral de Tributação',
    'SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data 26 de dezembro de 2025']);
  assert.equal(ok.stored, true, ok.outcome);
});

test('R3 C2-2: split title ("SOLUÇÃO DE CONSULTA" / "Nº 258 - COSIT") and split date ("Data" / "26 de dezembro de 2025") are accepted strictly', async () => {
  const ok: [string, string[]][] = [
    ['split title', ['SOLUÇÃO DE CONSULTA', 'Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['split date', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data', '26 de dezembro de 2025']],
    ['split title and date', ['SOLUÇÃO DE CONSULTA', 'N.º 258 - COSIT', 'Data:', '26/12/2025']],
  ];
  for (const [why, lines] of ok) { const r = await runWith(lines); assert.equal(r.stored, true, `${why}: ${r.outcome}`); }
  // the multi-line tolerance never reopens the attacks
  const bad: [string, string[]][] = [
    ['split title of a Divergência', ['SOLUÇÃO DE DIVERGÊNCIA', 'Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['split title, other number', ['SOLUÇÃO DE CONSULTA', 'Nº 259 - COSIT', 'Data 26 de dezembro de 2025']],
    ['split title, number line carries more', ['SOLUÇÃO DE CONSULTA', 'Nº 258 - COSIT, citada no Despacho nº 1', 'Data 26 de dezembro de 2025']],
    ['Despacho then split SC title', ['DESPACHO', 'SOLUÇÃO DE CONSULTA', 'Nº 258 - COSIT', 'Data 26 de dezembro de 2025']],
    ['split date, value is a sentence', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data', 'Publicada em 26 de dezembro de 2025']],
    ['split date, other year', ['SOLUÇÃO DE CONSULTA Nº 258 - COSIT', 'Data', '26 de dezembro de 2024']],
  ];
  for (const [why, lines] of bad) { const r = await runWith(lines); assert.equal(r.stored, false, why); }
});

test('R3 C-5: runAttachment called DIRECTLY applies the single-owner preflight by default (no bypass of the CLI check)', async () => {
  const f = budget(); const t = never();
  const { preflight: _skip, ...noStub } = opts(f) as Record<string, unknown>;
  const r = await runAttachment(t.f, noStub as Parameters<typeof runAttachment>[1]);
  assert.equal(t.urls.length, 0, 'nothing sent'); assert.equal(r.stored, false); assert.match(r.outcome, /preflight/u);
  assert.equal(read(f).used.total, 0, 'budget never opened');
});

// ---- R4 (review R3 C3-1): an injected preflight is honoured ONLY under NODE_ENV=test; elsewhere the default runs ----
test('R4 C3-1: outside NODE_ENV=test an injected preflight is ignored — the default single-owner preflight refuses with 0 requests', async () => {
  const prev = process.env.NODE_ENV;
  try {
    for (const env of ['production', 'development', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      const f = budget(); const t = never();
      const r = await runAttachment(t.f, opts(f, { preflight: () => null }));
      assert.equal(t.urls.length, 0, `${String(env)}: nothing sent`); assert.match(r.outcome, /preflight/u, String(env));
      assert.equal(read(f).used.total, 0, `${String(env)}: budget never opened`);
    }
    process.env.NODE_ENV = 'test';
    const ok = await runAttachment(transport(() => pdfResp(PDF_OK)).f, opts(budget(), { preflight: () => null }));
    assert.equal(ok.stored, true, 'under NODE_ENV=test the test seam works');
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});
