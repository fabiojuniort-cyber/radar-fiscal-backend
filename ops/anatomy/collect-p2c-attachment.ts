/**
 * E9 P2-c — exact route for ONE official RFB attachment: the PDF that holds the body of the Solução de Consulta Cosit
 * nº 258/2025 (idAto 148681, idArquivoBinario 83325). COORD decision C (tribusca-control#116 c.6783692588 → decisões).
 *
 * Fail closed, offline until a reviewed and specifically authorized grant is ACTIVE:
 * - The target is not free input: it is checked against the PRESERVED act JSON (rfb-p2c/148681.json, sha256 pinned):
 *   the referencing segment must be live (not tachado), of type 6 (PDF) and carry exactly this id and file name. The
 *   struck earlier PDF (82416) is history and is NEVER requested.
 * - ONE exact URL (the connector's own form): https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action
 *   ?idArquivoBinario=83325 — no other host, path, query, port, credentials or fragment. A redirect is never followed:
 *   it is recorded and the run stops (one shot). A second call is refused before it is sent.
 * - Its own grant (E9-P2c-PDF83325-G1, total 1, Solução de Consulta 1) in its own ledger; every request is DEBITED AND
 *   PERSISTED BEFORE it is sent (RequestBudget). The P2-c G1 balance is not used.
 * - The response must be HTTP 200, start with %PDF-, be ≤ 20 MiB and its text layer (ANAT-PDF-01 extraction) must
 *   name the act: "SOLUÇÃO DE CONSULTA", "COSIT" and nº 258. Anything else is debited and NOT stored.
 * - Bytes are stored verbatim with exclusive creation (never overwritten) + a meta with provenance and page coverage.
 * Usage (only after review + activation): npx tsx ops/anatomy/collect-p2c-attachment.ts --grant E9-P2c-PDF83325-G1
 *   --owner 'EXEC #303 (claude/anat-e9-coverage)' --stop-after 1
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetRefused, RequestBudget } from './request-budget.js';
import { extractPdfLines } from '../../src/modules/anatomy/pdf-reader.js';

const ROOT = fileURLToPath(new URL('./official-identification/', import.meta.url));
export const ATT_DIR = join(ROOT, 'rfb-p2c-attachment');
export const ATT_BUDGET = join(ATT_DIR, 'budget-state.json');
export const ATT_PACKAGE = 'E9-P2-c-anexo-PDF';
export const TARGET = Object.freeze({
  idAto: 148681, idArquivoBinario: 83325, type: 'Solução de Consulta', fileName: 'SC Cosit nº 258-2025.pdf', historicalId: 82416,
  actJson: join(ROOT, 'rfb-p2c', '148681.json'), actSha256: 'd74c8f46b782cb63624ffa02f1f0ac4c575d73dc25a16e6dc7fb69ab4dbdc2c9',
  url: 'https://normas.receita.fazenda.gov.br/sijut2consulta/anexoOutros.action?idArquivoBinario=83325',
});
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** The route guard: exactly the pinned URL, nothing else (refused BEFORE sending). */
export function routeProblem(url: string): string | null {
  let u: URL; try { u = new URL(url); } catch { return 'not a URL'; }
  if (u.href !== TARGET.url) return `not the pinned attachment route (${u.href})`;
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash) return 'scheme/port/credentials/fragment not allowed';
  return null;
}

/** Offline identity of the target, from the preserved act JSON. Returns null when the act really references it. */
export function targetProblem(actBytes: Buffer, idArquivoBinario: number = TARGET.idArquivoBinario): string | null {
  if (sha(actBytes) !== TARGET.actSha256) return 'preserved act JSON differs from the pinned sha256';
  const r = JSON.parse(actBytes.toString('utf8')) as { idAto?: number; outrosSegmentos?: { tachado?: boolean; arquivoBinario?: { idArquivoBinario?: number; idTipoArquivo?: number; nomeArquivoBinario?: string } | null }[] };
  if (r.idAto !== TARGET.idAto) return `act is ${String(r.idAto)}, not ${TARGET.idAto}`;
  const seg = (r.outrosSegmentos ?? []).find((s) => s.arquivoBinario?.idArquivoBinario === idArquivoBinario);
  if (!seg) return `act does not reference attachment ${idArquivoBinario}`;
  if (seg.tachado === true) return `attachment ${idArquivoBinario} is in a struck (tachado) segment: historical, never requested`;
  if (seg.arquivoBinario?.idTipoArquivo !== 6) return `attachment ${idArquivoBinario} is not a PDF (idTipoArquivo ${String(seg.arquivoBinario?.idTipoArquivo)})`;
  if (seg.arquivoBinario?.nomeArquivoBinario !== TARGET.fileName) return `file name differs (${String(seg.arquivoBinario?.nomeArquivoBinario)})`;
  return idArquivoBinario === TARGET.idArquivoBinario ? null : 'only the pinned attachment may be requested';
}

/**
 * R2 (review C-1/C-2): the identity is shown by the STRUCTURE of the document, not by isolated words.
 * - The head is page 1. Before the title, only institutional lines are allowed (Ministério…, Secretaria…, Receita
 *   Federal…, Coordenação…, Subsecretaria…). The FIRST non-institutional line must be the title; anything else
 *   (Solução de Divergência, Despacho, Parecer, Nota, a sentence quoting the SC…) refuses.
 * - Accepted title forms (and only these, each tested):
 *     "SOLUÇÃO DE CONSULTA Nº 258 - COSIT"            (nº | n.º | n° | no; "-" | "–" | "—")
 *     "SOLUÇÃO DE CONSULTA COSIT Nº 258, DE 26 DE DEZEMBRO DE 2025"
 *     "SOLUÇÃO DE CONSULTA Nº 258" + next line exactly "COSIT"
 * - Number 258, unit COSIT, year 2025 and date 26/12/2025 must all match: the date either inside the title (form 2) or
 *   on a DATE LINE ("Data 26 de dezembro de 2025" / "Data: 26/12/2025") right after the title (after the COSIT line in
 *   form 3). A date only inside other text ("Publicada no DOU de 26/12/2025…") does not count.
 * Unknown layouts refuse (fail closed).
 */
const HEAD_LINES = 12;
/**
 * R3 (review C2-1): an institutional line must match a KNOWN form in full (accents, case and dash variants folded) —
 * a prefix such as "MINISTÉRIO DA FAZENDA - DESPACHO DECISÓRIO Nº 1" is NOT institutional.
 */
const INSTITUTIONAL_FORMS = new Set(['MINISTERIO DA FAZENDA', 'MINISTERIO DA ECONOMIA', 'SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL',
  'SECRETARIA DA RECEITA FEDERAL DO BRASIL', 'RECEITA FEDERAL', 'RECEITA FEDERAL DO BRASIL', 'SUBSECRETARIA DE TRIBUTACAO E CONTENCIOSO',
  'COORDENACAO-GERAL DE TRIBUTACAO']);
const foldLine = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s*[-–—]\s*/gu, '-').replace(/\s+/gu, ' ').trim();
const isInstitutional = (t: string) => INSTITUTIONAL_FORMS.has(foldLine(t));
const NUM = String.raw`N\s*(?:\.\s*)?[º°o]\.?\s*`;
const DASH = String.raw`\s*[-–—]\s*`;
const DATE_WORDS = String.raw`26\s+DE\s+DEZEMBRO\s+DE\s+(\d{4})`;
const TITLE_A = new RegExp(String.raw`^SOLU[ÇC][ÃA]O\s+DE\s+CONSULTA\s+${NUM}(\d+)${DASH}COSIT$`, 'iu');
const TITLE_B = new RegExp(String.raw`^SOLU[ÇC][ÃA]O\s+DE\s+CONSULTA\s+COSIT\s+${NUM}(\d+)\s*,\s*DE\s+${DATE_WORDS}$`, 'iu');
const TITLE_C = new RegExp(String.raw`^SOLU[ÇC][ÃA]O\s+DE\s+CONSULTA\s+${NUM}(\d+)$`, 'iu');
// R3 C2-2: strictly split layouts — "SOLUÇÃO DE CONSULTA" alone, then a line that is EXACTLY "Nº 258 - COSIT";
// "Data" alone, then a line that is EXACTLY the date.
const TITLE_ONLY = /^SOLU[ÇC][ÃA]O\s+DE\s+CONSULTA$/iu;
const NUM_LINE = new RegExp(String.raw`^${NUM}(\d+)${DASH}COSIT$`, 'iu');
const DATE_LABEL = /^DATA\s*:?$/iu;
const DATE_VALUE = /^(?:26\s+DE\s+DEZEMBRO\s+DE\s+(\d{4})|26\/12\/(\d{4}))$/iu;
const DATE_LINE = /^DATA\s*:?\s*(?:26\s+DE\s+DEZEMBRO\s+DE\s+(\d{4})|26\/12\/(\d{4}))$/iu;
export function pdfIdentityProblem(lines: { text: string; page?: number }[]): string | null {
  const why = (w: string) => `the PDF text does not name the act (${w})`;
  const head = lines.filter((l) => (l.page ?? 1) === 1).map((l) => l.text.normalize('NFC').replace(/\s+/gu, ' ').trim()).filter(Boolean).slice(0, HEAD_LINES);
  let t = 0; while (t < head.length && isInstitutional(head[t]!)) t++;
  const title = head[t];
  if (!title) return why('no title line on page 1');
  let num: string | undefined; let year: string | undefined; let next = t + 1;
  const a = TITLE_A.exec(title); const b = TITLE_B.exec(title); const c = TITLE_C.exec(title);
  if (a) num = a[1];
  else if (b) { num = b[1]; year = b[2]; }
  else if (c && /^COSIT$/iu.test(head[t + 1] ?? '')) { num = c[1]; next = t + 2; }
  else if (TITLE_ONLY.test(title) && NUM_LINE.test(head[t + 1] ?? '')) { num = NUM_LINE.exec(head[t + 1]!)![1]; next = t + 2; }
  else return why(`first title line is not a Solução de Consulta Cosit heading ("${title.slice(0, 60)}")`);
  if (num !== '258') return why(`heading is nº ${num}, not nº 258`);
  if (!year) {
    const d = DATE_LINE.exec(head[next] ?? '');
    const split = !d && DATE_LABEL.test(head[next] ?? '') ? DATE_VALUE.exec(head[next + 1] ?? '') : null;
    if (!d && !split) return why('no date line (Data 26/12/2025) right after the heading');
    year = d ? (d[1] ?? d[2]) : (split![1] ?? split![2]);
  }
  if (year !== '2025') return why(`act year ${year}, not 2025`);
  if (head.slice(t + 1).some((x) => /^SOLU[ÇC][ÃA]O\s+DE\s+(CONSULTA|DIVERG[ÊE]NCIA)\s+/iu.test(x))) return why('a second Solução heading in the head');
  return null;
}

/**
 * R2 (review C-5): single owner, single ledger. The lease only coordinates ONE ledger file, so two independent copies
 * could each spend the grant. Activation protocol: (1) the owner commits the activation of the ledger and PUSHES it;
 * (2) right before the run, the CLI fetches the branch and compares the local ledger with the pushed one; (3) after the
 * run the owner commits and pushes the consumed ledger. The preflight refuses when the pushed copy cannot be read, when
 * it differs from the local one (another copy consumed it, or an unpushed local change), or when the grant already has
 * attempts. No distributed lock is introduced (none is authorized).
 */
export function ledgerPreflight(local: string, pushed: string | null): string | null {
  if (pushed === null) return 'cannot verify the pushed ledger (fetch it first): refused';
  if (local !== pushed) return 'local ledger differs from the pushed ledger (another copy may have consumed it, or a change is unpushed): refused';
  const s = JSON.parse(local) as { used?: { total?: number }; attempts?: unknown[] };
  if ((s.used?.total ?? 0) > 0 || (s.attempts ?? []).length > 0) return 'the grant already has attempts / was already used: refused';
  return null;
}
export function gitPushedLedger(file: string): string | null {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['fetch', '-q', 'origin', branch], { stdio: 'ignore' });
    const rel = execFileSync('git', ['ls-files', '--full-name', file], { encoding: 'utf8' }).trim();
    return rel ? execFileSync('git', ['show', `origin/${branch}:${rel}`], { encoding: 'utf8' }) : null;
  } catch { return null; }
}

/** Valid stored resource = final PDF + final meta whose sha256/bytes match the PDF. Anything else is not stored. */
export function storedResource(outDir: string): { sha256: string } | null {
  const base = `${TARGET.idAto}-${TARGET.idArquivoBinario}`;
  const pdf = join(outDir, `${base}.pdf`); const meta = join(outDir, `${base}.meta.json`);
  if (!existsSync(pdf) || !existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as { sha256?: string; bytes?: number }; const b = readFileSync(pdf);
    return m.sha256 === sha(b) && m.bytes === b.byteLength ? { sha256: m.sha256 } : null;
  } catch { return null; }
}
const leftovers = (outDir: string) => {
  const base = `${TARGET.idAto}-${TARGET.idArquivoBinario}`;
  return [`${base}.pdf`, `${base}.meta.json`, `${base}.pdf.partial`, `${base}.meta.json.partial`].filter((f) => existsSync(join(outDir, f)));
};

/** Reads the body with the size cap enforced WHILE reading; never buffers more than max + one chunk. */
async function readCapped(r: Response, max: number): Promise<{ body: Uint8Array } | { over: number }> {
  if (!r.body) return { body: new Uint8Array(0) };
  const reader = r.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => undefined); return { over: n }; }
    parts.push(value);
  }
  const body = new Uint8Array(n); let o = 0; for (const p of parts) { body.set(p, o); o += p.byteLength; }
  return { body };
}

export interface AttachmentRun { requests: number; stored: boolean; outcome: string; sha256?: string; bytes?: number; pages?: number }

export async function runAttachment(doFetch: typeof fetch, opts: { grantId: string; owner: string; budgetFile?: string; outDir?: string; actJson?: Buffer; now?: () => Date;
  /** R3 C-5: single-owner preflight, applied on EVERY path (CLI or direct call). Default: local ledger = pushed ledger, unused. */
  preflight?: () => string | null }): Promise<AttachmentRun> {
  const outDir = opts.outDir ?? ATT_DIR;
  const base = `${TARGET.idAto}-${TARGET.idArquivoBinario}`;
  // Offline screening: nothing below sends a request.
  const ledger = opts.budgetFile ?? ATT_BUDGET;
  const pre = (opts.preflight ?? (() => { try { return ledgerPreflight(readFileSync(ledger, 'utf8'), gitPushedLedger(ledger)); } catch (e) { return `ledger unreadable (${(e as Error).message.slice(0, 80)})`; } }))();
  if (pre) return { requests: 0, stored: false, outcome: `refused before request: preflight — ${pre}` };
  const act = opts.actJson ?? readFileSync(TARGET.actJson);
  const tp = targetProblem(act); if (tp) return { requests: 0, stored: false, outcome: `refused before request: ${tp}` };
  const rp = routeProblem(TARGET.url); if (rp) return { requests: 0, stored: false, outcome: `refused before request: ${rp}` };
  if (storedResource(outDir)) return { requests: 0, stored: false, outcome: 'refused before request: already stored (bytes kept by an earlier run)' };
  const left = existsSync(outDir) ? leftovers(outDir) : [];
  if (left.length) return { requests: 0, stored: false, outcome: `refused before request: incomplete or inconsistent earlier write (${left.join(', ')}): inspect before any new request` };
  const budget = RequestBudget.open(opts.budgetFile ?? ATT_BUDGET, { grantId: opts.grantId, owner: opts.owner, package: ATT_PACKAGE,
    requested: { total: 1, perType: { [TARGET.type]: 1 } } }, opts.now);
  let sent = 0;
  try {
    const debited = budget.fetcher(TARGET.type, 'capture', doFetch);
    // One shot: a second call (e.g. a redirect hop) is refused before it is sent; the route is re-checked per call.
    const oneShot = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const why = sent > 0 ? 'one shot: a second request is never sent' : routeProblem(url);
      if (why) throw new BudgetRefused(why);
      sent++; return debited(input, init);
    }) as typeof fetch;
    let r: Response;
    try { r = await oneShot(TARGET.url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) }); }
    catch (e) { return { requests: sent, stored: false, outcome: `failed (debited if sent): ${(e as Error).message}` }; }
    // Never trust the transport: a response that was itself the result of a followed redirect is refused.
    if (r.redirected || r.type === 'opaqueredirect') return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): the transport followed a redirect (${r.url || 'unknown URL'})` };
    if (r.status >= 300 && r.status < 400) return { requests: sent, stored: false, outcome: `redirect ${r.status} → ${String(r.headers.get('location'))}: not followed (fail closed), nothing stored` };
    if (r.url && r.url !== TARGET.url) return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): final URL ${r.url} differs from the pinned route` };
    if (r.status !== 200) return { requests: sent, stored: false, outcome: `HTTP ${r.status}: nothing stored` };
    let capped: Awaited<ReturnType<typeof readCapped>>;
    try { capped = await readCapped(r, MAX_PDF_BYTES); }
    catch (e) { return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): stream error while reading (${(e as Error).message.slice(0, 120)})` }; }
    if ('over' in capped) return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): body exceeds ${MAX_PDF_BYTES} bytes while reading (stopped at ${capped.over})` };
    const body = capped.body;
    if (Buffer.from(body.subarray(0, 5)).toString('latin1') !== '%PDF-') return { requests: sent, stored: false, outcome: 'refused after capture (debited, not stored): not a PDF (no %PDF- header)' };
    let ex: Awaited<ReturnType<typeof extractPdfLines>>;
    try { ex = await extractPdfLines(body); } catch (e) { return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): unreadable PDF (${(e as Error).message.slice(0, 120)})` }; }
    const ip = pdfIdentityProblem(ex.lines);
    if (ip) return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): ${ip}` };
    mkdirSync(outDir, { recursive: true });
    const digest = sha(body);
    const meta = `${JSON.stringify({ id: base, idAto: TARGET.idAto, idArquivoBinario: TARGET.idArquivoBinario,
      resourceId: `rfb:${TARGET.idAto}:anexo:${TARGET.idArquivoBinario}`, url: TARGET.url, finalUrl: r.url || TARGET.url, contentType: r.headers.get('content-type'),
      sha256: digest, bytes: body.byteLength, pages: ex.pages, pageCoverage: ex.pageCoverage, capturedAt: (opts.now ?? (() => new Date()))().toISOString(),
      grantId: opts.grantId, promoted: false, historicalAttachment: { idArquivoBinario: TARGET.historicalId, note: 'struck earlier version: preserved as history, never requested' },
      origin: 'automated fetch via collect-p2c-attachment (E9 P2-c, pinned route, one shot)' }, null, 2)}\n`;
    // Two-phase commit: both files are written as .partial (exclusive), then the PDF and finally the META (the commit
    // marker) are renamed. Any failure removes what this run created, so no PDF without its matching meta survives.
    const P = (f: string) => join(outDir, f); const pdfF = `${base}.pdf`; const metaF = `${base}.meta.json`;
    const created: string[] = [];
    try {
      writeFileSync(P(`${pdfF}.partial`), body, { flag: 'wx' }); created.push(`${pdfF}.partial`);
      writeFileSync(P(`${metaF}.partial`), meta, { flag: 'wx' }); created.push(`${metaF}.partial`);
      if (existsSync(P(pdfF)) || existsSync(P(metaF))) throw new Error('final file already present');
      renameSync(P(`${pdfF}.partial`), P(pdfF)); created.push(pdfF);
      renameSync(P(`${metaF}.partial`), P(metaF));
    } catch (e) {
      for (const f of created) rmSync(P(f), { force: true });
      return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): write failed, nothing kept (${(e as Error).message.slice(0, 120)})` };
    }
    return { requests: sent, stored: true, outcome: 'stored', sha256: digest, bytes: body.byteLength, pages: ex.pages };
  } finally { budget.close(); }
}

/** CLI: refuses anything but `--stop-after 1` (code 2) before opening the budget. */
export async function cli(argv: string[], doFetch: typeof fetch, deps: { preflight?: () => string | null } = {}): Promise<number> {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const grantId = arg('--grant'); const owner = arg('--owner');
  if (!grantId || !owner || arg('--stop-after') !== '1') {
    console.error('usage: collect-p2c-attachment.ts --grant <grantId> --owner <owner> --stop-after 1  (refused without an active grant)'); return 2;
  }
  const pre = (deps.preflight ?? (() => ledgerPreflight(readFileSync(ATT_BUDGET, 'utf8'), gitPushedLedger(ATT_BUDGET))))();
  if (pre) { console.error(`preflight: ${pre}`); return 3; }
  const out = await runAttachment(doFetch, { grantId, owner, preflight: () => pre });
  console.log(JSON.stringify(out)); return out.stored ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await cli(process.argv.slice(2), fetch));
