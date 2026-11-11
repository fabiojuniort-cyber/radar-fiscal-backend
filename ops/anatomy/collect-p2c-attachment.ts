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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The PDF must name the act in its text layer. */
export function pdfIdentityProblem(lines: { text: string }[]): string | null {
  const t = lines.map((l) => l.text).join('\n').normalize('NFC');
  const miss = [[/SOLU[ÇC][ÃA]O\s+DE\s+CONSULTA/iu, 'SOLUÇÃO DE CONSULTA'], [/\bCOSIT\b/iu, 'COSIT'], [/\b258\b/u, 'nº 258']]
    .filter(([re]) => !(re as RegExp).test(t)).map(([, w]) => w);
  return miss.length ? `the PDF text does not name the act (${miss.join(', ')} not found)` : null;
}

export interface AttachmentRun { requests: number; stored: boolean; outcome: string; sha256?: string; bytes?: number; pages?: number }

export async function runAttachment(doFetch: typeof fetch, opts: { grantId: string; owner: string; budgetFile?: string; outDir?: string; actJson?: Buffer; now?: () => Date }): Promise<AttachmentRun> {
  const outDir = opts.outDir ?? ATT_DIR;
  const base = `${TARGET.idAto}-${TARGET.idArquivoBinario}`;
  // Offline screening: nothing below sends a request.
  const act = opts.actJson ?? readFileSync(TARGET.actJson);
  const tp = targetProblem(act); if (tp) return { requests: 0, stored: false, outcome: `refused before request: ${tp}` };
  const rp = routeProblem(TARGET.url); if (rp) return { requests: 0, stored: false, outcome: `refused before request: ${rp}` };
  if (existsSync(join(outDir, `${base}.pdf`))) return { requests: 0, stored: false, outcome: 'refused before request: already stored (bytes kept by an earlier run)' };
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
    try { r = await oneShot(TARGET.url, { signal: AbortSignal.timeout(60_000) }); }
    catch (e) { return { requests: sent, stored: false, outcome: `failed (debited if sent): ${(e as Error).message}` }; }
    if (r.status >= 300 && r.status < 400) return { requests: sent, stored: false, outcome: `redirect ${r.status} → ${String(r.headers.get('location'))}: not followed (fail closed), nothing stored` };
    if (r.status !== 200) return { requests: sent, stored: false, outcome: `HTTP ${r.status}: nothing stored` };
    const body = new Uint8Array(await r.arrayBuffer());
    if (body.byteLength > MAX_PDF_BYTES) return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): ${body.byteLength} bytes > ${MAX_PDF_BYTES}` };
    if (Buffer.from(body.subarray(0, 5)).toString('latin1') !== '%PDF-') return { requests: sent, stored: false, outcome: 'refused after capture (debited, not stored): not a PDF (no %PDF- header)' };
    let ex: Awaited<ReturnType<typeof extractPdfLines>>;
    try { ex = await extractPdfLines(body); } catch (e) { return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): unreadable PDF (${(e as Error).message.slice(0, 120)})` }; }
    const ip = pdfIdentityProblem(ex.lines);
    if (ip) return { requests: sent, stored: false, outcome: `refused after capture (debited, not stored): ${ip}` };
    mkdirSync(outDir, { recursive: true });
    const digest = sha(body);
    writeFileSync(join(outDir, `${base}.pdf`), body, { flag: 'wx' });
    writeFileSync(join(outDir, `${base}.meta.json`), `${JSON.stringify({ id: base, idAto: TARGET.idAto, idArquivoBinario: TARGET.idArquivoBinario,
      resourceId: `rfb:${TARGET.idAto}:anexo:${TARGET.idArquivoBinario}`, url: TARGET.url, finalUrl: r.url || TARGET.url, contentType: r.headers.get('content-type'),
      sha256: digest, bytes: body.byteLength, pages: ex.pages, pageCoverage: ex.pageCoverage, capturedAt: (opts.now ?? (() => new Date()))().toISOString(),
      grantId: opts.grantId, promoted: false, historicalAttachment: { idArquivoBinario: TARGET.historicalId, note: 'struck earlier version: preserved as history, never requested' },
      origin: 'automated fetch via collect-p2c-attachment (E9 P2-c, pinned route, one shot)' }, null, 2)}\n`, { flag: 'wx' });
    return { requests: sent, stored: true, outcome: 'stored', sha256: digest, bytes: body.byteLength, pages: ex.pages };
  } finally { budget.close(); }
}

/** CLI: refuses anything but `--stop-after 1` (code 2) before opening the budget. */
export async function cli(argv: string[], doFetch: typeof fetch): Promise<number> {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const grantId = arg('--grant'); const owner = arg('--owner');
  if (!grantId || !owner || arg('--stop-after') !== '1') {
    console.error('usage: collect-p2c-attachment.ts --grant <grantId> --owner <owner> --stop-after 1  (refused without an active grant)'); return 2;
  }
  const out = await runAttachment(doFetch, { grantId, owner });
  console.log(JSON.stringify(out)); return out.stored ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await cli(process.argv.slice(2), fetch));
