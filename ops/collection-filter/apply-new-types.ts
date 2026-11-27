/**
 * Aplicação em lote dos "novos tipos" do filtro de coleta (F3) pelas rotas
 * administrativas existentes. Veja NOVOS-TIPOS-RUNBOOK.md.
 *
 * Uso: npx tsx ops/collection-filter/apply-new-types.ts <plan|phase1|phase2-preview|phase2-confirm> ...
 *
 * Garantias:
 *  - plan / phase2-preview são somente leitura (nenhuma escrita no servidor);
 *  - phase1 NUNCA chama /confirm: só preview + save (não destrutivo);
 *  - phase2-confirm só age sobre o arquivo aprovado (hash conferido) e nunca
 *    apaga mais do que a contagem aprovada para cada tipo;
 *  - nenhum token/senha é impresso ou gravado; o token fica só em memória;
 *  - não toca taxonomia nem usa "reaplicar filtro ao acervo".
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { normalizeCollectionFilterType } from '../../src/modules/collection/collection-filter.engine.js';

// ---------------------------------------------------------------- tipos

export const KEEP_MODES = ['KEEP_ALWAYS', 'KEEP_IF_TAX_TERM'] as const;
export const EXCLUDE_MODE = 'EXCLUDE_UNLESS_STRONG' as const;
export const ALLOWED_MODES: readonly string[] = [...KEEP_MODES, EXCLUDE_MODE];
export const ALLOWED_SOURCES: readonly string[] = ['dou', 'doe-sp'];
export const EXPECTED_HEADER = ['fonte', 'secao', 'tipo', 'ocorrencias', 'modo', 'grupo'];
const API = '/api/v1/admin/collection-filter';
const MAX_CONFIRM_STEPS = 1000;

export interface CsvRow {
  line: number;
  source: string;
  section: string;
  tipo: string;
  occurrences: number;
  mode: string;
  group: string;
  key: string;
}
export interface InvalidRow { line: number; reason: string; raw: string }
export interface LiveItem {
  id: string;
  source_code: string;
  section: string;
  normalized_type: string;
  sample_raw_type: string;
  act_name: string;
  occurrence_count: number;
  requires_review?: boolean;
}
export interface Match { row: CsvRow; item: LiveItem; canonicalType: string }
export interface Divergence { kind: string; source: string; section: string; tipo: string; detail: string }

export interface PreviewResult {
  actName: string; count: number; blockedCompany: number; blockedOtherSource: number;
  samples: Array<{ title?: string }>; token: string; policyRevision: number; confirmationToken: string;
}
export interface ConfirmResult {
  changed: boolean; apagadas?: number; restantes?: number; deletedCount?: number; revision?: number;
}

export interface ApiClient {
  get(pathAndQuery: string): Promise<unknown>;
  post(pathName: string, body: unknown): Promise<unknown>;
}
export interface Ctx {
  client: ApiClient;
  outDir: string;
  csvPath: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  inventoryRetries: number;
  inventoryDelayMs: number;
  allowDivergences: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ------------------------------------------------------------------ CSV

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Parser mínimo de CSV com ';' e aspas duplas. Aceita BOM, CRLF/LF. */
export function parseCsvText(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let touched = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; touched = true; }
    else if (c === ';') { row.push(field); field = ''; touched = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      if (touched || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; touched = false;
    } else { field += c; touched = true; }
  }
  if (touched || field !== '') { row.push(field); rows.push(row); }
  return rows;
}

export function matchKey(source: string, section: string, type: string): string {
  // Igual ao inventário do servidor: nome que normaliza para vazio vira este rótulo.
  return JSON.stringify([source.trim(), section.trim(), normalizeCollectionFilterType(type) || 'NOME NAO IDENTIFICADO']);
}

export function parseSheet(text: string): { rows: CsvRow[]; invalid: InvalidRow[] } {
  const table = parseCsvText(text);
  const header = (table[0] ?? []).map((h) => h.trim());
  if (EXPECTED_HEADER.some((h, i) => header[i] !== h) || header.length !== EXPECTED_HEADER.length) {
    throw new Error('csv_header_invalid: esperado ' + EXPECTED_HEADER.join(';'));
  }
  const rows: CsvRow[] = [];
  const invalid: InvalidRow[] = [];
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const raw = cells.join(';');
    if (cells.length !== EXPECTED_HEADER.length) {
      invalid.push({ line, reason: 'colunas=' + cells.length, raw }); return;
    }
    const [source, section, tipo, occ, mode, group] = cells.map((c) => c.trim()) as [string, string, string, string, string, string];
    if (!ALLOWED_SOURCES.includes(source)) { invalid.push({ line, reason: 'fonte_invalida:' + source, raw }); return; }
    if (!ALLOWED_MODES.includes(mode)) { invalid.push({ line, reason: 'modo_invalido:' + mode, raw }); return; }
    if (!tipo) { invalid.push({ line, reason: 'tipo_vazio', raw }); return; }
    if (!/^\d+$/.test(occ)) { invalid.push({ line, reason: 'ocorrencias_invalidas:' + occ, raw }); return; }
    const key = matchKey(source, section, tipo);
    rows.push({ line, source, section, tipo, occurrences: Number(occ), mode, group, key });
  });
  return { rows, invalid };
}

/** Duplicatas por chave normalizada: mesmo modo = mantém a primeira; modos em conflito = exclui todas. */
export function dedupeRows(rows: CsvRow[]): { effective: CsvRow[]; duplicates: Divergence[] } {
  const byKey = new Map<string, CsvRow[]>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const effective: CsvRow[] = [];
  const duplicates: Divergence[] = [];
  for (const group of byKey.values()) {
    const first = group[0]!;
    if (group.length === 1) { effective.push(first); continue; }
    const modes = new Set(group.map((g) => g.mode));
    const lines = group.map((g) => g.line).join(',');
    if (modes.size === 1) {
      effective.push(first);
      duplicates.push({ kind: 'DUPLICATE_KEY', source: first.source, section: first.section, tipo: first.tipo,
        detail: `linhas ${lines}; mesmo modo ${first.mode}; usada a primeira` });
    } else {
      duplicates.push({ kind: 'DUPLICATE_KEY_CONFLICT', source: first.source, section: first.section, tipo: first.tipo,
        detail: `linhas ${lines}; modos em conflito ${[...modes].join('/')}; todas excluídas` });
    }
  }
  return { effective: effective.sort((a, b) => a.line - b.line), duplicates };
}

export function liveKey(item: LiveItem): string {
  const normalized = item.normalized_type || normalizeCollectionFilterType(item.act_name || item.sample_raw_type) || 'NOME NAO IDENTIFICADO';
  return JSON.stringify([item.source_code, (item.section ?? '').trim(), normalized]);
}

export function matchRows(effective: CsvRow[], items: LiveItem[]) {
  const live = new Map(items.map((i) => [liveKey(i), i]));
  const matched: Match[] = [];
  const unmatched: CsvRow[] = [];
  for (const row of effective) {
    const item = live.get(row.key);
    const canonicalType = item ? (item.act_name || item.sample_raw_type) : '';
    if (item && canonicalType) matched.push({ row, item, canonicalType });
    else unmatched.push(row);
  }
  return { matched, unmatched, live };
}

// ----------------------------------------------------------------- HTTP

export function assertBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('base_url_invalida'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && local) return url.origin;
  throw new Error('base_url_deve_ser_https (http so para localhost/127.0.0.1)');
}

export interface Credentials { email: string; password: string }

export function createApiClient(opts: {
  baseUrl: string;
  credentials: () => Promise<Credentials>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ApiClient {
  const base = assertBaseUrl(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  let token: string | null = null; // somente em memória

  const raw = async (method: string, p: string, body: unknown, auth: boolean) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token) headers.authorization = 'Bearer ' + token;
    const res = await doFetch(base + p, {
      method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  };
  const login = async () => {
    const { email, password } = await opts.credentials();
    const r = await raw('POST', '/auth/login', { email, password }, false);
    const t = (r.json as { accessToken?: unknown } | null)?.accessToken;
    if (r.status !== 200 || typeof t !== 'string') throw new ApiError(r.status, null, `login_falhou (HTTP ${r.status})`);
    token = t;
  };
  const call = async (method: string, p: string, body?: unknown) => {
    if (!token) await login();
    let r = await raw(method, p, body, true);
    if (r.status === 401) { token = null; await login(); r = await raw(method, p, body, true); }
    if (r.status < 200 || r.status >= 300) {
      const code = (r.json as { error?: unknown } | null)?.error;
      throw new ApiError(r.status, r.json, `HTTP ${r.status} em ${method} ${p.split('?')[0]}${typeof code === 'string' ? ' (' + code + ')' : ''}`);
    }
    return r.json;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

// ------------------------------------------------------------- servidor

export async function fetchReadyInventory(ctx: Ctx): Promise<{ items: LiveItem[]; inventory: { status: string; key: unknown } }> {
  let last = 'sem resposta';
  for (let attempt = 1; attempt <= ctx.inventoryRetries; attempt++) {
    const res = (await ctx.client.get(`${API}/new-types?status=OPEN`)) as
      { inventory?: { status?: string; key?: unknown }; items?: LiveItem[] };
    const status = res.inventory?.status ?? 'DESCONHECIDO';
    if (status === 'READY') {
      ctx.log(`inventário READY: ${res.items?.length ?? 0} tipos abertos`);
      return { items: res.items ?? [], inventory: { status, key: res.inventory?.key ?? null } };
    }
    last = status;
    if (attempt % 5 === 1) ctx.log(`inventário ${status}; aguardando (${attempt}/${ctx.inventoryRetries})`);
    await ctx.sleep(ctx.inventoryDelayMs);
  }
  throw new Error(`inventario_nao_ficou_pronto (ultimo status ${last}); nenhum dado foi alterado`);
}

function ruleBody(m: { row: { source: string; section: string; mode: string }; canonicalType: string }) {
  // Espelha a UI para itens ARCHIVE_ACT_NAME: canonicalType = nome do ato, sem newTypeId.
  return { sourceCode: m.row.source, section: m.row.section, canonicalType: m.canonicalType, mode: m.row.mode };
}
async function preview(ctx: Ctx, m: Parameters<typeof ruleBody>[0]): Promise<PreviewResult> {
  return (await ctx.client.post(`${API}/direct-rule/preview`, ruleBody(m))) as PreviewResult;
}
function previewProof(p: PreviewResult) {
  return { expectedCount: p.count, previewToken: p.token, confirmationToken: p.confirmationToken, policyRevision: p.policyRevision };
}

// ----------------------------------------------------------------- arquivos

async function writeAtomic(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}
async function readJsonIfExists<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
const toCsv = (header: string[], rows: unknown[][]) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

async function loadSheet(ctx: Ctx) {
  const bytes = await readFile(ctx.csvPath);
  const sheet = parseSheet(bytes.toString('utf8'));
  const { effective, duplicates } = dedupeRows(sheet.rows);
  return { csvSha256: sha256Hex(bytes), ...sheet, effective, duplicates };
}

// -------------------------------------------------------------------- plan

export async function runPlan(ctx: Ctx) {
  const sheet = await loadSheet(ctx);
  const { items, inventory } = await fetchReadyInventory(ctx);
  const { matched, unmatched, live } = matchRows(sheet.effective, items);
  const csvKeys = new Set(sheet.rows.map((r) => r.key));
  const divergences: Divergence[] = [];
  for (const i of sheet.invalid) divergences.push({ kind: 'INVALID_ROW', source: '', section: '', tipo: '', detail: `linha ${i.line}: ${i.reason}` });
  divergences.push(...sheet.duplicates);
  for (const r of unmatched) divergences.push({ kind: 'CSV_WITHOUT_LIVE_ITEM', source: r.source, section: r.section, tipo: r.tipo, detail: `linha ${r.line}; modo ${r.mode}` });
  for (const [k, item] of live) if (!csvKeys.has(k)) divergences.push({ kind: 'LIVE_NOT_IN_CSV', source: item.source_code, section: item.section, tipo: item.act_name || item.sample_raw_type, detail: `ocorrencias ${item.occurrence_count}` });
  for (const m of matched) if (Number(m.item.occurrence_count) !== m.row.occurrences) divergences.push({ kind: 'COUNT_DIFFERENCE', source: m.row.source, section: m.row.section, tipo: m.row.tipo, detail: `csv ${m.row.occurrences} vs vivo ${m.item.occurrence_count}` });

  const blocking = sheet.invalid.length + unmatched.length + sheet.duplicates.filter((d) => d.kind === 'DUPLICATE_KEY_CONFLICT').length;
  const plan = {
    version: 1, generatedAt: ctx.now().toISOString(), csvSha256: sheet.csvSha256, inventory,
    totals: {
      csvRows: sheet.rows.length + sheet.invalid.length, validRows: sheet.rows.length, invalidRows: sheet.invalid.length,
      effectiveRows: sheet.effective.length, matched: matched.length, unmatchedCsv: unmatched.length,
      liveNotInCsv: divergences.filter((d) => d.kind === 'LIVE_NOT_IN_CSV').length,
      countDifferences: divergences.filter((d) => d.kind === 'COUNT_DIFFERENCE').length,
      duplicates: sheet.duplicates.length, blocking,
      byMode: Object.fromEntries(ALLOWED_MODES.map((m) => [m, matched.filter((x) => x.row.mode === m).length])),
    },
    matches: matched.map((m) => ({ key: m.row.key, line: m.row.line, source: m.row.source, section: m.row.section, mode: m.row.mode,
      canonicalType: m.canonicalType, liveItemId: m.item.id, csvOccurrences: m.row.occurrences, liveOccurrences: m.item.occurrence_count })),
    divergences,
  };
  await writeAtomic(path.join(ctx.outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await writeAtomic(path.join(ctx.outDir, 'divergences.csv'),
    toCsv(['tipo_divergencia', 'fonte', 'secao', 'tipo', 'detalhe'], divergences.map((d) => [d.kind, d.source, d.section, d.tipo, d.detail])));
  const md = ['# Divergências — plano de novos tipos', '', `Gerado em ${plan.generatedAt}. Combinados: ${matched.length}/${sheet.effective.length}.`, ''];
  for (const kind of ['INVALID_ROW', 'CSV_WITHOUT_LIVE_ITEM', 'DUPLICATE_KEY_CONFLICT', 'DUPLICATE_KEY', 'LIVE_NOT_IN_CSV', 'COUNT_DIFFERENCE']) {
    const list = divergences.filter((d) => d.kind === kind);
    md.push(`## ${kind} (${list.length})`, '', ...(list.length ? list.map((d) => `- ${d.source} / ${d.section} / ${d.tipo} — ${d.detail}`) : ['Nenhuma.']), '');
  }
  await writeAtomic(path.join(ctx.outDir, 'divergences.md'), md.join('\n'));
  ctx.log(`plan: ${matched.length} combinados, ${unmatched.length} sem item vivo, ${sheet.invalid.length} inválidas, ${plan.totals.liveNotInCsv} vivos fora da planilha, ${plan.totals.countDifferences} diferenças de contagem`);
  const exitCode = blocking > 0 && !ctx.allowDivergences ? 2 : 0;
  if (exitCode) ctx.log('plan: divergências bloqueantes; revise divergences.md (ou use --allow-divergences)');
  return { plan, exitCode };
}

// ------------------------------------------------------------------ phase1

interface Phase1Record {
  key: string; source: string; section: string; canonicalType: string; mode: string;
  previewCount: number; blockedCompany: number; blockedOtherSource: number;
  revision: number | null; result: 'SAVED'; savedAt: string;
}
interface Phase1State { version: 1; saved: Record<string, Phase1Record> }

export async function runPhase1(ctx: Ctx, opts: { dryRun: boolean }) {
  const sheet = await loadSheet(ctx);
  const statePath = path.join(ctx.outDir, 'phase1.state.json');
  const state: Phase1State = (await readJsonIfExists<Phase1State>(statePath)) ?? { version: 1, saved: {} };
  const { items } = await fetchReadyInventory(ctx);
  const { matched, unmatched } = matchRows(sheet.effective, items);
  const keepMatched = matched.filter((m) => (KEEP_MODES as readonly string[]).includes(m.row.mode));
  const keepUnmatched = unmatched.filter((r) => (KEEP_MODES as readonly string[]).includes(r.mode) && !state.saved[r.key]);
  const dry: Array<Record<string, unknown>> = [];
  let saved = 0, skipped = 0, failed: string | null = null;
  for (const m of keepMatched) {
    if (state.saved[m.row.key]) { skipped++; ctx.log(`[skip] ${m.row.source}/${m.canonicalType} já salvo`); continue; }
    const t0 = Date.now();
    try {
      const p = await preview(ctx, m);
      if (opts.dryRun) {
        dry.push({ source: m.row.source, section: m.row.section, canonicalType: m.canonicalType, mode: m.row.mode,
          previewCount: p.count, blockedCompany: p.blockedCompany, blockedOtherSource: p.blockedOtherSource });
        ctx.log(`[dry-run] ${m.row.source}/${m.canonicalType} ${m.row.mode} preview count=${p.count} (informativo) ${Date.now() - t0}ms`);
        continue;
      }
      const res = (await ctx.client.post(`${API}/direct-rule/save`, { ...ruleBody(m), ...previewProof(p) })) as { revision?: number };
      state.saved[m.row.key] = { key: m.row.key, source: m.row.source, section: m.row.section, canonicalType: m.canonicalType, mode: m.row.mode,
        previewCount: p.count, blockedCompany: p.blockedCompany, blockedOtherSource: p.blockedOtherSource,
        revision: typeof res.revision === 'number' ? res.revision : null, result: 'SAVED', savedAt: ctx.now().toISOString() };
      await writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n');
      saved++;
      ctx.log(`[saved] ${m.row.source}/${m.canonicalType} ${m.row.mode} rev=${res.revision} preview=${p.count} ${Date.now() - t0}ms`);
    } catch (e) {
      failed = `${m.row.source}/${m.canonicalType}: ${(e as Error).message}`;
      ctx.log(`[ERRO] ${failed} — interrompido; nada além disso foi enviado`);
      break;
    }
  }
  if (opts.dryRun) await writeAtomic(path.join(ctx.outDir, 'phase1-dry-run.json'), JSON.stringify({ generatedAt: ctx.now().toISOString(), items: dry }, null, 2) + '\n');
  else {
    const records = Object.values(state.saved);
    await writeAtomic(path.join(ctx.outDir, 'phase1-report.csv'), toCsv(
      ['fonte', 'secao', 'tipo', 'modo', 'preview_count_informativo', 'blockedCompany', 'blockedOtherSource', 'revisao', 'resultado'],
      records.map((r) => [r.source, r.section, r.canonicalType, r.mode, r.previewCount, r.blockedCompany, r.blockedOtherSource, r.revision, r.result])));
  }
  ctx.log(`phase1 resumo: salvos=${saved} ja_salvos=${skipped} sem_item_vivo=${keepUnmatched.length} erro=${failed ? 'sim' : 'nao'} dry_run=${opts.dryRun} (nenhuma chamada a /confirm)`);
  let exitCode = 0;
  if (failed) exitCode = 1;
  else if (keepUnmatched.length && !ctx.allowDivergences) { exitCode = 2; ctx.log('phase1: há linhas KEEP sem item vivo; rode plan e revise (ou --allow-divergences)'); }
  return { saved, skipped, unmatched: keepUnmatched.length, failed, dry, exitCode };
}

// ----------------------------------------------------------- phase2-preview

export interface Phase2Item {
  key: string; sourceCode: string; section: string; canonicalType: string; mode: string;
  csvOccurrences: number; liveOccurrences: number; count: number; blockedCompany: number;
  blockedOtherSource: number; sampleTitles: string[]; policyRevision: number;
}
export interface Phase2Approval {
  version: 1; generatedAt: string; csvSha256: string; items: Phase2Item[];
  totals: { types: number; typesWithDeletions: number; totalToDelete: number; totalBlockedCompany: number; totalBlockedOtherSource: number };
  unmatchedCsv: Array<{ line: number; source: string; section: string; tipo: string }>;
}
export const approvalCode = (bytes: string | Uint8Array) => sha256Hex(bytes).slice(0, 12);

export async function runPhase2Preview(ctx: Ctx) {
  const sheet = await loadSheet(ctx);
  const { items } = await fetchReadyInventory(ctx);
  const { matched, unmatched } = matchRows(sheet.effective, items);
  const excl = matched.filter((m) => m.row.mode === EXCLUDE_MODE);
  const exclUnmatched = unmatched.filter((r) => r.mode === EXCLUDE_MODE);
  const out: Phase2Item[] = [];
  for (const m of excl) {
    const t0 = Date.now();
    const p = await preview(ctx, m); // erro HTTP interrompe (propaga)
    out.push({ key: m.row.key, sourceCode: m.row.source, section: m.row.section, canonicalType: m.canonicalType, mode: m.row.mode,
      csvOccurrences: m.row.occurrences, liveOccurrences: Number(m.item.occurrence_count), count: p.count,
      blockedCompany: p.blockedCompany, blockedOtherSource: p.blockedOtherSource,
      sampleTitles: (p.samples ?? []).slice(0, 3).map((s) => String(s.title ?? '')), policyRevision: p.policyRevision });
    ctx.log(`[preview] ${m.row.source}/${m.canonicalType} apagaria=${p.count} protegidas(emp=${p.blockedCompany},outra_fonte=${p.blockedOtherSource}) ${Date.now() - t0}ms`);
  }
  const approval: Phase2Approval = {
    version: 1, generatedAt: ctx.now().toISOString(), csvSha256: sheet.csvSha256, items: out,
    totals: {
      types: out.length, typesWithDeletions: out.filter((i) => i.count > 0).length,
      totalToDelete: out.reduce((a, i) => a + i.count, 0),
      totalBlockedCompany: out.reduce((a, i) => a + i.blockedCompany, 0),
      totalBlockedOtherSource: out.reduce((a, i) => a + i.blockedOtherSource, 0),
    },
    unmatchedCsv: exclUnmatched.map((r) => ({ line: r.line, source: r.source, section: r.section, tipo: r.tipo })),
  };
  const body = JSON.stringify(approval, null, 2) + '\n';
  const code = approvalCode(body);
  await writeAtomic(path.join(ctx.outDir, 'phase2-preview.json'), body);
  await writeAtomic(path.join(ctx.outDir, 'phase2-preview.csv'), toCsv(
    ['fonte', 'secao', 'tipo', 'modo', 'apagaria', 'blockedCompany', 'blockedOtherSource', 'exemplos'],
    out.map((i) => [i.sourceCode, i.section, i.canonicalType, i.mode, i.count, i.blockedCompany, i.blockedOtherSource, i.sampleTitles.join(' | ')])));
  const t = approval.totals;
  const md = [
    '# Pré-visualização da fase 2 (somente leitura)', '',
    `Código de aprovação: \`${code}\` (sha256 de phase2-preview.json, primeiros 12 hex)`, '',
    `- Tipos: ${t.types}; com exclusões: ${t.typesWithDeletions}`,
    `- Total a apagar: ${t.totalToDelete}`,
    `- Protegidas mantidas: empresa=${t.totalBlockedCompany}, outra fonte=${t.totalBlockedOtherSource}`,
    `- Linhas EXCLUDE sem item vivo: ${approval.unmatchedCsv.length}`, '',
    '| Fonte | Seção | Tipo | Apagaria | blockedCompany | blockedOtherSource | Exemplos |', '|---|---|---|---:|---:|---:|---|',
    ...out.map((i) => `| ${i.sourceCode} | ${i.section} | ${i.canonicalType.replaceAll('|', '\\|')} | ${i.count} | ${i.blockedCompany} | ${i.blockedOtherSource} | ${i.sampleTitles.join(' / ').replaceAll('|', '\\|')} |`), '',
  ].join('\n');
  await writeAtomic(path.join(ctx.outDir, 'phase2-preview.md'), md);
  ctx.log(`phase2-preview: tipos=${t.types} apagaria=${t.totalToDelete} protegidas empresa=${t.totalBlockedCompany} outra_fonte=${t.totalBlockedOtherSource} sem_item_vivo=${approval.unmatchedCsv.length}`);
  ctx.log(`CÓDIGO DE APROVAÇÃO: ${code}`);
  ctx.log('PARE: aprovação do Fábio necessária');
  return { approval, code, exitCode: exclUnmatched.length && !ctx.allowDivergences ? 2 : 0 };
}

// ----------------------------------------------------------- phase2-confirm

interface Phase2TypeState {
  status: 'IN_PROGRESS' | 'DONE' | 'SKIPPED_EXCEEDS_APPROVED' | 'STOPPED';
  steps: number; deletedTotal: number; approvedCount: number; detail?: string;
}
interface Phase2State { version: 1; approvalCode: string; types: Record<string, Phase2TypeState> }

export async function runPhase2Confirm(ctx: Ctx, opts: { approvedPath: string; approvalCode: string }) {
  const bytes = await readFile(opts.approvedPath);
  const actual = approvalCode(bytes);
  if (opts.approvalCode.trim().toLowerCase() !== actual) {
    throw new Error('codigo_de_aprovacao_invalido: nao confere com o arquivo; nada foi alterado');
  }
  const approval = JSON.parse(bytes.toString('utf8')) as Phase2Approval;
  if (approval.version !== 1 || !Array.isArray(approval.items)) throw new Error('arquivo_de_aprovacao_invalido');
  for (const i of approval.items) {
    if (i.mode !== EXCLUDE_MODE || !ALLOWED_SOURCES.includes(i.sourceCode) || !Number.isInteger(i.count) || i.count < 0 || !i.canonicalType) {
      throw new Error('arquivo_de_aprovacao_invalido: item fora do escopo EXCLUDE_UNLESS_STRONG');
    }
  }
  if (ctx.csvPath && existsSync(ctx.csvPath)) {
    const csvSha = sha256Hex(await readFile(ctx.csvPath));
    if (csvSha !== approval.csvSha256) throw new Error('csv_diferente_do_usado_no_preview; nada foi alterado');
  }
  const statePath = path.join(ctx.outDir, 'phase2.state.json');
  const state: Phase2State = (await readJsonIfExists<Phase2State>(statePath)) ?? { version: 1, approvalCode: actual, types: {} };
  if (state.approvalCode !== actual) throw new Error('phase2.state.json pertence a outra aprovacao; use outro --out');
  const persist = () => writeAtomic(statePath, JSON.stringify(state, null, 2) + '\n');

  let done = 0, alreadyDone = 0, problems = 0, deleted = 0;
  for (const item of approval.items) {
    const prior = state.types[item.key];
    if (prior?.status === 'DONE') { alreadyDone++; deleted += prior.deletedTotal; ctx.log(`[skip] ${item.sourceCode}/${item.canonicalType} já concluído`); continue; }
    const t0 = Date.now();
    const rule = { row: { source: item.sourceCode, section: item.section, mode: item.mode }, canonicalType: item.canonicalType };
    // Reexecução retoma de onde parou: passos e total apagado são preservados,
    // então o teto aprovado vale para o acumulado de todas as execuções.
    const st: Phase2TypeState = prior ?? { status: 'IN_PROGRESS', steps: 0, deletedTotal: 0, approvedCount: item.count };
    st.status = 'IN_PROGRESS'; delete st.detail;
    state.types[item.key] = st;
    const stop = async (status: Phase2TypeState['status'], detail: string) => {
      st.status = status; st.detail = detail; problems++; await persist();
      ctx.log(`[${status}] ${item.sourceCode}/${item.canonicalType}: ${detail}`);
    };
    for (;;) {
      const fresh = await preview(ctx, rule); // erro HTTP propaga e interrompe tudo
      const allowed = item.count - st.deletedTotal;
      if (fresh.count > allowed) {
        await stop(st.steps === 0 ? 'SKIPPED_EXCEEDS_APPROVED' : 'STOPPED', `contagem atual ${fresh.count} > aprovada restante ${allowed}; nada além do aprovado será apagado`);
        break;
      }
      if (fresh.count === 0) {
        // Nada a apagar: persiste a regra por save (não destrutivo) se ainda não persistida.
        if (st.steps === 0) await ctx.client.post(`${API}/direct-rule/save`, { ...ruleBody(rule), ...previewProof(fresh) });
        st.status = 'DONE'; await persist(); done++; deleted += st.deletedTotal;
        ctx.log(`[DONE] ${item.sourceCode}/${item.canonicalType} apagadas=${st.deletedTotal} ${Date.now() - t0}ms`);
        break;
      }
      const res = (await ctx.client.post(`${API}/direct-rule/confirm`, { ...ruleBody(rule), ...previewProof(fresh), ...(st.steps > 0 ? { resume: true } : {}) })) as ConfirmResult;
      if (res.changed) { await stop('STOPPED', 'contagem/token mudou durante a confirmação; nada apagado neste passo'); break; }
      const step = Number(res.deletedCount ?? res.apagadas ?? 0);
      st.steps++; st.deletedTotal += step; await persist();
      ctx.log(`  passo ${st.steps}: apagadas=${step} restantes=${res.restantes}`);
      if (res.restantes === 0) { st.status = 'DONE'; await persist(); done++; deleted += st.deletedTotal; ctx.log(`[DONE] ${item.sourceCode}/${item.canonicalType} apagadas=${st.deletedTotal} ${Date.now() - t0}ms`); break; }
      if (step === 0) { await stop('STOPPED', 'progresso zero; parado sem nova tentativa automática'); break; }
      if (st.steps >= MAX_CONFIRM_STEPS) { await stop('STOPPED', 'limite de passos'); break; }
    }
  }
  ctx.log(`phase2-confirm resumo: concluidos=${done} ja_concluidos=${alreadyDone} com_problema=${problems} total_apagadas=${deleted}`);
  return { done, alreadyDone, problems, deleted, exitCode: problems ? 1 : 0 };
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error('argumento inesperado: ' + a);
    const name = a.slice(2);
    if (['dry-run', 'allow-divergences'].includes(name)) { flags.set(name, true); continue; }
    const v = rest[++i];
    if (v === undefined) throw new Error('falta valor para --' + name);
    flags.set(name, v);
  }
  return { cmd, flags };
}

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('senha: defina ADMIN_PASSWORD ou execute em terminal interativo');
  process.stdout.write(question);
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\u0003') { cleanup(); reject(new Error('cancelado')); return; }
        if (c === '\r' || c === '\n') { cleanup(); process.stdout.write('\n'); resolve(buf); return; }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); };
    stdin.on('data', onData);
  });
}

export async function readCredentials(): Promise<Credentials> {
  let email = process.env.ADMIN_EMAIL?.trim();
  if (!email) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { email = (await rl.question('E-mail do administrador: ')).trim(); } finally { rl.close(); }
  }
  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Senha (oculta): '));
  if (!email || !password) throw new Error('credenciais ausentes');
  return { email, password };
}

const USAGE = `Uso: npx tsx ops/collection-filter/apply-new-types.ts <comando> --base-url <url> --csv <arquivo> --out <dir>
  plan [--allow-divergences]
  phase1 [--dry-run] [--allow-divergences]
  phase2-preview [--allow-divergences]
  phase2-confirm --approved <phase2-preview.json> --approval-code <12 hex>
Credenciais: ADMIN_EMAIL / ADMIN_PASSWORD (ou prompt; senha oculta).`;

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  if (!cmd || cmd === '--help' || cmd === 'help') { console.log(USAGE); return cmd ? 0 : 1; }
  const need = (n: string) => { const v = flags.get(n); if (typeof v !== 'string') throw new Error(`falta --${n}\n${USAGE}`); return v; };
  const ctx: Ctx = {
    client: createApiClient({ baseUrl: need('base-url'), credentials: readCredentials }),
    outDir: path.resolve(need('out')), csvPath: path.resolve(need('csv')),
    log: (l) => console.log(`${new Date().toISOString()} ${l}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(),
    inventoryRetries: Number(flags.get('inventory-retries') ?? 180), inventoryDelayMs: Number(flags.get('inventory-delay-ms') ?? 2000),
    allowDivergences: flags.get('allow-divergences') === true,
  };
  switch (cmd) {
    case 'plan': return (await runPlan(ctx)).exitCode;
    case 'phase1': return (await runPhase1(ctx, { dryRun: flags.get('dry-run') === true })).exitCode;
    case 'phase2-preview': return (await runPhase2Preview(ctx)).exitCode;
    case 'phase2-confirm':
      return (await runPhase2Confirm(ctx, { approvedPath: path.resolve(need('approved')), approvalCode: need('approval-code') })).exitCode;
    default: console.error(USAGE); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: Error) => {
    console.error('ERRO: ' + e.message); process.exitCode = 1;
  });
}
